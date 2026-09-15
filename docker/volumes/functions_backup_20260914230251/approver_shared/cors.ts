// Shared CORS handling for browser-facing approver_ Edge Functions.
//
// Angular calls these functions directly from the browser (see CLAUDE.md —
// Angular never calls Buffer/n8n/Paperclip/MCP, but it does call Edge
// Functions), so every function needs to answer the preflight `OPTIONS`
// request and echo these headers on its real response.
//
// The allowed origin is `*` for now — this project has no browser session
// cookie to protect (auth is a bearer JWT in the Authorization header, not a
// cookie), so a wildcard origin does not expose a CSRF-style risk the way it
// would for cookie-authenticated APIs. Revisit if/when a specific
// `ALLOWED_ORIGIN` env var is introduced.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

/**
 * Call at the top of every Edge Function handler. Returns the preflight
 * response to return immediately when the incoming request *is* a CORS
 * preflight; returns `null` otherwise so the caller proceeds to handle the
 * real request (and should still merge `CORS_HEADERS` into its own
 * response).
 */
export function handleCorsPreflight(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}
