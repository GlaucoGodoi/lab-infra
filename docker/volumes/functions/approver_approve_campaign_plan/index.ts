// approver_approve_campaign_plan — US-017 (Approve plan).
//
// Standard `command.ts` pattern (../approver_shared/command.ts) — same shape
// as `approver_create_campaign`. Contrast with `approver_record_campaign_plan`,
// which is a DELIBERATE exception to this pattern (n8n calls it directly,
// authenticated with the service-role key itself, with no human actor to
// resolve into an Actor via resolveActor()). This function has a real
// client actor — the one clicking "approve" in the UI — so it goes through
// the normal `resolveActor()` -> `dispatchCommand()` flow like every other
// business command.
//
// Everything past "who is calling, and is the body shape valid" is the
// backing `approver.approve_campaign_plan(...)` Postgres function's
// responsibility (authorization, payload re-validation, tenancy check,
// state-transition, audit — see
// `supabase/migrations/20260915120000_approver_approve_campaign_plan.sql`'s
// header comment).
//
// `allowedRoles: ['client']` here is only the coarse, defense-in-depth
// pre-check `command.ts` documents — the SQL function still re-checks
// `p_actor_role = 'client'` itself (AP002 otherwise) and is the actual
// authority.

import { z } from "zod";
import { type CommandDefinition, handleCommand } from "../approver_shared/command.ts";

const approveCampaignPlanSchema = z.object({
  campaignId: z.string().uuid(),
}).strict();

type ApproveCampaignPlanPayload = z.infer<typeof approveCampaignPlanSchema>;

const definition: CommandDefinition<ApproveCampaignPlanPayload> = {
  rpcName: "approve_campaign_plan",
  schema: approveCampaignPlanSchema,
  allowedRoles: ["client"],
};

Deno.serve((request: Request): Promise<Response> => handleCommand(request, definition));
