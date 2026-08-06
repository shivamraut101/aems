import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DaySpan } from "../shared/types/index.js";

/**
 * The filesystem surface the durable store needs.
 *
 * Injected rather than imported so the whole store — atomic publish, corrupt-file
 * quarantine, the on-disk cap — is exercisable against an in-memory fake. The same
 * reason `Capturer` and `SystemIdleSource` are interfaces: a test of a crash-recovery
 * rule must not depend on a real directory being writable, and must never leave one
 * behind.
 *
 * Synchronous on purpose. Every call site here writes a few kilobytes on a path that
 * must not interleave with another write of the same file, and an async queue to
 * serialise them would be a lock reimplemented badly.
 */
export interface DurableFs {
  /** Null when the file does not exist. Anything else is a real fault and throws. */
  read(path: string): string | null;
  write(path: string, contents: string): void;
  append(path: string, contents: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export interface StoreOptions {
  /** Told what was thrown away and why. Silent data loss is the failure being avoided. */
  log?: (message: string, error?: unknown) => void;
}

/**
 * One JSON document, published by rename.
 *
 * A monitoring agent is killed by a forced reboot, a battery running out and the task
 * manager, none of which flush a partial write. Writing in place would leave a
 * truncated document at the real path; rename within one directory is atomic on both
 * NTFS and APFS, so a reader sees either the previous document or the new one.
 */
export class JsonFile {
  private readonly temp: string;
  private readonly corrupt: string;

  constructor(
    private readonly fs: DurableFs,
    private readonly path: string,
    private readonly options: StoreOptions = {},
  ) {
    this.temp = `${path}.tmp`;
    this.corrupt = `${path}.corrupt`;
  }

  /**
   * Returns null for "nothing usable here", never throws.
   *
   * An unreadable state file must cost the agent its restored state, not its launch:
   * throwing on boot would turn one bad byte into a machine that stops collecting
   * entirely, which is the failure mode this whole module exists to prevent.
   */
  read(): unknown {
    const raw = this.fs.read(this.path);
    if (raw === null) return null;

    try {
      return JSON.parse(raw);
    } catch (error) {
      this.quarantine(error);
      return null;
    }
  }

  /**
   * Moves the unreadable file aside instead of deleting it.
   *
   * Deleting would erase the only evidence of what was lost; leaving it in place would
   * fail identically on every later launch. One overwritten `.corrupt` file bounds the
   * cost either way.
   */
  private quarantine(error: unknown): void {
    this.options.log?.(`Discarded an unreadable state file at ${this.path}`, error);
    try {
      this.fs.rename(this.path, this.corrupt);
    } catch {
      // A directory that cannot be renamed within is already broken beyond what this
      // module can repair; the caller still gets its null and boots.
      this.fs.remove(this.path);
    }
  }

  write(value: unknown): void {
    this.fs.write(this.temp, JSON.stringify(value));
    this.fs.rename(this.temp, this.path);
  }
}

/** The three event kinds that fit in a JSON log. Screenshots are bytes, not records. */
export type JournalKind = "activity" | "idle" | "breaks";

/** All the journal knows about an event: enough to remove it once the server has it. */
export interface JournalEvent {
  clientEventId: string;
}

export interface RestoredEvents {
  activity: JournalEvent[];
  idle: JournalEvent[];
  breaks: JournalEvent[];
  /** How many of the oldest records the on-disk cap shed. Reported, never silent. */
  dropped: number;
}

/** One line of the log: an observation, or an acknowledgement that removes earlier ones. */
type JournalLine =
  | { k: JournalKind; e: JournalEvent }
  | { r: string[] };

interface JournalRecord {
  kind: JournalKind;
  event: JournalEvent;
}

export interface JournalOptions extends StoreOptions {
  /** Ceiling across all three kinds. Bounds the file, not just the heap. */
  maxRecords?: number;
  /** Told how many of the oldest records the ceiling shed, so the gap is explainable. */
  onDrop?: (dropped: number) => void;
  /** Line count past which the log is rewritten with only what is still pending. */
  compactAfterLines?: number;
}

/**
 * Three kinds at the queue's own 20 000-per-kind ceiling.
 *
 * Chosen to sit just above what `SyncQueue` will hold, so the disk cap is a backstop
 * against a log that outlives the process rather than a second, tighter limit that
 * would silently discard events the queue still believes it has.
 */
const DEFAULT_MAX_JOURNAL_RECORDS = 60_000;

/**
 * Roughly an hour of appends before the log is rewritten.
 *
 * A confirmed event leaves both its own line and a tombstone behind, so a log that is
 * never rewritten grows for as long as the agent runs — weeks, on a machine that is
 * only ever suspended. Rewriting costs one pass over a file that is, by construction,
 * mostly dead lines.
 */
const DEFAULT_COMPACT_AFTER_LINES = 2_048;

/**
 * The pending-event backlog, on disk.
 *
 * Append-only NDJSON rather than a rewritten document, because the write happens on
 * the observation path: rewriting a full backlog on every observed interval would be
 * megabytes of disk churn a minute on a laptop the employee is trying to work on.
 * Appending one line is O(1), and a line torn by a power cut fails to parse and is
 * skipped, costing that one event rather than the file.
 *
 * The rule the whole class exists for: an event is on disk *before* the network call
 * that would send it, and leaves only once the API has confirmed it. A crash mid-flush
 * therefore replays — safely, because every event carries a stable `clientEventId` and
 * the API upserts on `(device_id, client_event_id)`.
 */
export class EventJournal {
  /** Ids still pending. Ids only: holding the events too would double the buffer's cost. */
  private readonly live = new Set<string>();
  private lines = 0;
  private readonly maxRecords: number;
  private readonly compactAfterLines: number;

  constructor(
    private readonly fs: DurableFs,
    private readonly path: string,
    private readonly options: JournalOptions = {},
  ) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_JOURNAL_RECORDS;
    this.compactAfterLines = options.compactAfterLines ?? DEFAULT_COMPACT_AFTER_LINES;
  }

  /** Everything the API has not confirmed, in the order it was observed. */
  restore(): RestoredEvents {
    const replayed = this.replay();
    const restored: RestoredEvents = { activity: [], idle: [], breaks: [], dropped: 0 };

    // A file written under a larger ceiling — or by a build before this one existed —
    // is trimmed here rather than being loaded whole into the heap it is meant to bound.
    const shed = this.shed(replayed.records);
    if (shed > 0) {
      restored.dropped = shed;
      this.rewrite(replayed.records);
    }

    this.live.clear();
    for (const [id, record] of replayed.records) {
      this.live.add(id);
      restored[record.kind].push(record.event);
    }

    return restored;
  }

  append(kind: JournalKind, event: JournalEvent): void {
    this.writeLine({ k: kind, e: event });
    this.live.add(event.clientEventId);

    if (this.live.size > this.maxRecords) this.compact();
  }

  /**
   * Rewrites the log with only the surviving records, shedding past the ceiling.
   *
   * Also what keeps the file from growing without bound while online: every confirmed
   * event leaves a tombstone line behind, so a log that is never rewritten is a log
   * that only grows.
   */
  private compact(): void {
    const { records } = this.replay();
    const shed = this.shed(records);

    this.rewrite(records);

    this.live.clear();
    for (const id of records.keys()) this.live.add(id);

    if (shed > 0) this.options.onDrop?.(shed);
  }

  /** Drops the oldest records past the ceiling, returning how many went. */
  private shed(records: Map<string, JournalRecord>): number {
    const excess = records.size - this.maxRecords;
    if (excess <= 0) return 0;

    // Insertion order is append order, so the first keys are the oldest observations.
    for (const id of [...records.keys()].slice(0, excess)) records.delete(id);
    this.options.log?.(
      `Dropped ${excess} of the oldest pending event(s) to stay within the disk cap`,
    );

    return excess;
  }

  /** Republished by rename, so a crash mid-compaction leaves the previous log intact. */
  private rewrite(records: Map<string, JournalRecord>): void {
    const temp = `${this.path}.tmp`;
    const body = [...records.values()]
      .map((record) => `${JSON.stringify({ k: record.kind, e: record.event })}\n`)
      .join("");

    this.fs.write(temp, body);
    this.fs.rename(temp, this.path);
    this.lines = records.size;
  }

  /**
   * Forgets ids: confirmed by the API, or evicted by the in-memory ceiling.
   *
   * Written as a tombstone line rather than by rewriting the log, so the common path
   * stays a single append. Compaction folds the tombstones away later.
   */
  remove(ids: readonly string[]): void {
    const forgotten = ids.filter((id) => this.live.delete(id));
    if (forgotten.length === 0) return;

    this.writeLine({ r: forgotten });
    if (this.lines > this.compactAfterLines) this.compact();
  }

  /**
   * Deletes the log outright.
   *
   * The revocation path: a tombstone-per-id rewrite would leave the observations
   * themselves on the employee's disk, which is exactly what "collection has stopped"
   * is supposed to mean.
   */
  clear(): void {
    this.live.clear();
    this.lines = 0;
    this.fs.remove(this.path);
  }

  private writeLine(line: JournalLine): void {
    this.fs.append(this.path, `${JSON.stringify(line)}\n`);
    this.lines += 1;
  }

  /**
   * Rebuilds the backlog from the log, in append order.
   *
   * A line that will not parse is skipped rather than fatal — the only line that can
   * be torn is the last one written, and losing one observed interval is not a reason
   * to discard the rest of an offline day.
   */
  private replay(): { records: Map<string, JournalRecord> } {
    const records = new Map<string, JournalRecord>();
    const raw = this.fs.read(this.path);

    this.lines = 0;
    if (raw === null) return { records };

    let corrupt = 0;

    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      this.lines += 1;

      const parsed = parseLine(line);
      if (parsed === null) {
        corrupt += 1;
        continue;
      }

      if ("r" in parsed) {
        for (const id of parsed.r) records.delete(id);
        continue;
      }

      records.set(parsed.e.clientEventId, { kind: parsed.k, event: parsed.e });
    }

    if (corrupt > 0) {
      this.options.log?.(`Skipped ${corrupt} unreadable line(s) in the pending-event journal`);
    }

    return { records };
  }
}

/**
 * The focus interval currently being timed.
 *
 * Persisted as the wire fields rather than as a `Tracker` internal, so the interval a
 * crash interrupts is closed at the moment it actually began — not backdated to
 * whenever the agent was relaunched.
 */
export interface PersistedFocus {
  appName: string;
  windowTitle: string | null;
  url: string | null;
  domain: string | null;
  startedAt: string;
}

/**
 * Everything about today that lives in memory and would otherwise die with the process.
 *
 * The two halves of the same failure: without the spans the day reads *more active
 * than it was*, because idle and break carve-outs are gone; without the sessions it
 * reads *shorter than it was*, because only the still-open session is re-adopted.
 */
export interface DayState {
  sessions: DaySpan[];
  idleSpans: DaySpan[];
  breakSpans: DaySpan[];
  openFocus: PersistedFocus | null;
  /** Unbounded loss otherwise: an absence killed at minute 44 reports as active. */
  openIdleSince: string | null;
  /** Worse still: a crash during lunch credits the whole hour as worked. */
  openBreakSince: string | null;
  /** Without it a restart loop captures far more often than the consented interval. */
  lastCaptureAt: string | null;
  lastSyncAt: string | null;
  /**
   * When the employee said they had finished for the day, or null while working.
   *
   * Persisted rather than held in memory because the point of ending a day is that it
   * stays ended: an agent that resumed collecting because someone rebooted their
   * laptop at 9pm would be recording after the person had explicitly said they were
   * done, which is the one thing this control exists to prevent.
   *
   * It is a timestamp rather than a boolean so the next morning can clear it without
   * asking anyone — see `Collector.restore`.
   */
  dayEndedAt: string | null;
}

export function emptyDayState(): DayState {
  return {
    sessions: [],
    idleSpans: [],
    breakSpans: [],
    openFocus: null,
    openIdleSince: null,
    openBreakSince: null,
    lastCaptureAt: null,
    lastSyncAt: null,
    dayEndedAt: null,
  };
}

/** The slice of the store `SessionManager` needs, narrowed so its tests need no file. */
export interface SessionSpanStore {
  loadSessions(): readonly DaySpan[];
  saveSessions(spans: readonly DaySpan[]): void;
}

/**
 * Today's observed spans and open stretches, held as one document.
 *
 * One document rather than a file per field because they are read and written
 * together and are only a few kilobytes: a single rename publishes a self-consistent
 * snapshot, where separate files could be crashed between and leave an open break with
 * no session to belong to.
 */
export class DayStateStore implements SessionSpanStore {
  private state: DayState | null = null;

  constructor(
    private readonly file: JsonFile,
    private readonly now: () => Date = () => new Date(),
  ) {}

  load(): DayState {
    if (this.state !== null) return this.state;

    const persisted = this.file.read();
    this.state = readDayState(persisted, localDay(this.now()));
    return this.state;
  }

  update(patch: Partial<DayState>): DayState {
    const next = { ...this.load(), ...patch };
    this.state = next;
    this.file.write({ day: localDay(this.now()), ...next });
    return next;
  }

  loadSessions(): readonly DaySpan[] {
    return this.load().sessions;
  }

  saveSessions(spans: readonly DaySpan[]): void {
    this.update({ sessions: [...spans] });
  }
}

/**
 * Local midnight is the boundary an employee and their manager both mean, so the stamp
 * is the local date rather than an ISO instant.
 */
function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Reads the document defensively: a missing, stale or malformed field costs the field,
 * never the launch. Yesterday's snapshot is discarded whole — its spans would be
 * clipped out of today's totals anyway, and keeping them only grows the file.
 */
function readDayState(persisted: unknown, today: string): DayState {
  if (typeof persisted !== "object" || persisted === null) return emptyDayState();

  const record = persisted as Record<string, unknown>;
  if (record["day"] !== today) return emptyDayState();

  return {
    sessions: readSpans(record["sessions"]),
    idleSpans: readSpans(record["idleSpans"]),
    breakSpans: readSpans(record["breakSpans"]),
    openFocus: readFocus(record["openFocus"]),
    openIdleSince: readStamp(record["openIdleSince"]),
    openBreakSince: readStamp(record["openBreakSince"]),
    lastCaptureAt: readStamp(record["lastCaptureAt"]),
    lastSyncAt: readStamp(record["lastSyncAt"]),
  };
}

function readSpans(value: unknown): DaySpan[] {
  if (!Array.isArray(value)) return [];

  const spans: DaySpan[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { startedAt, endedAt } = entry as { startedAt?: unknown; endedAt?: unknown };
    if (typeof startedAt !== "string") continue;
    spans.push({ startedAt, endedAt: typeof endedAt === "string" ? endedAt : null });
  }

  return spans;
}

function readFocus(value: unknown): PersistedFocus | null {
  if (typeof value !== "object" || value === null) return null;

  const focus = value as Record<string, unknown>;
  const appName = focus["appName"];
  const startedAt = focus["startedAt"];
  if (typeof appName !== "string" || typeof startedAt !== "string") return null;

  return {
    appName,
    windowTitle: readStamp(focus["windowTitle"]),
    url: readStamp(focus["url"]),
    domain: readStamp(focus["domain"]),
    startedAt,
  };
}

function readStamp(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export const PENDING_EVENTS_FILE = "pending-events.ndjson";
export const DAY_STATE_FILE = "day-state.json";
export const DEAD_LETTERS_FILE = "dead-letters.json";

/**
 * The plaintext half of the agent's state, directly under Electron's `userData` rather
 * than in the state subdirectory beside the files above.
 *
 * Named here rather than in `config.ts`, which owns it, for a build reason that is not
 * obvious and is load-bearing: the native messaging host reads this file, and
 * `config.ts` imports `safeStorage` from Electron at module scope. Importing the name
 * from there would pull `import { safeStorage } from "electron"` into the host's bundle
 * — and the host runs under `ELECTRON_RUN_AS_NODE`, where that import is a link error
 * before a single line executes. Two spellings of the filename would be worse still, so
 * the constant moves rather than being copied.
 */
export const AGENT_CONFIG_FILE = "agent-config.json";

/**
 * Where the store lives under Electron's `userData`.
 *
 * A subdirectory rather than `userData` itself, so a wipe of the durable state never
 * risks taking `agent-config.json` or the encrypted device token with it.
 */
export function agentStateDirectory(userDataPath: string): string {
  return join(userDataPath, "state");
}

export interface DurableStoreOptions extends StoreOptions {
  directory: string;
  /** Defaults to the real filesystem; tests pass an in-memory one. */
  fs?: DurableFs;
  now?: () => Date;
  journal?: Omit<JournalOptions, keyof StoreOptions>;
}

export interface DurableStore {
  fs: DurableFs;
  journal: EventJournal;
  dayState: DayStateStore;
  /** Handed out rather than constructed here, so this module stays the lower layer. */
  deadLetterPath: string;
}

/**
 * Builds the three files as one unit.
 *
 * The point is that no caller ever names a path: `index.ts` owns the wiring, and a
 * second component inventing its own filename is how two halves of the same state end
 * up in two files that a crash can leave disagreeing.
 */
export function createDurableStore(options: DurableStoreOptions): DurableStore {
  const fs = options.fs ?? nodeDurableFs();
  const log = options.log;
  const { directory } = options;

  return {
    fs,
    journal: new EventJournal(fs, join(directory, PENDING_EVENTS_FILE), {
      ...options.journal,
      log,
    }),
    dayState: new DayStateStore(
      new JsonFile(fs, join(directory, DAY_STATE_FILE), { log }),
      options.now,
    ),
    deadLetterPath: join(directory, DEAD_LETTERS_FILE),
  };
}

/**
 * The real filesystem, kept behind the interface as a deliberately thin adapter.
 *
 * Untested by design, in the same way `ElectronCapturer` is: there is no branching
 * here beyond mapping "file is absent" onto null, and a test of it would have to
 * create real files to prove that `node:fs` works.
 */
export function nodeDurableFs(): DurableFs {
  return {
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    write(path, contents) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, "utf8");
    },
    append(path, contents) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, contents, "utf8");
    },
    rename(from, to) {
      // Replaces the destination on both platforms — `MoveFileEx` with
      // `MOVEFILE_REPLACE_EXISTING` on Windows, `rename(2)` on macOS — which is what
      // makes publish-by-rename work rather than needing an unlink first.
      renameSync(from, to);
    },
    remove(path) {
      rmSync(path, { force: true });
    },
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

const JOURNAL_KINDS: readonly JournalKind[] = ["activity", "idle", "breaks"];

function parseLine(line: string): JournalLine | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const candidate = parsed as { k?: unknown; e?: unknown; r?: unknown };

  if (Array.isArray(candidate.r)) {
    return { r: candidate.r.filter((id): id is string => typeof id === "string") };
  }

  const kind = JOURNAL_KINDS.find((known) => known === candidate.k);
  const event = candidate.e;
  if (kind === undefined || typeof event !== "object" || event === null) return null;

  const { clientEventId } = event as { clientEventId?: unknown };
  if (typeof clientEventId !== "string" || clientEventId.length === 0) return null;

  return { k: kind, e: event as JournalEvent };
}
