// approver_create_campaign — US-013 (Create campaign request) / US-014
// (Campaign attachments).
//
// Standard `command.ts` pattern (../approver_shared/command.ts) — same
// shape as `approver_admin_create_client`. Everything past "who is calling,
// and is the body shape valid" is the backing
// `approver.create_campaign(...)` Postgres function's responsibility
// (authorization, payload re-validation, the attachment existence/
// ownership re-check against `storage.objects`, persistence, audit — see
// `supabase/migrations/20260914190816_approver_campaign_creation.sql`'s
// header comment).
//
// `allowedRoles: ['client']` here is only the coarse, defense-in-depth
// pre-check `command.ts` documents — the SQL function still re-checks
// `p_actor_role = 'client'` itself (AP002 otherwise) and is the actual
// authority.
//
// Attachment upload flow this function assumes (approved design, US-014):
// the client uploads attachment bytes DIRECTLY to the `campaign-attachments`
// Storage bucket first, under its own session, to
// `{clientId}/{uploadId}/{fileName}` (`uploadId` a client-generated UUID —
// see the migration's header comment for why this differs from US-061's
// original `{clientId}/{campaignId}/{filename}` description: no campaign
// exists yet at upload time). Only once every upload has succeeded does the
// client call this function with the resulting storage references in
// `attachments` — file bytes never pass through this Edge Function.

import { z } from "zod";
import { type CommandDefinition, handleCommand } from "../approver_shared/command.ts";

const PLATFORMS = ["instagram", "facebook", "linkedin", "twitter_x"] as const;

const campaignAttachmentSchema = z.object({
  storageBucket: z.string().min(1),
  storagePath: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
}).strict();

const createCampaignSchema = z.object({
  product: z.string().min(1),
  productAttributes: z.array(z.string().min(1)).default([]),
  objectives: z.string().min(1),
  selectedPlatforms: z.array(z.enum(PLATFORMS)).min(1),
  attachments: z.array(campaignAttachmentSchema).default([]),
}).strict();

type CreateCampaignPayload = z.infer<typeof createCampaignSchema>;

const definition: CommandDefinition<CreateCampaignPayload> = {
  rpcName: "create_campaign",
  schema: createCampaignSchema,
  allowedRoles: ["client"],
  successStatus: 201,
};

Deno.serve((request: Request): Promise<Response> => handleCommand(request, definition));
