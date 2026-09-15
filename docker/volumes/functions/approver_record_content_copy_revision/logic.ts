// approver_record_content_copy_revision's non-network-dependent logic, kept
// in its own module (rather than inline in `index.ts`) specifically so it
// can be imported by `logic_test.ts` without ever triggering `index.ts`'s
// top-level `Deno.serve(...)` call — same convention every other write-back
// Edge Function in this codebase established.
//
// See `index.ts`'s header comment for the full US-069 design rationale
// (which also covers US-027 "Regenerate copy" — see the backing SQL
// migration's header comment for why one function/endpoint covers both).
// This is a sibling of `approver_record_content_copy/logic.ts` (US-068),
// duplicated here rather than shared, following that file's own precedent.
//
// `copyPayload` is accepted as an arbitrary JSON object (`z.record`), same
// "no versioned Paperclip copy-output contract exists yet" note as
// `approver_record_content_copy/logic.ts`. `agentResponseText` is optional
// — the backing SQL function substitutes a generic default when omitted
// (see `20260915164500_approver_record_content_copy_revision.sql`'s header
// comment).

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

export const recordContentCopyRevisionSchema = z.object({
  contentId: z.string().uuid(),
  copyPayload: z.record(z.unknown()),
  revisionCommentId: z.string().uuid(),
  agentResponseText: z.string().min(1).optional(),
}).strict();

export type RecordContentCopyRevisionPayload = z.infer<typeof recordContentCopyRevisionSchema>;

/**
 * Verifies the caller presented the actual service-role key as its own
 * bearer credential. Identical to every other write-back endpoint's
 * `assertServiceRoleCaller` in this schema — see
 * `approver_record_campaign_plan/logic.ts`'s header comment for the full
 * rationale.
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

/** Constant-time equality check against the real service-role key. */
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
 * doesn't go through `command.ts`. */
export interface RpcErrorLike {
  code?: string | null;
  message: string;
  details?: string | null;
  hint?: string | null;
}

/** Same four reserved custom SQLSTATEs every sibling write-back endpoint
 * maps. `approver.record_content_copy_revision` is expected to raise
 * AP001 (malformed payload)/AP003 (content not found, or
 * revisionCommentId does not reference an existing unanswered
 * revision_comment for this content item)/AP004 (content not in
 * `pending_copy_review` status) in practice — the full table is kept
 * regardless, same reasoning as every sibling module. */
const RECORD_CONTENT_COPY_REVISION_SQLSTATE_TO_ERROR: Record<
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

/** Map a `.rpc('record_content_copy_revision', ...)` error onto the shared
 * `AppError` vocabulary when it carries one of the four reserved
 * SQLSTATEs; otherwise return it unchanged so `errorResponse()`'s
 * generic-500 path handles it. */
export function mapRecordContentCopyRevisionError(error: RpcErrorLike): unknown {
  const ErrorClass = error.code
    ? RECORD_CONTENT_COPY_REVISION_SQLSTATE_TO_ERROR[error.code]
    : undefined;
  if (!ErrorClass) return error;

  return new ErrorClass(error.message, {
    pgCode: error.code,
    details: error.details ?? undefined,
    hint: error.hint ?? undefined,
  });
}
