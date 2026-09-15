// approver_record_campaign_plan — US-066: Campaign plan generation
// workflow's backend write-back endpoint.
//
// DELIBERATE EXCEPTION to the US-065 `command.ts` one-RPC-call pattern —
// read this before touching this file.
//
// Every other business command in this repo is (and should be) invoked by
// an authenticated Angular user, resolved to an `Actor` via
// `resolveActor()` (US-064) and forwarded as the fixed 4-argument RPC shape
// `command.ts` defines. This function's caller is different in kind, not
// just degree: it's n8n, calling this endpoint directly once the Paperclip
// planning agent has produced a Markdown campaign plan for a `registered`
// campaign (plan's M03 n8n integration note: "Client -> Angular -> Edge
// Function -> campaign=registered -> n8n -> Paperclip/MCP -> campaign plan
// -> campaign=pending_initial_approve"). n8n has no end-user JWT to send —
// there is no human session behind this call at all — so `resolveActor()`
// cannot be used, and even if it could, `command.ts`'s fixed
// `p_actor_role: 'client' | 'admin'` shape has no slot for
// `approver.actor_type`'s third value, `'system'`, which is exactly what
// this automation-driven change should be attributed to.
//
// Authentication instead relies on the one identity n8n legitimately holds
// as a stored credential for exactly this kind of trusted backend-to-backend
// call: the Supabase service-role key itself (CLAUDE.md non-negotiable #1 —
// "the service-role key exists only inside Edge Functions and never for
// convenience," and this IS the trusted-backend-to-backend case it exists
// for). `assertServiceRoleCaller()` (`./logic.ts`) rejects with
// `AuthorizationError` (403) unless the request's `Authorization: Bearer
// <token>` header's token constant-time-equals
// `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`.
//
// Sequence: CORS preflight -> assertServiceRoleCaller -> validate body
// (Zod) -> one `.rpc('record_campaign_plan', ...)` call (NOT through
// `command.ts` — see `logic.ts`'s header comment for the RPC shape
// difference) -> map result/error -> respond. The full validate -> persist
// -> audit -> notify -> return sequence (plan §2.4) happens inside that one
// Postgres function
// (`supabase/migrations/20260914190816_approver_campaign_creation.sql`),
// exactly like every other command in this codebase — the only thing
// actually different here is how the caller's identity/authorization is
// established, not the transactional-command architecture itself.
//
// The request schema, the service-role-key check, and the error-mapping
// logic all live in `./logic.ts` rather than inline here, for the same
// `Deno.serve`-import-safety reason US-007 introduced the `logic.ts` split:
// importing this file from `deno test` would execute the `Deno.serve(...)`
// call below as a module side effect. See `logic.ts`/`logic_test.ts`.

import { CORS_HEADERS, handleCorsPreflight } from "../approver_shared/cors.ts";
import { errorResponse, successResponse } from "../approver_shared/response.ts";
import { createApproverServiceClient } from "../approver_shared/supabaseClient.ts";
import { parseJsonBody } from "../approver_shared/validation.ts";
import {
  assertServiceRoleCaller,
  mapRecordCampaignPlanError,
  recordCampaignPlanSchema,
} from "./logic.ts";

Deno.serve(async (request: Request): Promise<Response> => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  try {
    assertServiceRoleCaller(request);

    const payload = await parseJsonBody(request, recordCampaignPlanSchema);
    const client = createApproverServiceClient();

    const { data, error } = await client.rpc("record_campaign_plan", {
      p_campaign_id: payload.campaignId,
      p_content_markdown: payload.contentMarkdown,
    });

    if (error) {
      throw mapRecordCampaignPlanError(error);
    }

    return successResponse(data, 200, CORS_HEADERS);
  } catch (error) {
    return errorResponse(error, CORS_HEADERS);
  }
});
