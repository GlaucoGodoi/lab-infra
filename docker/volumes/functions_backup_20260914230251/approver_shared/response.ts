// One JSON response envelope shape for every approver_ Edge Function.
//
// Success: { data: T, error: null }
// Failure: { data: null, error: { code, message, details? } }
//
// `errorResponse` is the single place that maps a thrown value to an HTTP
// status: a typed `AppError` (see errors.ts) maps to its own declared
// status/code, anything else is treated as an unexpected server error (500,
// generic message) so internals never leak to the caller.

import { AppError, isAppError } from "./errors.ts";

export interface ApiSuccessBody<T> {
  data: T;
  error: null;
}

export interface ApiErrorDetail {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorBody {
  data: null;
  error: ApiErrorDetail;
}

export type ApiResponseBody<T> = ApiSuccessBody<T> | ApiErrorBody;

const JSON_CONTENT_TYPE = "application/json";
const UNEXPECTED_ERROR_STATUS = 500;
const UNEXPECTED_ERROR_CODE = "INTERNAL_ERROR";
const UNEXPECTED_ERROR_MESSAGE = "An unexpected error occurred.";

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", JSON_CONTENT_TYPE);
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

/** Build the success envelope. `status` defaults to 200; pass e.g. 201 for a
 * command that creates a resource once US-065 lands. */
export function successResponse<T>(data: T, status = 200, headers?: HeadersInit): Response {
  const body: ApiSuccessBody<T> = { data, error: null };
  return jsonResponse(body, status, headers);
}

/** Build the error envelope from anything a handler might throw. A typed
 * `AppError` (ValidationError, AuthorizationError, NotFoundError,
 * ConflictError, or a future subclass) maps to its own status/code; any
 * other thrown value is logged server-side (visible in the edge-runtime
 * container logs) and reported to the caller as a generic 500 — never the
 * original message, which may contain internals (a raw DB error, a stack
 * trace fragment, etc.). */
export function errorResponse(error: unknown, headers?: HeadersInit): Response {
  if (isAppError(error)) {
    return jsonResponse(toErrorBody(error), error.status, headers);
  }

  console.error("Unhandled error in Edge Function:", error);
  const body: ApiErrorBody = {
    data: null,
    error: { code: UNEXPECTED_ERROR_CODE, message: UNEXPECTED_ERROR_MESSAGE },
  };
  return jsonResponse(body, UNEXPECTED_ERROR_STATUS, headers);
}

function toErrorBody(error: AppError): ApiErrorBody {
  const detail: ApiErrorDetail = { code: error.code, message: error.message };
  if (error.details !== undefined) {
    detail.details = error.details;
  }
  return { data: null, error: detail };
}
