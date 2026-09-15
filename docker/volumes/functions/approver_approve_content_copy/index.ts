// approver_approve_content_copy — US-024 (Approve copy).
//
// Standard `command.ts` pattern (../approver_shared/command.ts) — same
// shape as `approver_approve_campaign_plan` (US-017), its campaign-level
// counterpart. This function has a real client actor — the one clicking
// "approve" on a specific platform's copy card — so it goes through the
// normal `resolveActor()` -> `dispatchCommand()` flow like every other
// business command. Contrast with `approver_record_content_copy`, which is
// a DELIBERATE exception to this pattern (n8n calls it directly,
// authenticated with the service-role key itself, with no human actor to
// resolve).
//
// Everything past "who is calling, and is the body shape valid" is the
// backing `approver.approve_content_copy(...)` Postgres function's
// responsibility (authorization, payload re-validation, tenancy check,
// state-transition, audit — see
// `supabase/migrations/20260915150000_approver_approve_content_copy.sql`'s
// header comment).
//
// `allowedRoles: ['client']` here is only the coarse, defense-in-depth
// pre-check `command.ts` documents — the SQL function still re-checks
// `p_actor_role = 'client'` itself (AP002 otherwise) and is the actual
// authority.

import { z } from "zod";
import { type CommandDefinition, handleCommand } from "../approver_shared/command.ts";

const approveContentCopySchema = z.object({
  contentId: z.string().uuid(),
}).strict();

type ApproveContentCopyPayload = z.infer<typeof approveContentCopySchema>;

const definition: CommandDefinition<ApproveContentCopyPayload> = {
  rpcName: "approve_content_copy",
  schema: approveContentCopySchema,
  allowedRoles: ["client"],
};

Deno.serve((request: Request): Promise<Response> => handleCommand(request, definition));
