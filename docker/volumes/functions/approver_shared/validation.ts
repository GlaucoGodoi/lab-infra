// Zod-based request-body parsing helper.
//
// This is the first shared Zod usage in the repo. It is a generic *parsing
// utility*, not a contract: per CLAUDE.md ("Before you change a generation
// contract"), any *Paperclip/LLM-facing* Zod schema (a campaign-plan schema,
// copy schema, artwork spec, or anything n8n/Paperclip output is validated
// against) must be versioned explicitly when its shape changes. That
// requirement applies to those future contract schemas themselves, not to
// this helper, which never changes shape based on what schema it is given.

import type { ZodError, ZodSchema } from "zod";
import { ValidationError } from "./errors.ts";

/**
 * Parse and validate a request's JSON body against a Zod schema. Throws
 * `ValidationError` (mapped to HTTP 400 by response.ts) if the body is not
 * valid JSON or fails the schema; otherwise resolves with the typed,
 * parsed result.
 */
export async function parseJsonBody<T>(request: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch (cause) {
    throw new ValidationError("Request body must be valid JSON.", { cause: String(cause) });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError("Request body failed validation.", formatZodError(result.error));
  }

  return result.data;
}

function formatZodError(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
