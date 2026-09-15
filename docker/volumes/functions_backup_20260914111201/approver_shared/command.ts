// US-065: the reusable request-handling harness every future
// `approver_<command>/index.ts` business-command Edge Function is expected
// to be built on top of.
//
// Recap of the approved architecture (see the header comment on
// 20260913202438_approver_transactional_command_helpers.sql for the DB
// side): `@supabase/supabase-js` talks to Postgres through PostgREST, which
// has no ad-hoc multi-table client-side transaction primitive. So instead of
// an Edge Function performing several separate `.from(...)` calls itself,
// **each business command is backed by exactly one Postgres function**, and
// the Edge Function's entire job is: resolve who is calling, validate the
// request shape, make exactly one `.rpc()` call, and translate the result
// (or a raised Postgres exception) into the shared `{ data, error }`
// envelope. The whole validate -> authorize -> precondition -> persist ->
// audit -> notify -> return sequence from plan §2.4 runs *inside* that one
// Postgres function body — Postgres's own transaction semantics make it
// atomic, and this file never re-implements or duplicates any part of that
// sequence in TypeScript.
//
// ---------------------------------------------------------------------
// THE RPC CALL CONVENTION — every future command function must match this.
// ---------------------------------------------------------------------
//
// `handleCommand()` always calls the named RPC with exactly four arguments,
// regardless of which command it is:
//
//   {
//     p_actor_user_id:   actor.userId,
//     p_actor_role:      actor.role,       -- 'client' | 'admin', matches
//                                             approver.user_role exactly
//     p_actor_client_id: actor.clientId,   -- null for an admin
//     p_payload:         <the Zod-validated request body, as-is>
//   }
//
// So every command's backing Postgres function must declare this fixed
// signature shape:
//
//   CREATE FUNCTION approver.<command_name>(
//       p_actor_user_id   uuid,
//       p_actor_role      approver.user_role,
//       p_actor_client_id uuid,
//       p_payload         jsonb
//   ) RETURNS jsonb ...
//
// Why a fixed 4-argument shape instead of spreading the payload's own
// fields as positional/named SQL parameters: it means this harness needs
// zero command-specific knowledge — no per-command "how do I map this
// payload onto that function's parameter names" glue code to write and keep
// in sync in TypeScript. All of that unpacking (`p_payload->>'campaignId'`,
// casts, etc.) happens once, in the one place that already owns the
// business logic for that command: the SQL function body itself. A command
// definition on the TypeScript side is therefore just a Zod schema plus an
// RPC name — see `CommandDefinition` below.
//
// The function's return value (whatever `RETURNS jsonb` produces — expected
// to be the resulting state per plan §2.4 step 7, e.g.
// `{"status": "initial_approved", ...}`) is forwarded verbatim as `data` in
// the success envelope.
//
// ---------------------------------------------------------------------
// ERROR MAPPING CONVENTION.
// ---------------------------------------------------------------------
//
// A command function signals a *designed* business/validation failure (not
// an unexpected bug) by raising a Postgres exception with one of four
// reserved custom SQLSTATE codes (Postgres reserves the "P" class prefix
// for plpgsql's own PLpgSQL_ASSERT etc.; "AP" — for Approver — avoids any
// collision with a built-in or extension-defined code):
//
//   RAISE EXCEPTION 'Campaign is not in the expected state.'
//       USING ERRCODE = 'AP001';   -- -> ValidationError (400)
//   RAISE EXCEPTION 'Actor is not authorized for this client.'
//       USING ERRCODE = 'AP002';   -- -> AuthorizationError (403)
//   RAISE EXCEPTION 'Campaign not found.'
//       USING ERRCODE = 'AP003';   -- -> NotFoundError (404)
//   RAISE EXCEPTION 'Campaign is not pending_initial_approve.'
//       USING ERRCODE = 'AP004';   -- -> ConflictError (409) — the common
//                                     case: a plan §18 workflow-state
//                                     invariant violation.
//
// `handleCommand()` inspects the thrown error's `.code` (the Postgres
// SQLSTATE, which `@supabase/supabase-js`'s `PostgrestError` surfaces
// verbatim from the database) against exactly these four codes. Any other
// error — a native constraint violation, a connection failure, an
// unannotated `RAISE EXCEPTION` with the default `P0001`, anything not
// deliberately one of the four codes above — is deliberately NOT guessed
// at. It is passed through to `errorResponse()` unchanged, which logs it
// server-side and reports a generic 500 to the caller. This is intentional:
// an unmapped error means either a real bug or a command function that
// forgot to raise a designed error for a reachable case, and a silent
// best-guess mapping (e.g. "any check_violation must mean 409") would hide
// that rather than surface it. Keep this table exactly this small; if a
// future story finds it insufficient, extend the table deliberately rather
// than adding heuristics.

import type { ZodSchema } from "zod";
import { CORS_HEADERS, handleCorsPreflight } from "./cors.ts";
import { errorResponse, successResponse } from "./response.ts";
import {
  AppError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./errors.ts";
import { type Actor, type ActorRole, requireRole, resolveActor } from "./actor.ts";
import { createApproverServiceClient } from "./supabaseClient.ts";
import { parseJsonBody } from "./validation.ts";

/** The fixed argument shape every command RPC call sends — see this file's
 * header comment for why it never varies per command. */
export interface CommandRpcArgs {
  p_actor_user_id: string;
  p_actor_role: ActorRole;
  p_actor_client_id: string | null;
  p_payload: unknown;
  // Index signature so this fixed-shape type can be passed directly as the
  // `Record<string, unknown>` argument `CommandRpcClient.rpc()` declares —
  // TypeScript does not infer one for a named interface automatically.
  [key: string]: unknown;
}

/** Minimal shape this module depends on from a `.rpc()` call's error —
 * matches `@supabase/supabase-js`'s `PostgrestError`, redeclared narrowly
 * here so this module depends only on the two fields it actually reads
 * (`code`, `message`) rather than the full postgrest-js error type. */
interface RpcErrorLike {
  code?: string | null;
  message: string;
  details?: string | null;
  hint?: string | null;
}

/** The four reserved custom SQLSTATEs a command function may raise to
 * signal a designed error — see the header comment. Anything else falls
 * through unmapped. */
const COMMAND_SQLSTATE_TO_ERROR: Record<
  string,
  new (message: string, details?: unknown) => AppError
> = {
  AP001: ValidationError,
  AP002: AuthorizationError,
  AP003: NotFoundError,
  AP004: ConflictError,
};

/** Map a `.rpc()` error onto the shared `AppError` vocabulary when it
 * carries one of the four reserved SQLSTATEs; otherwise return it
 * unchanged so `errorResponse()`'s generic-500 path handles it (see the
 * "ERROR MAPPING CONVENTION" header comment for why an unmapped error is
 * never guessed at). */
function mapRpcError(error: RpcErrorLike): unknown {
  const ErrorClass = error.code ? COMMAND_SQLSTATE_TO_ERROR[error.code] : undefined;
  if (!ErrorClass) return error;

  return new ErrorClass(error.message, {
    pgCode: error.code,
    details: error.details ?? undefined,
    hint: error.hint ?? undefined,
  });
}

/**
 * Declares one business command: its Zod request schema and the name of
 * the single Postgres function backing it. `allowedRoles`, if given, is a
 * coarse, defense-in-depth pre-check run immediately after `resolveActor()`
 * — purely to reject an obviously-wrong-role caller before spending a
 * network round-trip on the RPC call. It is never a substitute for the
 * command function's own authorization check: plan §2.4 step 2 ("validate
 * actor authorization") is the SQL function's responsibility, including
 * every tenancy check (`requireOwnClient`-shaped logic re-expressed in
 * SQL, since a command function cannot import `actor.ts`). Omit
 * `allowedRoles` for a command open to both roles.
 */
export interface CommandDefinition<TPayload> {
  /** Name of the Postgres function to invoke via `.rpc()` (no schema
   * prefix — the service-role client is already scoped to `approver` via
   * `supabaseClient.ts`). */
  rpcName: string;
  /** Validates and types the request body. */
  schema: ZodSchema<TPayload>;
  /** Optional coarse role pre-check — see the interface doc comment. */
  allowedRoles?: ActorRole[];
  /** HTTP status for a successful response. Defaults to 200; pass 201 for
   * a command that creates a resource. */
  successStatus?: number;
}

/**
 * The minimal shape this module needs from a Supabase client: just `.rpc()`,
 * resolving to the same `{ data, error }` pair every `.rpc()` call in this
 * codebase already destructures. Deliberately narrower than the real
 * `SupabaseClient<any, "approver">` type (`supabaseClient.ts`'s
 * `ApproverServiceClient`) so a test can hand `dispatchCommand`/
 * `handleCommand` a trivial fake object instead of implementing dozens of
 * unrelated `SupabaseClient` methods — see `command_test.ts`. The real
 * client's actual `.rpc()` return value is a thenable `PostgrestFilterBuilder`
 * rather than a literal `Promise`, but it resolves to this exact shape when
 * awaited (every other module in this codebase awaits it the same way), so
 * passing the real client here needs a narrowing cast, not a behavior change
 * — see `createApproverCommandClient()` below.
 */
export interface CommandRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: RpcErrorLike | null }>;
}

/** Wraps `createApproverServiceClient()` for use as a `CommandRpcClient`.
 * The cast is safe: it only narrows the surface this module is allowed to
 * call (`.rpc()`), it does not change what the real client does. No
 * generated `Database` type exists yet for this project (same situation
 * documented in `supabaseClient.ts`/`actor.ts`), which is what makes the
 * real client's `.rpc()` typed loosely enough to need this narrowing in the
 * first place — revisit once one is committed. */
function createApproverCommandClient(): CommandRpcClient {
  // deno-lint-ignore no-explicit-any
  return createApproverServiceClient() as any;
}

/**
 * Runs everything a command needs *after* the caller's identity is already
 * known: the optional coarse role check, request-body validation, the
 * single `.rpc()` call, and result/error mapping. Never throws — every
 * failure is caught and turned into the shared error envelope, so this
 * always resolves with a `Response`.
 *
 * Split out from `handleCommand()` specifically so it can be unit tested
 * with a hand-built `Actor` and a fake `CommandRpcClient`, without needing
 * `resolveActor()`'s live network call (`auth.getUser()` against a running
 * Supabase Auth server) — the same accepted test-coverage boundary
 * `actor_test.ts` already documents for `resolveActor()` itself. See
 * `command_test.ts`.
 */
export async function dispatchCommand<TPayload>(
  actor: Actor,
  request: Request,
  definition: CommandDefinition<TPayload>,
  client: CommandRpcClient,
): Promise<Response> {
  try {
    if (definition.allowedRoles) {
      requireRole(actor, ...definition.allowedRoles);
    }

    const payload = await parseJsonBody(request, definition.schema);
    const args = buildRpcArgs(actor, payload);

    const { data, error } = await client.rpc(definition.rpcName, args);
    if (error) {
      throw mapRpcError(error);
    }

    return successResponse(data, definition.successStatus ?? 200, CORS_HEADERS);
  } catch (error) {
    return errorResponse(error, CORS_HEADERS);
  }
}

/**
 * The one function every `approver_<command>/index.ts` should call from
 * its `Deno.serve` handler. Runs the full request lifecycle: CORS
 * preflight -> resolve actor -> `dispatchCommand()` for everything after.
 *
 * `client` defaults to a fresh service-role client per call; accepting it
 * as a parameter (rather than constructing it unconditionally inside) is
 * what makes `dispatchCommand()` reusable in tests with a fake client.
 */
export async function handleCommand<TPayload>(
  request: Request,
  definition: CommandDefinition<TPayload>,
  client: CommandRpcClient = createApproverCommandClient(),
): Promise<Response> {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  try {
    const actor = await resolveActor(request);
    return await dispatchCommand(actor, request, definition, client);
  } catch (error) {
    return errorResponse(error, CORS_HEADERS);
  }
}

/** Build the fixed 4-argument RPC call shape — see this file's header
 * comment for why the shape never varies per command. */
function buildRpcArgs<TPayload>(actor: Actor, payload: TPayload): CommandRpcArgs {
  return {
    p_actor_user_id: actor.userId,
    p_actor_role: actor.role,
    p_actor_client_id: actor.clientId,
    p_payload: payload,
  };
}
