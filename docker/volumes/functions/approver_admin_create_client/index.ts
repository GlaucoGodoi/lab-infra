// approver_admin_create_client — US-006: Client entity.
//
// The first real business command built on the US-065 `handleCommand()`
// harness (`../approver_shared/command.ts`). This function is deliberately
// thin: everything past "who is calling, and is the body shape valid" is the
// backing `approver.admin_create_client(...)` Postgres function's
// responsibility (authorization, payload re-validation, persistence, audit —
// see that migration's header comment,
// `supabase/migrations/20260914101119_approver_admin_create_client.sql`).
//
// `allowedRoles: ['admin']` here is only the coarse, defense-in-depth
// pre-check `command.ts` documents — the SQL function still re-checks
// `p_actor_role = 'admin'` itself (AP002 otherwise) and is the actual
// authority.

import { z } from "zod";
import { type CommandDefinition, handleCommand } from "../approver_shared/command.ts";

const adminCreateClientSchema = z.object({
  name: z.string().min(1),
}).strict();

type AdminCreateClientPayload = z.infer<typeof adminCreateClientSchema>;

const definition: CommandDefinition<AdminCreateClientPayload> = {
  rpcName: "admin_create_client",
  schema: adminCreateClientSchema,
  allowedRoles: ["admin"],
  successStatus: 201,
};

Deno.serve((request: Request): Promise<Response> => handleCommand(request, definition));
