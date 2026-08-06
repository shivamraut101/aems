import { adminClient, authorize, json } from "../_shared/client.ts";

/** Captures one drain may link. Oldest first, so a backlog empties in order. */
const LINK_BATCH = 500;

/**
 * Candidate sessions one drain may read.
 *
 * Overflowing this leaves the affected captures unlinked for the next run rather
 * than mislinking them: a device's sessions do not overlap, so at most one can ever
 * qualify for a capture and a missing candidate means "no link yet", never "the
 * wrong link".
 */
const SESSION_LOOKUP_LIMIT = 2000;

interface SessionRow {
  id: number;
  device_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
}

/**
 * Screenshot worker — validation, metadata repair and timeline linkage.
 *
 * Two jobs the ingestion path deliberately does not do inline, because neither is
 * worth making an agent wait on:
 *
 *  1. Orphan sweep: uploads that stored a binary but failed to write their row.
 *  2. Session linkage: attaching captures to the work session that was open when
 *     they were taken, so the timeline can group them.
 *
 * Both are set operations. Neither reads one row at a time: an earlier version ran
 * a select and an update per capture, and a select per stored object, so a full
 * drain cost up to ~2,000 sequential round trips to answer two questions. It is
 * now six plus one write per work session the batch actually touches.
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
    // Oldest first: a deterministic drain order, and it makes the window below the
    // tightest one the backlog allows.
    .order("captured_at", { ascending: true })
    .limit(LINK_BATCH);

  if (unlinkedError) {
    return json({ error: unlinkedError.message }, 500);
  }

  const shots = (unlinked ?? []) as { id: number; device_id: string; captured_at: string }[];
  let linked = 0;

  if (shots.length > 0) {
    const windowStart = shots[0].captured_at;
    const windowEnd = shots[shots.length - 1].captured_at;

    // One query for every candidate session. The filter is the union of the
    // per-capture filters it replaces — any session that could match some capture
    // in the batch opened no later than the last one and closed no earlier than
    // the first — so nothing the row-at-a-time version would have found is missed.
    //
    // Newest first, so the first match below is the most recently opened session:
    // precisely what `order(clock_in_at desc).limit(1)` returned per capture.
    const { data: sessions } = await supabase
      .from("work_sessions")
      .select("id, device_id, clock_in_at, clock_out_at")
      .in("device_id", [...new Set(shots.map((shot) => shot.device_id))])
      .lte("clock_in_at", windowEnd)
      .or(`clock_out_at.gte.${windowStart},clock_out_at.is.null`)
      .order("clock_in_at", { ascending: false })
      .limit(SESSION_LOOKUP_LIMIT);

    const candidates = (sessions ?? []) as SessionRow[];

    // Grouped by session, because one statement can set one value: the writes are
    // one per session the batch touches rather than one per capture. A linear scan
    // per capture is deliberate — the batch caps this at 500 x 2000 comparisons,
    // which costs less than the round trip an index would save.
    const bySession = new Map<number, number[]>();

    for (const shot of shots) {
      const at = Date.parse(shot.captured_at);
      const match = candidates.find(
        (session) =>
          session.device_id === shot.device_id &&
          Date.parse(session.clock_in_at) <= at &&
          (!session.clock_out_at || Date.parse(session.clock_out_at) >= at),
      );

      if (!match) continue;
      const ids = bySession.get(match.id);
      if (ids) ids.push(shot.id);
      else bySession.set(match.id, [shot.id]);
    }

    for (const [sessionId, ids] of bySession) {
      const { error } = await supabase
        .from("screenshots")
        .update({ work_session_id: sessionId })
        .in("id", ids);

      // Counted on confirmation. The previous version incremented before the write
      // was acknowledged, so a failed update still reported itself as linked.
      if (!error) linked += ids.length;
    }
  }

  // -- sweep stored objects with no matching row ----------------------------
  const { data: objects } = await supabase.storage.from("aems").list("", { limit: 1000 });

  // NOTE: Storage `list` is not recursive. A listing of the root prefix returns
  // company-id folder entries, whose names contain no slash, so this filter matches
  // nothing as written and the sweep is inert. Left that way on purpose — walking
  // the tree would make this function start deleting stored objects, which is a
  // behaviour change to argue for on its own, not something to slip in behind a
  // query fix. The shape below is fixed regardless, so it is one lookup and one
  // delete if the traversal is ever corrected.
  const objectNames = (objects ?? [])
    .map((object) => object.name)
    .filter((name) => name.includes("/screenshots/"));

  let orphans = 0;

  if (objectNames.length > 0) {
    const { data: known } = await supabase
      .from("screenshots")
      .select("storage_path")
      .in("storage_path", objectNames);

    const stored = new Set(
      ((known ?? []) as { storage_path: string }[]).map((row) => row.storage_path),
    );
    const missing = objectNames.filter((name) => !stored.has(name));

    if (missing.length > 0) {
      await supabase.storage.from("aems").remove(missing);
      orphans = missing.length;
    }
  }

  return json({ linked, orphansRemoved: orphans });
});
