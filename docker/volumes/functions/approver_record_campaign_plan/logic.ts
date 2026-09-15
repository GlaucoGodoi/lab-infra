// approver_record_campaign_plan's non-network-dependent logic, kept in its
// own module (rather than inline in `index.ts`) specifically so it can be
// imported by `logic_test.ts` without ever triggering `index.ts`'s
// top-level `Deno.serve(...)` call — same convention US-007's
// `approver_admin_create_client_user/logic.ts` established (see that
// file's header comment for the full rationale).
//
// See `index.ts`'s header comment for the full US-066 design rationale:
// why this function is a deliberate, second exception to the
// `command.ts` one-RPC-call pattern (distinct from US-007's — this one is
// exception because the *caller* has no JWT at all, not because the
// backing operation can't be one SQL function).

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

export const recordCampaignPlanSchema = z.object({
  campaignId: z.string().uuid(),
  contentMarkdown: z.string().min(1),
}).strict();

export type RecordCampaignPlanPayload = z.infer<typeof recordCampaignPlanSchema>;

/**
 * Verifies the caller presented the actual service-role key as its own
 * bearer credential. This function has no JWT to resolve via
 * `resolveActor()` — its only intended caller is n8n, a trusted backend
 * holding the service-role key as a stored credential (exactly the
 * backend-to-backend case that key exists for, CLAUDE.md non-negotiable
 * #1 — "the service-role key exists only inside Edge Functions ... this is
 * exactly the trusted-backend-to-backend case the service-role key exists
 * for"). Throws `AuthorizationError` (403) for a missing/malformed header
 * or a non-matching key — mirrors `actor.ts`'s `extractBearerToken`
 * behavior/error shape for a familiar failure mode, even though the
 * comparison target is completely different (a fixed secret, not a JWT to
 * verify with Supabase Auth).
 *
 * Uses a constant-time comparison so a network timing side-channel can't
 * be used to guess the key byte-by-byte against this endpoint. Deno's std
 * library already ships one (`@std/crypto/timing-safe-equal`'s
 * `timingSafeEqual`) — no need to hand-roll one with the Web Crypto API.
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

/** Constant-time equality check against the real service-role key.
 * `timingSafeEqual` itself requires equal-length inputs (like Node's
 * `crypto.timingSafeEqual`) — the length check must happen first, and a
 * length mismatch is reported as a plain `false` rather than being run
 * through the constant-time path, since there is nothing secret about
 * *how long* the presented string is beyond what a network observer can
 * already see from the request itself. */
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
 * consistency even though `approver.record_campaign_plan` is only expected
 * to actually raise AP001 (malformed payload — defensive, Zod already
 * covers this)/AP003 (campaign not found)/AP004 (campaign not in
 * `registered` status) in practice: keeping the full table rather than a
 * hand-picked subset means a future change to the SQL function's raised
 * codes doesn't silently start falling through to the generic-500 path
 * just because this module only anticipated some of them. */
const RECORD_CAMPAIGN_PLAN_SQLSTATE_TO_ERROR: Record<
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

/** Map a `.rpc('record_campaign_plan', ...)` error onto the shared
 * `AppError` vocabulary when it carries one of the four reserved
 * SQLSTATEs; otherwise return it unchanged so `errorResponse()`'s
 * generic-500 path handles it — same "never guess at an unmapped error"
 * philosophy as `command.ts`'s `mapRpcError`. */
export function mapRecordCampaignPlanError(error: RpcErrorLike): unknown {
  const ErrorClass = error.code ? RECORD_CAMPAIGN_PLAN_SQLSTATE_TO_ERROR[error.code] : undefined;
  if (!ErrorClass) return error;

  return new ErrorClass(error.message, {
    pgCode: error.code,
    details: error.details ?? undefined,
    hint: error.hint ?? undefined,
  });
}
