// Typed, fail-fast environment variable accessors.
//
// Actual secret values live in a `.env` on the VPS the edge-runtime
// container reads from (CLAUDE.md — "runtime secrets live in a .env on the
// VPS, not in this repo"). This file only knows the *names* of the
// variables an Edge Function needs and fails loudly and immediately if one
// is missing, instead of letting `undefined` silently propagate into a
// Supabase client constructor or a fetch call.

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. Runtime secrets are ` +
        "configured in the edge-runtime container's .env on the VPS, not in this repo — " +
        "confirm it is set there before invoking this function.",
    );
  }
  return value;
}

/** The project's Supabase URL (e.g. `https://<host>` for this self-hosted
 * instance). Required by every function that constructs a Supabase client. */
export function getSupabaseUrl(): string {
  return requireEnv("SUPABASE_URL");
}

/** The service-role key. Privileged: bypasses RLS. Never forward this value
 * to a client response, log line, or error detail — see
 * `supabaseClient.ts`, the only place this should be consumed. */
export function getSupabaseServiceRoleKey(): string {
  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

/** The anon (public) API key. Unprivileged by itself — RLS still applies to
 * anything done with it. US-064's `actor.ts` pairs this with the caller's
 * own bearer token (never the service-role key) so Postgres resolves
 * `auth.uid()` as the actual caller, not as an anonymous or privileged
 * identity. Safe to expose to a browser client (it already is, in the
 * Angular app's own Supabase client config); listed here only because an
 * Edge Function also needs it server-side to build that as-caller client. */
export function getSupabaseAnonKey(): string {
  return requireEnv("SUPABASE_ANON_KEY");
}
