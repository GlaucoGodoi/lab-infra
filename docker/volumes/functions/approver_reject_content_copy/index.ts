// approver_reject_content_copy — US-026 (Reject copy).
//
// Standard `command.ts` pattern (../approver_shared/command.ts) — same
// shape as `approver_approve_content_copy` (US-024) and
// `approver_request_content_copy_revision` (US-025), its siblings on the
// same client-facing per-platform copy-review card. This function has a
// real client actor — the one clicking "reject" in the UI — so it goes
// through the normal `resolveActor()` -> `dispatchCommand()` flow like
// every other business command.
//
// Everything past "who is calling, and is the body shape valid" is the
// backing `approver.reject_content_copy(...)` Postgres function's
// responsibility (authorization, payload re-validation, tenancy check,
// state-transition, audit — see
// `supabase/migrations/20260915153000_approver_reject_content_copy.sql`'s
// header comment).
//
// `allowedRoles: ['client']` here is only the coarse, defense-in-depth
// pre-check `command.ts` documents — the SQL function still re-checks
// `p_actor_role = 'client'` itself (AP002 otherwise) and is the actual
// authority.
//
// Payload is `{ contentId }` only — same as approve_content_copy, NOT
// request_content_copy_revision. Rejecting copy carries no free-text
// comment; only a revision request requires one.

import { z } from "zod";
import { type CommandDefinition, handleCommand } from "../approver_shared/command.ts";

const rejectContentCopySchema = z.object({
  contentId: z.string().uuid(),
}).strict();

type RejectContentCopyPayload = z.infer<typeof rejectContentCopySchema>;

const definition: CommandDefinition<RejectContentCopyPayload> = {
  rpcName: "reject_content_copy",
  schema: rejectContentCopySchema,
  allowedRoles: ["client"],
};

Deno.serve((request: Request): Promise<Response> => handleCommand(request, definition));
