// Minimal Server-Sent Events parser. Reads a fetch Response body stream,
// buffers chunks, splits on blank lines into events, and yields the `data:`
// payload (concatenated when multiple data lines form one event).

export type SSEEvent = { data: string; event?: string };

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => {
    try {
      reader.cancel().catch(() => {});
    } catch {}
  };
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      // Events are separated by a blank line. Handle \n\n and \r\n\r\n.
      while ((sep = findBlankLine(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        // Skip past the separator (2 or 4 chars).
        const sepLen = buffer.slice(sep, sep + 2) === "\r\n" ? 4 : 2;
        buffer = buffer.slice(sep + sepLen);

        const evt = parseEventBlock(rawEvent);
        if (evt) yield evt;
      }
    }
    if (buffer.trim() !== "") {
      const evt = parseEventBlock(buffer);
      if (evt) yield evt;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {}
  }
}

function findBlankLine(s: string): number {
  const lf = s.indexOf("\n\n");
  const crlf = s.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function parseEventBlock(block: string): SSEEvent | null {
  const lines = block.split(/\r?\n/);
  let data: string[] = [];
  let event: string | undefined;
  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("event:")) {
      event = line.slice(6).replace(/^ /, "");
    }
  }
  if (data.length === 0) return null;
  return { data: data.join("\n"), event };
}
