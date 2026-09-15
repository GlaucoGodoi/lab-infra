// approver_record_content_copy — US-068: Copy generation workflow's backend
// write-back endpoint.
//
// DELIBERATE EXCEPTION to the US-065 `command.ts` one-RPC-call pattern —
// same shape as `approver_record_campaign_plan` (US-066) and
// `approver_record_campaign_plan_revision` (US-067). Read either of those
// files' header comments first if this one is unfamiliar; only the deltas
// are re-explained here.
//
// This function's caller is n8n, once the copy-generation workflow (fired
// by `approver.notify_content_copy_generation_requested()`,
// `supabase/migrations/20260915160000_approver_content_copy_generation_trigger.sql`)
// has had the Paperclip copy agent produce copy for ONE content item (plan
// §8/M05: Client approves plan -> content rows created, campaign =
// copy_pending_approval -> n8n -> Paperclip/MCP generates copy per platform
// -> THIS function, called once per content item -> content =
// waiting_copy_approval). Same "no end-user JWT, no human actor to resolve
// via resolveActor()" reasoning as every other n8n write-back endpoint in
// this schema — n8n authenticates by presenting the Supabase service-role
// key itself as its bearer credential, verified by
// `assertServiceRoleCaller()` (`./logic.ts`), which rejects with
// `AuthorizationError` (403) on a missing/malformed/non-matching
// Authorization header.
//
// Sequence: CORS preflight -> assertServiceRoleCaller -> validate body
// (Zod) -> one `.rpc('record_content_copy', ...)` call (NOT through
// `command.ts` — see `logic.ts`'s header comment for the RPC shape
// difference) -> map result/error -> respond. The full validate -> persist
// -> audit -> notify -> return sequence (plan §2.4) happens inside that one
// Postgres function
// (`supabase/migrations/20260915161500_approver_record_content_copy.sql`),
// exactly like every other command in this codebase.
//
// The request schema, the service-role-key check, and the error-mapping
// logic all live in `./logic.ts` rather than inline here, for the same
// `Deno.serve`-import-safety reason established across this codebase:
// importing this file from `deno test` would execute the `Deno.serve(...)`
// call below as a module side effect. See `logic.ts`/`logic_test.ts`.

import { CORS_HEADERS, handleCorsPreflight } from "../approver_shared/cors.ts";
import { errorResponse, successResponse } from "../approver_shared/response.ts";
import { createApproverServiceClient } from "../approver_shared/supabaseClient.ts";
import { parseJsonBody } from "../approver_shared/validation.ts";
import {
  assertServiceRoleCaller,
  mapRecordContentCopyError,
  recordContentCopySchema,
} from "./logic.ts";

Deno.serve(async (request: Request): Promise<Response> => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  try {
    assertServiceRoleCaller(request);

    const payload = await parseJsonBody(request, recordContentCopySchema);
    const client = createApproverServiceClient();

    const { data, error } = await client.rpc("record_content_copy", {
      p_content_id: payload.contentId,
      p_copy_payload: payload.copyPayload,
    });

    if (error) {
      throw mapRecordContentCopyError(error);
    }

    return successResponse(data, 200, CORS_HEADERS);
  } catch (error) {
    return errorResponse(error, CORS_HEADERS);
  }
});
