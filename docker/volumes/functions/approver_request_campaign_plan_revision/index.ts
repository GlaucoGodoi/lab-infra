// approver_request_campaign_plan_revision — US-018 (Request plan revision).
//
// Standard `command.ts` pattern (../approver_shared/command.ts) — same shape
// as `approver_approve_campaign_plan` (US-017), its sibling action on the
// same client-facing plan-review screen. Contrast with
// `approver_record_campaign_plan`, which is a DELIBERATE exception to this
// pattern (n8n calls it directly, authenticated with the service-role key
// itself, with no human actor to resolve). This function has a real client
// actor — the one clicking "request revision" in the UI — so it goes through
// the normal `resolveActor()` -> `dispatchCommand()` flow like every other
// business command.
//
// Everything past "who is calling, and is the body shape valid" is the
// backing `approver.request_campaign_plan_revision(...)` Postgres function's
// responsibility (authorization, payload re-validation, tenancy check,
// state-transition, revision_comment insert, audit — see
// `supabase/migrations/20260915074113_approver_request_campaign_plan_revision.sql`'s
// header comment).
//
// `allowedRoles: ['client']` here is only the coarse, defense-in-depth
// pre-check `command.ts` documents — the SQL function still re-checks
// `p_actor_role = 'client'` itself (AP002 otherwise) and is the actual
// authority.

import { z } from "zod";
import { type CommandDefinition, handleCommand } from "../approver_shared/command.ts";

const requestCampaignPlanRevisionSchema = z.object({
  campaignId: z.string().uuid(),
  comment: z.string().min(1),
}).strict();

type RequestCampaignPlanRevisionPayload = z.infer<typeof requestCampaignPlanRevisionSchema>;

const definition: CommandDefinition<RequestCampaignPlanRevisionPayload> = {
  rpcName: "request_campaign_plan_revision",
  schema: requestCampaignPlanRevisionSchema,
  allowedRoles: ["client"],
};

Deno.serve((request: Request): Promise<Response> => handleCommand(request, definition));
