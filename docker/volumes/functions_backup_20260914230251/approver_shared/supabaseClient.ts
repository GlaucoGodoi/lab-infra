// Factory for the privileged, service-role Supabase client Edge Functions
// use to legitimately bypass RLS (CLAUDE.md non-negotiable #1: the
// service-role key exists only inside Edge Functions, never for
// convenience, and is never used as a shortcut for normal user-data access
// — it is used here because an Edge Function, after US-064 performs its own
// actor/authorization check, *is* the trusted context RLS is designed to be
// bypassed from).
//
// Scoped to schema `approver` via `db.schema` so callers never need to
// qualify table names, and can never accidentally reach into `public` or
// `storage` through this client.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleKey, getSupabaseUrl } from "./env.ts";

const APPROVER_SCHEMA = "approver";

// No generated Database type exists yet for this project (no committed
// `mcp__supabase__generate_typescript_types` output). Once one is added
// under approver_shared, replace `any` below with
// `SupabaseClient<Database, "approver">` for full column/table typing.
// deno-lint-ignore no-explicit-any
export type ApproverServiceClient = SupabaseClient<any, "approver">;

export function createApproverServiceClient(): ApproverServiceClient {
  return createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
    db: { schema: APPROVER_SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
