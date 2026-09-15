// Actor resolution and authorization for Edge Function command handlers.
//
// US-064: every state-changing command (plan §2.4 — validate current state
// -> authorize actor -> validate preconditions -> persist -> audit ->
// notify -> return) needs to know *who* is calling before it can do the
// "authorize actor" step. This module is where that identity is resolved
// and where the two role/tenancy checks every command needs are defined.
//
// Design decision (approved): the Edge Function verifies the caller's JWT
// itself, rather than trusting any platform/gateway-level verification to
// have already happened in front of it. This repo does not control the
// self-hosted edge-runtime's gateway config (CLAUDE.md — infrastructure is
// out of scope), so "some gateway already checked this" is not an
// assumption this code is willing to make. `resolveActor()` below verifies
// the token by asking Supabase Auth about it directly.
//
// It also deliberately does not re-derive role/tenancy rules in
// TypeScript: `approver.current_user_role()` / `approver.current_client_id()`
// (US-060) are called via RPC *as the caller* (their own JWT, not the
// service-role key) so Postgres resolves `auth.uid()` as that caller and
// the already-tested SQL logic is the single source of truth for "what
// role/client does this user have." Duplicating that resolution here would
// just be a second place for it to drift out of sync.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AuthorizationError } from "./errors.ts";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env.ts";

const APPROVER_SCHEMA = "approver";
const BEARER_PREFIX = "Bearer ";

/** Mirrors `approver.user_role` (US-057) exactly — two values, no more. */
export type ActorRole = "client" | "admin";

/** The resolved identity of an Edge Function caller. `clientId` is null for
 * an admin (admins are not scoped to a single client) and always non-null
 * for a client (US-060/US-057's `user_profile` shape guarantees this). */
export interface Actor {
  userId: string;
  role: ActorRole;
  clientId: string | null;
}

// No generated Database type exists yet for this project — same situation
// `supabaseClient.ts` documents for the service-role client. Replace `any`
// with `SupabaseClient<Database, "approver">` once one is committed.
// deno-lint-ignore no-explicit-any
type AsCallerClient = SupabaseClient<any, "approver">;

function isActorRole(value: unknown): value is ActorRole {
  return value === "client" || value === "admin";
}

/** Extract the bearer token from the request's `Authorization` header.
 * Throws `AuthorizationError` if it's missing, doesn't use the `Bearer`
 * scheme, or the token itself is empty. */
function extractBearerToken(request: Request): string {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    throw new AuthorizationError("Missing or malformed Authorization header.");
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) {
    throw new AuthorizationError("Missing or malformed Authorization header.");
  }

  return token;
}

/** Build a Supabase client that authenticates as the *caller*, not as this
 * Edge Function. Uses the anon key (never the service-role key — that
 * would defeat the point) with the caller's own bearer token forwarded as
 * the `Authorization` header, so both `auth.getUser()` and any RPC/query
 * made with this client see the caller's own identity, and Postgres RLS /
 * `auth.uid()` resolve to that caller rather than to a privileged bypass. */
function createAsCallerClient(token: string): AsCallerClient {
  return createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    db: { schema: APPROVER_SCHEMA },
    global: { headers: { Authorization: `${BEARER_PREFIX}${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolve the `Actor` making this request: extract and verify the bearer
 * token, then resolve role/client via the US-060 RPC helpers. Throws
 * `AuthorizationError` at every failure point (missing/malformed header,
 * invalid/expired token, or an authenticated user with no `user_profile`
 * row yet) — never returns a partial/unknown actor.
 */
export async function resolveActor(request: Request): Promise<Actor> {
  const token = extractBearerToken(request);
  const asCaller = createAsCallerClient(token);

  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData?.user) {
    throw new AuthorizationError("Invalid or expired session token.");
  }

  const [roleResult, clientIdResult] = await Promise.all([
    asCaller.rpc("current_user_role"),
    asCaller.rpc("current_client_id"),
  ]);

  if (roleResult.error || clientIdResult.error) {
    console.error(
      "resolveActor: failed to resolve role/client via RPC:",
      roleResult.error ?? clientIdResult.error,
    );
    throw new AuthorizationError("Could not resolve the caller's role.");
  }

  if (!isActorRole(roleResult.data)) {
    // Authenticated (the token verified above), but no approver.user_profile
    // row exists for this auth.users id. The US-060 provisioning trigger
    // runs synchronously AFTER INSERT on auth.users, so this should be rare
    // in practice — but it's a real, reachable state (e.g. a row created
    // some other way, or a race with the trigger), not one this code is
    // willing to assume away.
    throw new AuthorizationError("Authenticated user has no approver profile.");
  }

  return {
    userId: userData.user.id,
    role: roleResult.data,
    clientId: (clientIdResult.data as string | null) ?? null,
  };
}

/** Throw `AuthorizationError` unless `actor.role` is one of `allowedRoles`.
 * Use at the top of a command handler to gate an entire command to one
 * role (e.g. only `admin` can create a user) or to a set of roles. */
export function requireRole(actor: Actor, ...allowedRoles: ActorRole[]): void {
  if (!allowedRoles.includes(actor.role)) {
    throw new AuthorizationError(
      `Actor role '${actor.role}' is not permitted to perform this action.`,
    );
  }
}

/** Throw `AuthorizationError` unless `actor` is authorized to act on
 * resources belonging to `clientId`. An admin is always authorized (admins
 * span clients by design, plan §5); a client is authorized only for its
 * own `clientId` — this is the tenancy check every command must run before
 * touching a specific campaign/content/client row, never trusting a
 * `client_id` passed in the request body on its own. */
export function requireOwnClient(actor: Actor, clientId: string): void {
  if (actor.role === "admin") return;
  if (actor.clientId === clientId) return;

  throw new AuthorizationError("Actor is not authorized for this client's resources.");
}
