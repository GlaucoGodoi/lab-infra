// approver_request_content_copy_revision — US-025 (Request copy revision).
//
// Standard `command.ts` pattern (../approver_shared/command.ts) — same
// shape as `approver_request_campaign_plan_revision` (US-018), its
// campaign-level counterpart, and the sibling action to
// `approver_approve_content_copy` (US-024) on the same client-facing
// per-platform copy card. This function has a real client actor — the one
// clicking "request revision" in the UI — so it goes through the normal
// `resolveActor()` -> `dispatchCommand()` flow like every other business
// command.
//
// Everything past "who is calling, and is the body shape valid" is the
// backing `approver.request_content_copy_revision(...)` Postgres
// function's responsibility (authorization, payload re-validation, tenancy
// check, state-transition, revision_comment insert, audit — see
// `supabase/migrations/20260915151500_approver_request_content_copy_revision.sql`'s
// header comment).
//
// `allowedRoles: ['client']` here is only the coarse, defense-in-depth
// pre-check `command.ts` documents — the SQL function still re-checks
// `p_actor_role = 'client'` itself (AP002 otherwise) and is the actual
// authority.

import { z } from "zod";
import { type CommandDefinition, handleCommand } from "../approver_shared/command.ts";

const requestContentCopyRevisionSchema = z.object({
  contentId: z.string().uuid(),
  comment: z.string().min(1),
}).strict();

type RequestContentCopyRevisionPayload = z.infer<typeof requestContentCopyRevisionSchema>;

const definition: CommandDefinition<RequestContentCopyRevisionPayload> = {
  rpcName: "request_content_copy_revision",
  schema: requestContentCopyRevisionSchema,
  allowedRoles: ["client"],
};

Deno.serve((request: Request): Promise<Response> => handleCommand(request, definition));
