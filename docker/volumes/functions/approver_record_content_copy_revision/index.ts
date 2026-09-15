// approver_record_content_copy_revision — US-069: Copy revision workflow's
// backend write-back endpoint. Also covers US-027 (Regenerate copy) — see
// `./logic.ts` and the backing migration's header comment for why one
// endpoint covers both.
//
// DELIBERATE EXCEPTION to the US-065 `command.ts` one-RPC-call pattern —
// sibling of `approver_record_content_copy` (US-068) and
// `approver_record_campaign_plan_revision` (US-067). Read either of those
// files' header comments first if this one is unfamiliar; only the deltas
// are re-explained here.
//
// This function's caller is n8n, once the copy-revision workflow (fired by
// `approver.notify_content_copy_revision_requested()`,
// `supabase/migrations/20260915163000_approver_content_copy_revision_trigger.sql`)
// has had the Paperclip copy agent produce revised copy for a content item
// currently in `pending_copy_review` (plan §8/M05: Client ->
// `approver_request_content_copy_revision` -> content=pending_copy_review
// -> n8n -> Paperclip/MCP -> revised copy -> THIS function ->
// content=waiting_copy_approval). Same "no end-user JWT, no human actor to
// resolve via resolveActor()" reasoning as every other n8n write-back
// endpoint — n8n authenticates by presenting the Supabase service-role key
// itself as its bearer credential, verified by `assertServiceRoleCaller()`
// (`./logic.ts`).
//
// Sequence: CORS preflight -> assertServiceRoleCaller -> validate body
// (Zod) -> one `.rpc('record_content_copy_revision', ...)` call (NOT
// through `command.ts`) -> map result/error -> respond. The full validate
// -> persist -> audit -> notify -> return sequence (plan §2.4) happens
// inside that one Postgres function
// (`supabase/migrations/20260915164500_approver_record_content_copy_revision.sql`).
//
// The request schema, the service-role-key check, and the error-mapping
// logic all live in `./logic.ts` rather than inline here, for the same
// `Deno.serve`-import-safety reason established across this codebase.

import { CORS_HEADERS, handleCorsPreflight } from "../approver_shared/cors.ts";
import { errorResponse, successResponse } from "../approver_shared/response.ts";
import { createApproverServiceClient } from "../approver_shared/supabaseClient.ts";
import { parseJsonBody } from "../approver_shared/validation.ts";
import {
  assertServiceRoleCaller,
  mapRecordContentCopyRevisionError,
  recordContentCopyRevisionSchema,
} from "./logic.ts";

Deno.serve(async (request: Request): Promise<Response> => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  try {
    assertServiceRoleCaller(request);

    const payload = await parseJsonBody(request, recordContentCopyRevisionSchema);
    const client = createApproverServiceClient();

    const { data, error } = await client.rpc("record_content_copy_revision", {
      p_content_id: payload.contentId,
      p_copy_payload: payload.copyPayload,
      p_revision_comment_id: payload.revisionCommentId,
      p_agent_response_text: payload.agentResponseText ?? null,
    });

    if (error) {
      throw mapRecordContentCopyRevisionError(error);
    }

    return successResponse(data, 200, CORS_HEADERS);
  } catch (error) {
    return errorResponse(error, CORS_HEADERS);
  }
});
