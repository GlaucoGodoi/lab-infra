// approver_record_content_copy's non-network-dependent logic, kept in its
// own module (rather than inline in `index.ts`) specifically so it can be
// imported by `logic_test.ts` without ever triggering `index.ts`'s
// top-level `Deno.serve(...)` call — same convention US-007's
// `approver_admin_create_client_user/logic.ts` and US-066's
// `approver_record_campaign_plan/logic.ts` established.
//
// See `index.ts`'s header comment for the full US-068 design rationale:
// this is a sibling of `approver_record_campaign_plan/logic.ts` (US-066)
// and `approver_record_campaign_plan_revision/logic.ts` (US-067),
// duplicated here rather than shared, following those files' own
// precedent — each write-back endpoint owns its own schema and its own
// SQLSTATE-to-error table, since each wraps a distinct SQL function with
// its own precondition/business semantics; the auth-check shape
// (`assertServiceRoleCaller`) is duplicated, not extracted into
// `approver_shared`, matching the existing precedent of not introducing a
// new shared abstraction beyond what's already established.
//
// `copyPayload` is accepted as an arbitrary JSON object (`z.record`), not
// validated against a versioned Paperclip copy-output contract — no such
// shared contract exists yet in this repo (CLAUDE.md's "Before you change
// a generation contract": "No such shared contract file exists yet ...
// when you create the first one, put it under
// supabase/functions/approver_shared"). Defining that first shared
// contract is out of scope for this story.

import { z } from "zod";
import { timingSafeEqual } from "@std/crypto/timing-safe-equal";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../approver_shared/errors.ts";
import { getSupabaseServiceRoleKey } from "../approver_shared/env.ts";

const BEARER_PREFIX = "Bearer ";

export const recordContentCopySchema = z.object({
  contentId: z.string().uuid(),
  copyPayload: z.record(z.unknown()),
}).strict();

export type RecordContentCopyPayload = z.infer<typeof recordContentCopySchema>;

/**
 * Verifies the caller presented the actual service-role key as its own
 * bearer credential. This function has no JWT to resolve via
 * `resolveActor()` — its only intended caller is n8n, a trusted backend
 * holding the service-role key as a stored credential (exactly the
 * backend-to-backend case that key exists for, CLAUDE.md non-negotiable
 * #1). Throws `AuthorizationError` (403) for a missing/malformed header or
 * a non-matching key — identical to `approver_record_campaign_plan/
 * logic.ts`'s `assertServiceRoleCaller`.
 *
 * Uses a constant-time comparison so a network timing side-channel can't
 * be used to guess the key byte-by-byte against this endpoint.
 */
export function assertServiceRoleCaller(request: Request): void {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    throw new AuthorizationError("Missing or malformed Authorization header.");
  }

  const presented = header.slice(BEARER_PREFIX.length).trim();
  if (presented.length === 0 || !isServiceRoleKey(presented)) {
    throw new AuthorizationError("Caller is not authorized to invoke this function.");
  }
}

/** Constant-time equality check against the real service-role key. See
 * `approver_record_campaign_plan/logic.ts`'s identical helper for the full
 * rationale (length check first, non-secret to observe). */
function isServiceRoleKey(candidate: string): boolean {
  const expected = getSupabaseServiceRoleKey();
  const encoder = new TextEncoder();
  const candidateBytes = encoder.encode(candidate);
  const expectedBytes = encoder.encode(expected);

  if (candidateBytes.byteLength !== expectedBytes.byteLength) {
    return false;
  }
  return timingSafeEqual(candidateBytes, expectedBytes);
}

/** Minimal shape this module needs from a `.rpc()` call's error — mirrors
 * `command.ts`'s `RpcErrorLike`, redeclared locally since this function
 * doesn't go through `command.ts` (its RPC signature isn't the fixed
 * 4-argument command shape — see `index.ts`'s header comment). */
export interface RpcErrorLike {
  code?: string | null;
  message: string;
  details?: string | null;
  hint?: string | null;
}

/** Same four reserved custom SQLSTATEs `command.ts` maps, reused here for
 * consistency even though `approver.record_content_copy` is only expected
 * to actually raise AP001 (malformed payload — defensive, Zod already
 * covers this)/AP003 (content not found)/AP004 (content not in
 * `pending_copy_generation` status) in practice — keeping the full table
 * rather than a hand-picked subset means a future change to the SQL
 * function's raised codes doesn't silently start falling through to the
 * generic-500 path just because this module only anticipated some of
 * them. */
const RECORD_CONTENT_COPY_SQLSTATE_TO_ERROR: Record<
  string,
  new (
    message: string,
    details?: unknown,
  ) => ValidationError | AuthorizationError | NotFoundError | ConflictError
> = {
  AP001: ValidationError,
  AP002: AuthorizationError,
  AP003: NotFoundError,
  AP004: ConflictError,
};

/** Map a `.rpc('record_content_copy', ...)` error onto the shared
 * `AppError` vocabulary when it carries one of the four reserved
 * SQLSTATEs; otherwise return it unchanged so `errorResponse()`'s
 * generic-500 path handles it. */
export function mapRecordContentCopyError(error: RpcErrorLike): unknown {
  const ErrorClass = error.code ? RECORD_CONTENT_COPY_SQLSTATE_TO_ERROR[error.code] : undefined;
  if (!ErrorClass) return error;

  return new ErrorClass(error.message, {
    pgCode: error.code,
    details: error.details ?? undefined,
    hint: error.hint ?? undefined,
  });
}
