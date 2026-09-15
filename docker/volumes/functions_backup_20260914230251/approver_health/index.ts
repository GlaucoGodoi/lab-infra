// approver_health — minimal smoke-test Edge Function for US-063.
//
// Purpose: prove the approver_shared plumbing (CORS handling, the Zod
// validation helper, the success/error response envelope) actually works
// end-to-end before US-064 (authorization) and US-065 (transactional
// commands) build real logic on top of it.
//
// Deliberately out of scope here: no DB access (no `supabaseClient.ts`
// usage), no actor/JWT authorization, no audit/notification writes — this
// function does not represent a business command.

import { z } from "zod";
import { CORS_HEADERS, handleCorsPreflight } from "../approver_shared/cors.ts";
import { errorResponse, successResponse } from "../approver_shared/response.ts";
import { parseJsonBody } from "../approver_shared/validation.ts";

// Trivial request contract: GET needs no body; POST, if a body is sent at
// all, must be exactly `{}`. Not a Paperclip/LLM-facing contract — see
// approver_shared/validation.ts's note on when versioning is required.
const healthRequestSchema = z.object({}).strict();

Deno.serve(async (request: Request): Promise<Response> => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  try {
    if (request.method === "POST") {
      await parseJsonBody(request, healthRequestSchema);
    }

    return successResponse(
      {
        status: "ok",
        service: "approver_health",
        timestamp: new Date().toISOString(),
      },
      200,
      CORS_HEADERS,
    );
  } catch (error) {
    return errorResponse(error, CORS_HEADERS);
  }
});
