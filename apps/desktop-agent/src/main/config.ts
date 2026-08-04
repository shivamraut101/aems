import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { safeStorage } from "electron";

import { emptyConfig } from "../shared/types/index.js";
import type { AgentConfig } from "../shared/types/index.js";

const DEFAULT_API_URL = "http://localhost:3001";

export function resolveApiUrl(): string {
  const fromEnv = process.env.AEMS_API_URL?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_API_URL;
}

/**
 * Agent state on disk.
 *
 * Split in two on purpose: everything non-secret is readable JSON so a support call
 * can ask what the agent thinks its policy is, while the device token goes through
 * `safeStorage` (DPAPI on Windows, Keychain on macOS). The Tauri build kept this
 * entirely in memory, which meant a restart silently de-enrolled the machine and
 * re-enrolling created a duplicate device row.
 */
export class ConfigStore {
  private readonly file: string;
  private readonly tokenFile: string;
  private config: AgentConfig;

  constructor(directory: string) {
    this.file = join(directory, "agent-config.json");
    this.tokenFile = join(directory, "device-token.bin");
    this.config = emptyConfig(resolveApiUrl());
  }

  get current(): AgentConfig {
    return this.config;
  }

  load(): AgentConfig {
    const persisted = this.readJson();
    const apiUrl = persisted.apiUrl?.trim();

    this.config = {
      ...emptyConfig(resolveApiUrl()),
      ...persisted,
      apiUrl: apiUrl !== undefined && apiUrl.length > 0 ? apiUrl : resolveApiUrl(),
      deviceToken: this.readToken(),
    };

    return this.config;
  }

  update(patch: Partial<AgentConfig>): AgentConfig {
    const next = { ...this.config, ...patch };

    if (patch.deviceToken !== undefined && patch.deviceToken !== this.config.deviceToken) {
      this.writeToken(patch.deviceToken);
    }

    this.config = next;
    this.writeJson();
    return this.config;
  }

  /** Wipes enrolment. Used on revocation, where leaving credentials behind would let a restart resume. */
  reset(): AgentConfig {
    this.writeToken(null);
    this.config = {
      ...emptyConfig(this.config.apiUrl),
      revoked: this.config.revoked,
    };
    this.writeJson();
    return this.config;
  }

  private readJson(): Partial<AgentConfig> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      return parsed as Partial<AgentConfig>;
    } catch {
      // No file yet, or someone hand-edited it into invalid JSON. Either way the
      // agent starts unenrolled rather than refusing to launch.
      return {};
    }
  }

  /**
   * Writes an explicit field list rather than the whole config minus the token.
   *
   * An allowlist means a secret added to `AgentConfig` later has to be opted into
   * this file, instead of landing in plaintext because nobody remembered to exclude it.
   */
  private writeJson(): void {
    const { apiUrl, deviceId, profileId, companyId, consentedPolicyVersion, policy, revoked } =
      this.config;

    writeFileSync(
      this.file,
      JSON.stringify(
        {
          apiUrl,
          deviceId,
          profileId,
          companyId,
          consentedPolicyVersion,
          policy,
          revoked,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  private readToken(): string | null {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(readFileSync(this.tokenFile));
    } catch {
      return null;
    }
  }

  private writeToken(token: string | null): void {
    if (token === null) {
      rmSync(this.tokenFile, { force: true });
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      // Failing enrolment beats writing a long-lived device credential in plaintext
      // to a user-writable directory.
      throw new Error("OS credential storage is unavailable; refusing to store the device token");
    }

    writeFileSync(this.tokenFile, safeStorage.encryptString(token));
  }
}
