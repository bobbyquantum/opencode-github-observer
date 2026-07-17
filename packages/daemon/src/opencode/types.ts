// Minimal subset of OpenCode server types (derived from the official SDK
// types.gen.ts). Only the fields the daemon actually consumes are included.

export type FileDiff = {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
};

export type Session = {
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  share?: { url: string };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
    diffs?: Array<FileDiff>;
  };
  time: {
    created: number;
    updated: number;
    compacting?: number;
  };
};

export type SessionStatus =
  | { type: "idle" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "busy" };

export type VcsInfo = {
  branch: string | null;
  default_branch?: string | null;
};

export type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
};

export type ToolStateCompleted = {
  status: "completed";
  input: { [key: string]: unknown };
  output: string;
  title: string;
  metadata: { [key: string]: unknown };
  time: { start: number; end: number };
};

export type ToolStateRunning = {
  status: "running";
  input: { [key: string]: unknown };
  title?: string;
  metadata?: { [key: string]: unknown };
  time: { start: number };
};

export type ToolState = ToolStateCompleted | ToolStateRunning;

export type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
};

export type Part = TextPart | ToolPart | { type: string; [key: string]: unknown };

export type MessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
};

export type Message = { info: MessageInfo; parts: Array<Part> };

export type Event = {
  type: string;
  properties: {
    sessionID?: string;
    branch?: string;
    info?: Session;
    part?: Part;
    [key: string]: unknown;
  };
};

export type TextPartInput = {
  type: "text";
  text: string;
};

export type PromptBody = {
  parts: Array<TextPartInput>;
  noReply?: boolean;
};
