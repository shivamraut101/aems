import { adminClient, authorize, json } from "../_shared/client.ts";

/**
 * Screenshot worker — validation, metadata repair and timeline linkage.
 *
 * Two jobs the ingestion path deliberately does not do inline, because neither is
 * worth making an agent wait on:
 *
 *  1. Orphan sweep: uploads that stored a binary but failed to write their row.
 *  2. Session linkage: attaching captures to the work session that was open when
 *     they were taken, so the timeline can group them.
 */
Deno.serve(async (request: Request) => {
  const denied = authorize(request);
  if (denied) return denied;

  const supabase = adminClient();

  // -- link captures to the session that was open at the time ---------------
  const { data: unlinked, error: unlinkedError } = await supabase
    .from("screenshots")
    .select("id, device_id, captured_at")
    .is("work_session_id", null)
    .limit(500);

  if (unlinkedError) {
    return json({ error: unlinkedError.message }, 500);
  }

  let linked = 0;

  for (const shot of unlinked ?? []) {
    const { data: session } = await supabase
      .from("work_sessions")
      .select("id")
      .eq("device_id", shot.device_id)
      .lte("clock_in_at", shot.captured_at)
      .or(`clock_out_at.gte.${shot.captured_at},clock_out_at.is.null`)
      .order("clock_in_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (session) {
      await supabase
        .from("screenshots")
        .update({ work_session_id: session.id })
        .eq("id", shot.id);
      linked += 1;
    }
  }

  // -- sweep stored objects with no matching row ----------------------------
  const { data: objects } = await supabase.storage.from("aems").list("", { limit: 1000 });
  let orphans = 0;

  for (const object of objects ?? []) {
    if (!object.name.includes("/screenshots/")) continue;

    const { data: row } = await supabase
      .from("screenshots")
      .select("id")
      .eq("storage_path", object.name)
      .maybeSingle();

    if (!row) {
      await supabase.storage.from("aems").remove([object.name]);
      orphans += 1;
    }
  }

  return json({ linked, orphansRemoved: orphans });
});
