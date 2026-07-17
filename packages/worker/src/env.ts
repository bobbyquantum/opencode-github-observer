export interface Env {
  WEBSOCKET_HUB: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_WEBHOOK_SECRET?: string;
  // When "true", the WebSocket hub accepts any auth token as a dev user so the
  // e2e flow can be exercised without real GitHub credentials. Never enable in prod.
  DEV_MODE?: string;
}
