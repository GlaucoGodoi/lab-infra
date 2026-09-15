// Typed error classes for Edge Function command handlers.
//
// Every business/validation failure an Edge Function raises should be one of
// these (or a subclass added later), never a bare `Error` or `throw` of a
// string/object literal. `response.ts` maps each type to its HTTP status and
// the shared `{ data, error }` envelope. Keeping the status/code pairing on
// the error class itself (rather than in a lookup table in `response.ts`)
// means a new error type is self-describing at the call site and can't drift
// out of sync with its mapping.
//
// US-064 (Edge Function authorization) and US-065 (transactional commands)
// are expected to throw these from within the validate -> authorize ->
// precondition -> persist -> audit -> notify -> return sequence described in
// docs/approver-implementation-plan.md §2.4 — this file only defines the
// vocabulary, it does not implement that sequence.

export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

/** The request payload failed shape/type validation (e.g. a Zod parse). */
export class ValidationError extends AppError {
  readonly status = 400;
  readonly code = "VALIDATION_ERROR";
}

/**
 * The caller could not be resolved to an authorized actor, or was resolved
 * but is not permitted to perform this action. Deliberately one status for
 * both: this repo does not control the self-hosted edge-runtime's gateway
 * config (CLAUDE.md — infrastructure is out of scope), so US-064's
 * `resolveActor()` verifies the caller's JWT itself rather than trusting any
 * platform/gateway-level verification to have already happened. A missing
 * bearer token, an invalid/expired JWT, and a validly-authenticated user who
 * simply isn't allowed to run this command are all "not an authorized actor
 * for this request" from the caller's point of view, so all three map here
 * rather than splitting out a separate 401.
 */
export class AuthorizationError extends AppError {
  readonly status = 403;
  readonly code = "AUTHORIZATION_ERROR";
}

/** The referenced resource (campaign, content item, etc.) does not exist,
 * or does not exist *for this caller* — RLS-style "not found" rather than
 * leaking existence of another client's row via a 403. */
export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = "NOT_FOUND";
}

/** The request is well-formed and the actor is authorized, but a business
 * precondition failed — most commonly a workflow-state invariant from plan
 * §18 (e.g. attempting to approve a campaign that is not in the expected
 * state). */
export class ConflictError extends AppError {
  readonly status = 409;
  readonly code = "CONFLICT";
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
