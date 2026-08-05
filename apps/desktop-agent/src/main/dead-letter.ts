import type { DurableFs, StoreOptions } from "./persistence.js";
import { JsonFile } from "./persistence.js";

/** One batch the API refused, kept so the gap it leaves in a timeline is explainable. */
export interface DeadLetter {
  quarantinedAt: string;
  /** Which buffer it came from, so a recurring failure can be attributed to a producer. */
  kind: string;
  /** The API's error code, not a message: `invalid_body`, `unsupported_media_type`. */
  reason: string;
  events: readonly unknown[];
}

export interface DeadLetterOptions extends StoreOptions {
  maxEntries?: number;
}

/**
 * Twenty rejected batches.
 *
 * A batch is at most `MAX_EVENTS_PER_BATCH` events of one kind, so this bounds the
 * file at a few megabytes in the pathological case where a producer emits something
 * the API hates on every flush — and twenty is already far more than anyone needs to
 * recognise a repeating failure.
 */
const DEFAULT_MAX_DEAD_LETTERS = 20;

/** What `SyncQueue` is handed, narrowed so its tests need neither a file nor a fake one. */
export interface DeadLetterSink {
  quarantine(entry: Omit<DeadLetter, "quarantinedAt">, now: Date): void;
}

/**
 * The batches the server will never accept.
 *
 * A 400 means the payload is wrong and always will be, so it has to leave the queue —
 * otherwise one malformed event stalls every event behind it forever. Dropping it is
 * therefore correct, and dropping it *silently* is not: the employee's timeline has a
 * hole in it, and this file is the only record of what was in the hole and why.
 */
export class DeadLetterFile implements DeadLetterSink {
  private readonly file: JsonFile;
  private readonly maxEntries: number;

  constructor(fs: DurableFs, path: string, options: DeadLetterOptions = {}) {
    this.file = new JsonFile(fs, path, options);
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_DEAD_LETTERS;
  }

  read(): DeadLetter[] {
    return this.load().entries;
  }

  /** How many quarantined batches fell off the end of the file, across its whole life. */
  get shed(): number {
    return this.load().shed;
  }

  quarantine(entry: Omit<DeadLetter, "quarantinedAt">, now: Date): void {
    const current = this.load();
    const entries = [...current.entries, { quarantinedAt: now.toISOString(), ...entry }];

    // Oldest first, for the same reason the sync buffer evicts that way: the recent
    // failures are the ones somebody is diagnosing.
    const excess = Math.max(0, entries.length - this.maxEntries);

    this.file.write({
      shed: current.shed + excess,
      entries: entries.slice(excess),
    });
  }

  private load(): DeadLetterDocument {
    const persisted = this.file.read();
    if (typeof persisted !== "object" || persisted === null) return { shed: 0, entries: [] };

    const record = persisted as { shed?: unknown; entries?: unknown };
    return {
      shed: typeof record.shed === "number" ? record.shed : 0,
      entries: Array.isArray(record.entries) ? (record.entries as DeadLetter[]) : [],
    };
  }
}

interface DeadLetterDocument {
  shed: number;
  entries: DeadLetter[];
}
