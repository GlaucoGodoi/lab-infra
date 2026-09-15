// approver_admin_create_client_user — US-007: Client-user association.
//
// DELIBERATE EXCEPTION to the US-065 `command.ts` one-RPC-call pattern —
// read this before touching this file.
//
// Every other business command in this repo is (and should be) backed by
// exactly one Postgres function invoked through `handleCommand()`, so
// Postgres's own transaction semantics make the whole validate -> authorize
// -> precondition -> persist -> audit -> notify -> return sequence (plan
// §2.4) atomic for free. That pattern cannot work here: creating the
// `auth.users` row itself must go through Supabase's Auth Admin API
// (`supabase.auth.admin.createUser()`), which is an HTTP call to GoTrue, not
// something a single `plpgsql` function invoked via PostgREST `.rpc()` can
// do — there is no SQL statement that creates a GoTrue-managed user. So this
// function talks to the service-role client directly (`resolveActor`,
// `requireRole`, `parseJsonBody`, `errorResponse`/`successResponse`, the
// shared error vocabulary) instead of `handleCommand()`/`dispatchCommand()`.
//
// Why this is still safe without a wrapping SQL transaction: the US-060
// `provision_user_profile_from_auth()` trigger (`AFTER INSERT ON
// auth.users`, see `20260913163626_approver_auth_user_mapping.sql` — NOT
// modified by this story, already applied, forward-only) runs *inside the
// same transaction* GoTrue's own `INSERT INTO auth.users` uses to create the
// row. If two concurrent admin calls race to create a client-role user for
// the same client, the trigger's `user_profile_one_client_user` unique index
// violation on the second insert rolls back that whole `auth.users` insert
// too — ordinary Postgres trigger/transaction semantics already guarantee
// "at most one client-role user per client" even though this function issues
// two separate network calls (the pre-check below, then `createUser()`)
// rather than one atomic RPC. The pre-check (`assertClientExistsAndHasNoUser`,
// in `logic.ts`) exists purely to turn the *expected*, checkable-in-advance
// case into a clean 409 instead of letting a rare race fall through as a raw
// Postgres constraint violation surfaced by GoTrue.
//
// Sequence: resolveActor -> requireRole('admin') -> validate body -> verify
// the target client exists and has no client-role user yet -> createUser()
// -> record_audit() (the reusable US-065 helper, called standalone via
// `.rpc()` — it doesn't require going through command.ts) -> return.
//
// The request schema, precondition check, and error-mapping logic live in
// `./logic.ts` rather than inline here, specifically so `logic_test.ts` can
// unit test them without importing this file — importing this file would
// execute the `Deno.serve(...)` call below as a module side effect (the same
// mechanism the self-hosted edge-runtime relies on to dispatch a request to
// this function), which would attempt to bind a real HTTP listener under
// `deno test`. See `logic.ts`'s header comment.
//
// Testing note (see supabase/functions/README.md for the fuller writeup):
// the live `auth.admin.createUser()` HTTP call itself is not unit tested,
// same accepted test-coverage boundary already documented for
// `resolveActor()`'s live network path — there is no local Supabase stack
// for this project. `supabase/tests/us007_admin_create_client_user_trigger.sql`
// separately proves the race-safety mechanism this header describes (the
// US-060 trigger firing inside the same transaction as a simulated
// `auth.users` insert) at the SQL level — it does not call the live Admin
// API either.

import { CORS_HEADERS, handleCorsPreflight } from "../approver_shared/cors.ts";
import { errorResponse, successResponse } from "../approver_shared/response.ts";
import { requireRole, resolveActor } from "../approver_shared/actor.ts";
import { createApproverServiceClient } from "../approver_shared/supabaseClient.ts";
import { parseJsonBody } from "../approver_shared/validation.ts";
import {
  adminCreateClientUserSchema,
  assertClientExistsAndHasNoUser,
  type ClientLookupClient,
  mapAuthAdminError,
} from "./logic.ts";

Deno.serve(async (request: Request): Promise<Response> => {
  const preflight = handleCorsPreflight(request);
  if (preflight) return preflight;

  try {
    const actor = await resolveActor(request);
    requireRole(actor, "admin");

    const payload = await parseJsonBody(request, adminCreateClientUserSchema);
    const client = createApproverServiceClient();

    // Narrowing cast, same rationale as command.ts's
    // `createApproverCommandClient()`: no generated `Database` type exists
    // yet for this project, so the real service-role client's `.from(...)`
    // chain resolves to a deep, PostgREST-specific thenable-builder type
    // (not a literal `Promise`) that TypeScript cannot structurally compare
    // against `ClientLookupClient` without exceeding its instantiation
    // depth. The cast only narrows the surface this module is allowed to
    // call; it does not change what the real client does, and every method
    // this module actually calls (`.from().select().eq().maybeSingle()`)
    // resolves to the same `{ data, error }` shape when awaited, matching
    // `ClientLookupClient`'s contract.
    // deno-lint-ignore no-explicit-any
    await assertClientExistsAndHasNoUser(client as any as ClientLookupClient, payload.clientId);

    const { data: created, error: createError } = await client.auth.admin.createUser({
      email: payload.email,
      password: payload.password,
      email_confirm: true, // Deliberate: no email-delivery/confirmation-link
      // flow exists yet (a later, separate story) — skipping confirmation
      // here would otherwise leave a newly created client user with nowhere
      // to click to confirm.
      user_metadata: {
        approver_role: "client",
        approver_client_id: payload.clientId,
        approver_display_name: payload.displayName,
      },
    });

    if (createError || !created?.user) {
      throw mapAuthAdminError(createError);
    }

    const newUserId: string = created.user.id;

    const { error: auditError } = await client.rpc("record_audit", {
      p_client_id: payload.clientId,
      p_actor_type: "admin_user",
      p_actor_user_id: actor.userId,
      p_subject_type: "user_profile",
      p_subject_id: newUserId,
      p_action: "client_user_created",
      p_new_state: {
        email: payload.email,
        clientId: payload.clientId,
        displayName: payload.displayName,
      },
    });
    if (auditError) {
      // The auth.users row (and its US-060-provisioned user_profile) already
      // exists at this point — an audit-write failure is a real operational
      // problem worth surfacing loudly server-side, but it must not make
      // this endpoint report the user creation itself as failed (it
      // succeeded) or attempt to compensate/delete what GoTrue already
      // committed.
      console.error(
        "approver_admin_create_client_user: record_audit failed after a successful createUser:",
        auditError,
      );
    }

    return successResponse(
      {
        id: newUserId,
        email: payload.email,
        clientId: payload.clientId,
        displayName: payload.displayName,
      },
      201,
      CORS_HEADERS,
    );
  } catch (error) {
    return errorResponse(error, CORS_HEADERS);
  }
});
