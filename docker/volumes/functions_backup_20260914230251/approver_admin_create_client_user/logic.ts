// approver_admin_create_client_user's non-network-dependent logic, kept in
// its own module (rather than inline in `index.ts`) specifically so it can
// be imported by `logic_test.ts` without ever triggering `index.ts`'s
// top-level `Deno.serve(...)` call. Every other deployable function's
// `index.ts` in this repo (`approver_health`, `approver_admin_create_client`)
// calls `Deno.serve()` unconditionally at module load — that's exactly how
// the self-hosted edge-runtime dispatches a request to a function (it
// imports `index.ts`, and that import's side effect registers the handler).
// Importing such a module from `deno test` would attempt to actually bind an
// HTTP listener outside the edge-runtime, which is neither sandboxed nor
// desired in a unit test. See `index.ts` and `logic_test.ts`.
//
// See `index.ts`'s header comment for the full US-007 design rationale
// (why this function is a deliberate exception to the `command.ts`
// one-RPC-call pattern, and why it's still race-safe).

import { z } from "zod";
import { ConflictError, NotFoundError } from "../approver_shared/errors.ts";

export const adminCreateClientUserSchema = z.object({
  clientId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
}).strict();

export type AdminCreateClientUserPayload = z.infer<typeof adminCreateClientUserSchema>;

/** No dedicated `AppError` subclass exists for "the upstream Auth Admin API
 * rejected this request for a reason unrelated to our own validation" — the
 * closest fit in the existing vocabulary (errors.ts) is `ConflictError`
 * (409): the request is well-formed and the actor is authorized, but a
 * precondition — here, "this email is not already registered" — failed.
 * Reused rather than adding a new subclass for a single call site. */
export class AuthAdminError extends ConflictError {}

/** Result shape every terminal `.maybeSingle()` call resolves to — mirrors
 * the `{ data, error }` pair every Supabase query builder call in this
 * codebase already destructures. */
export interface ClientLookupResult {
  data: unknown;
  error: { message: string } | null;
}

/** A chainable `.eq(...)` filter, recursive so any number of `.eq()` calls
 * can precede the terminal `.maybeSingle()` — `assertClientExistsAndHasNoUser`
 * below calls one `.eq()` for the `client` lookup and two for the
 * `user_profile` lookup. */
export interface ClientLookupFilter {
  eq(column: string, value: string): ClientLookupFilter;
  maybeSingle(): Promise<ClientLookupResult>;
}

/** Minimal shape this module needs from the `.from(table)` query builder —
 * narrowed rather than the full `SupabaseClient<any, "approver">` type
 * (`ApproverServiceClient`, see supabaseClient.ts) so `assertClientExistsAndHasNoUser`
 * can be unit tested with a hand-built fake, the same "narrow interface for
 * testability" approach `command.ts`'s `CommandRpcClient` already uses. */
export interface ClientLookupClient {
  from(table: string): {
    select(columns: string): ClientLookupFilter;
  };
}

/**
 * Precondition check (plan §2.4 step 3), run before ever calling the Auth
 * Admin API: the target client must exist (`NotFoundError`/404 — `clientId`
 * is a referenced resource in the request body, the same "does this
 * referenced thing exist" shape as a campaign/content lookup elsewhere in
 * this codebase) and must not already have a client-role `user_profile`
 * (`ConflictError`/409 — the request is well-formed and the actor is
 * authorized, but the "at most one client-role user per client" business
 * invariant, plan §5, would be violated). Doing this as an explicit, typed
 * pre-check turns the common/expected case into a clean error instead of
 * letting it surface as a raw Postgres unique-violation from the US-060
 * trigger bubbling up through GoTrue's own error response.
 */
export async function assertClientExistsAndHasNoUser(
  client: ClientLookupClient,
  clientId: string,
): Promise<void> {
  const { data: clientRow, error: clientError } = await client
    .from("client")
    .select("id")
    .eq("id", clientId)
    .maybeSingle();

  if (clientError) {
    console.error("approver_admin_create_client_user: client lookup failed:", clientError);
    throw new NotFoundError("Could not verify the target client.");
  }
  if (!clientRow) {
    throw new NotFoundError(`Client ${clientId} does not exist.`);
  }

  const { data: existingUser, error: userError } = await client
    .from("user_profile")
    .select("id")
    .eq("client_id", clientId)
    .eq("role", "client")
    .maybeSingle();

  if (userError) {
    console.error("approver_admin_create_client_user: user_profile lookup failed:", userError);
    throw new NotFoundError("Could not verify the target client's existing users.");
  }
  if (existingUser) {
    throw new ConflictError(`Client ${clientId} already has a client-role user.`);
  }
}

/** Minimal shape this module needs from a `supabase.auth.admin.createUser()`
 * error — narrowed rather than importing the full `AuthError` type, same
 * style as `command.ts`'s `RpcErrorLike`. */
export interface AuthAdminErrorLike {
  message: string;
  // `| undefined` spelled out explicitly (not just `?:`) because
  // `@supabase/supabase-js`'s `AuthError` declares both fields the same way
  // (`status: number | undefined`, not an optional property) — under this
  // project's `exactOptionalPropertyTypes: true`, `status?: number` alone
  // would reject assigning an explicitly-`undefined` value.
  status?: number | undefined;
  code?: string | undefined;
}

/** Map an Auth Admin API failure onto the shared `AppError` vocabulary
 * rather than leaking GoTrue's raw error shape to the caller. Only the
 * clearly-identifiable "this email is already registered" case is mapped
 * deliberately (mirrors command.ts's error-mapping philosophy: map only what
 * is confidently identifiable, let anything else fall through to
 * errorResponse()'s generic, non-leaking 500 rather than guessing). */
export function mapAuthAdminError(error: AuthAdminErrorLike | null | undefined): unknown {
  if (!error) {
    return new AuthAdminError("Auth Admin API did not return a created user.");
  }

  const isDuplicateEmail = error.code === "email_exists" ||
    error.status === 422 ||
    /already registered|already exists/i.test(error.message);

  if (isDuplicateEmail) {
    return new AuthAdminError(`Email is already registered: ${error.message}`);
  }

  // Not a case this module confidently recognizes — pass it through
  // unchanged so errorResponse()'s generic-500 path logs it server-side and
  // reports only the fixed, non-leaking message to the caller (see
  // response.ts).
  return error;
}
