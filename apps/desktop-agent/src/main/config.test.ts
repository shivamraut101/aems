import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig, AgentPolicy } from "../shared/types/index.js";
import { ConfigStore, resolveApiUrl } from "./config.js";

/**
 * A fake disk and a fake keychain, hoisted because `vi.mock` factories run before the
 * test body does.
 *
 * `scramble` is a deliberately trivial reversible transform. It is not pretending to be
 * DPAPI — its only job is to be *not the identity function*, so a test can assert the
 * bytes that reached the disk are not the token that went into `encryptString`.
 */
const state = vi.hoisted(() => {
  const scramble = (input: Buffer): Buffer =>
    Buffer.from(Uint8Array.from(input, (byte) => byte ^ 0x5a));

  return {
    files: new Map<string, Buffer>(),
    scramble,
    encryptionAvailable: true,
    decryptFails: false,
  };
});

vi.mock("node:fs", () => ({
  readFileSync: (path: string, encoding?: string): string | Buffer => {
    const bytes = state.files.get(path);
    if (bytes === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return encoding === "utf8" ? bytes.toString("utf8") : bytes;
  },
  writeFileSync: (path: string, contents: string | Buffer): void => {
    state.files.set(
      path,
      typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents),
    );
  },
  rmSync: (path: string): void => {
    state.files.delete(path);
  },
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: (): boolean => state.encryptionAvailable,
    encryptString: (plain: string): Buffer => state.scramble(Buffer.from(plain, "utf8")),
    decryptString: (bytes: Buffer): string => {
      // Real `safeStorage` throws on ciphertext it cannot open: a copied profile
      // directory, a re-imaged machine, a keychain the employee has not unlocked yet.
      if (state.decryptFails) throw new Error("Failed to decrypt");
      return state.scramble(Buffer.from(bytes)).toString("utf8");
    },
  },
}));

const DIR = "/aems-state";
const CONFIG_FILE = join(DIR, "agent-config.json");
const TOKEN_FILE = join(DIR, "device-token.bin");

const POLICY: AgentPolicy = {
  version: "2026.08",
  name: "Standard monitoring",
  screenshotIntervalSeconds: 300,
  idleThresholdSeconds: 300,
  trackedCategories: ["application", "website"],
};

function seedConfigFile(contents: string): void {
  state.files.set(CONFIG_FILE, Buffer.from(contents, "utf8"));
}

function configFileText(): string | null {
  return state.files.get(CONFIG_FILE)?.toString("utf8") ?? null;
}

function configFileJson(): Record<string, unknown> {
  const text = configFileText();
  if (text === null) throw new Error("the agent never wrote agent-config.json");
  return JSON.parse(text) as Record<string, unknown>;
}

/** Every byte the agent put anywhere, for "is this secret on disk at all?" checks. */
function everythingOnDisk(): string {
  return [...state.files.values()].map((bytes) => bytes.toString("binary")).join(" ");
}

beforeEach(() => {
  state.files.clear();
  state.encryptionAvailable = true;
  state.decryptFails = false;
  delete process.env.AEMS_API_URL;
});

afterEach(() => {
  delete process.env.AEMS_API_URL;
  // Otherwise a build-time URL stubbed by one case leaks into every later one, and the
  // localhost defaults above would pass for the wrong reason.
  vi.unstubAllGlobals();
});

// -- the allowlist --------------------------------------------------------

describe("ConfigStore.update and the write allowlist", () => {
  it("writes only the allowlisted fields, so a secret added to AgentConfig later cannot ride along", () => {
    const store = new ConfigStore(DIR);
    store.load();

    // Stands in for the field someone adds to AgentConfig six months from now. The
    // allowlist is the only thing between it and a plaintext file in userData, so the
    // assertion is on the bytes written, not on the allowlist's own contents.
    const patch = { deviceId: "device-1", refreshToken: "hunter2-refresh" };
    store.update(patch as Partial<AgentConfig>);

    expect(Object.keys(configFileJson()).sort()).toEqual([
      "apiUrl",
      "collection",
      "companyId",
      "consentedPolicyVersion",
      "deviceId",
      "pendingTypes",
      "policy",
      "profileId",
      "revoked",
    ]);
    expect(everythingOnDisk()).not.toContain("hunter2-refresh");
  });

  it("keeps the device token out of the readable JSON entirely", () => {
    const store = new ConfigStore(DIR);
    store.load();

    store.update({ deviceId: "device-1", deviceToken: "device-token-abc" });

    expect(configFileJson()).not.toHaveProperty("deviceToken");
    expect(configFileText()).not.toContain("device-token-abc");
  });

  it("drops an unknown field that was already in the file rather than echoing it back", () => {
    // A field written by a newer build, or by hand. Round-tripping it would defeat the
    // allowlist entirely: anything ever persisted would stay persisted forever.
    seedConfigFile('{"apiUrl":"https://api.example.test","deviceId":"device-1","nickname":"spy-mode"}');

    const store = new ConfigStore(DIR);
    store.load();
    store.update({ companyId: "company-1" });

    expect(configFileJson()).not.toHaveProperty("nickname");
    expect(everythingOnDisk()).not.toContain("spy-mode");
  });

  it("carries an unknown field in memory, so the write allowlist is the only thing dropping it", () => {
    seedConfigFile('{"apiUrl":"https://api.example.test","nickname":"spy-mode"}');

    const store = new ConfigStore(DIR);
    store.load();

    // Pinning what `load` actually does, not what it looks like it does: the spread of
    // the parsed file is unfiltered, so `current` is a superset of AgentConfig. That is
    // survivable only while nothing serialises `current` wholesale — a diagnostic dump,
    // a log line or an IPC payload that spreads it would leak straight past the
    // allowlist. Anything doing that has to sanitise on read instead.
    expect(store.current).toHaveProperty("nickname");
  });

  it("ignores a plaintext deviceToken planted in the JSON — the token comes from safeStorage only", () => {
    seedConfigFile('{"apiUrl":"https://api.example.test","deviceToken":"planted-plaintext"}');

    // Honouring this would let anyone who can write to userData hand the agent a
    // credential, and would quietly turn the readable file into a secret store.
    expect(new ConfigStore(DIR).load().deviceToken).toBeNull();
  });
});

// -- the safeStorage seam -------------------------------------------------

describe("ConfigStore device token storage", () => {
  it("round-trips the token through safeStorage across a restart", () => {
    const first = new ConfigStore(DIR);
    first.load();
    first.update({ deviceId: "device-1", deviceToken: "device-token-abc" });

    // A fresh instance is the restart: enrolment has to survive it, or the agent
    // re-enrols and creates a duplicate device row.
    expect(new ConfigStore(DIR).load().deviceToken).toBe("device-token-abc");
  });

  it("stores the encrypted bytes, not the token", () => {
    const store = new ConfigStore(DIR);
    store.load();
    store.update({ deviceToken: "device-token-abc" });

    expect(state.files.get(TOKEN_FILE)).toEqual(
      state.scramble(Buffer.from("device-token-abc", "utf8")),
    );
    expect(everythingOnDisk()).not.toContain("device-token-abc");
  });

  it("does not rewrite the token file when a patch leaves the token alone", () => {
    const store = new ConfigStore(DIR);
    store.load();
    store.update({ deviceToken: "device-token-abc" });

    state.files.delete(TOKEN_FILE);
    store.update({ consentedPolicyVersion: POLICY.version });

    // Consent, policy refreshes and revocation flags all go through `update`. Touching
    // the keychain on every one of them would prompt on macOS for no reason.
    expect(state.files.has(TOKEN_FILE)).toBe(false);
  });

  it("returns a usable config when the stored ciphertext cannot be decrypted", () => {
    const store = new ConfigStore(DIR);
    store.load();
    store.update({ deviceId: "device-1", deviceToken: "device-token-abc" });

    state.decryptFails = true;

    // A copied profile directory decrypts to nothing on the new machine. The agent has
    // to come up unenrolled and ask for enrolment, not fail to launch.
    const config = new ConfigStore(DIR).load();
    expect(config.deviceToken).toBeNull();
    expect(config.deviceId).toBe("device-1");
  });
});

describe("ConfigStore when safeStorage is unavailable", () => {
  it("refuses to store the token instead of falling back to plaintext", () => {
    state.encryptionAvailable = false;
    const store = new ConfigStore(DIR);
    store.load();

    expect(() => store.update({ deviceId: "device-1", deviceToken: "device-token-abc" })).toThrow(
      /credential storage is unavailable/i,
    );

    expect(state.files.has(TOKEN_FILE)).toBe(false);
    expect(everythingOnDisk()).not.toContain("device-token-abc");
  });

  it("leaves no half-enrolled state behind when the refusal happens", () => {
    state.encryptionAvailable = false;
    const store = new ConfigStore(DIR);
    store.load();

    expect(() => store.update({ deviceId: "device-1", deviceToken: "device-token-abc" })).toThrow();

    // A deviceId written without its token reads as "enrolled" to the next `load`,
    // which is an agent that can never authenticate and never re-enrols.
    expect(store.current.deviceId).toBeNull();
    expect(store.current.deviceToken).toBeNull();
    expect(configFileText()).toBeNull();
  });

  it("comes up unenrolled rather than reading the token file raw", () => {
    const enrolled = new ConfigStore(DIR);
    enrolled.load();
    enrolled.update({ deviceId: "device-1", deviceToken: "device-token-abc" });

    // Linux CI, or a macOS keychain the employee has not unlocked. The ciphertext is
    // still sitting there; treating it as a token would be the whole point missed.
    state.encryptionAvailable = false;

    expect(new ConfigStore(DIR).load().deviceToken).toBeNull();
  });

  it("still wipes the token file on reset, because revocation cannot wait for a keychain", () => {
    const store = new ConfigStore(DIR);
    store.load();
    store.update({ deviceId: "device-1", deviceToken: "device-token-abc" });

    state.encryptionAvailable = false;
    store.reset();

    expect(state.files.has(TOKEN_FILE)).toBe(false);
  });
});

// -- damaged, partial and absent files ------------------------------------

describe("ConfigStore.load with a damaged file", () => {
  it("starts from defaults when there is no file yet", () => {
    const config = new ConfigStore(DIR).load();

    expect(config).toEqual({
      apiUrl: "http://localhost:3001",
      deviceId: null,
      deviceToken: null,
      profileId: null,
      companyId: null,
      consentedPolicyVersion: null,
      policy: null,
      collection: null,
      pendingTypes: [],
      revoked: false,
    });
  });

  it.each([
    ["truncated mid-write", '{"apiUrl":"https://api.example.test","devic'],
    ["empty", ""],
    ["a bare null", "null"],
    ["a bare number", "42"],
    ["an array", "[1,2,3]"],
  ])("starts from defaults when the file is %s", (_label, contents) => {
    seedConfigFile(contents);

    const config = new ConfigStore(DIR).load();

    expect(config.apiUrl).toBe("http://localhost:3001");
    expect(config.deviceId).toBeNull();
    expect(config.revoked).toBe(false);
  });

  it("keeps the fields it can read when one field is the wrong type", () => {
    seedConfigFile('{"apiUrl": 8080, "deviceId": "device-1"}');

    // The class promises a hand-edited file makes the agent start unenrolled rather
    // than refuse to launch. A number where a string belongs is exactly that case, and
    // reading it as a string used to throw out of `load`.
    const config = new ConfigStore(DIR).load();

    expect(config.apiUrl).toBe("http://localhost:3001");
    expect(config.deviceId).toBe("device-1");
  });

  it("falls back to the default API URL when the persisted one is blank", () => {
    seedConfigFile('{"apiUrl":"   ","deviceId":"device-1"}');

    expect(new ConfigStore(DIR).load().apiUrl).toBe("http://localhost:3001");
  });

  it("prefers a persisted API URL over the environment, so a re-pointed agent stays re-pointed", () => {
    process.env.AEMS_API_URL = "https://env.example.test";
    seedConfigFile('{"apiUrl":"https://persisted.example.test"}');

    expect(new ConfigStore(DIR).load().apiUrl).toBe("https://persisted.example.test");
  });
});

describe("resolveApiUrl", () => {
  it.each([
    ["unset", undefined, "http://localhost:3001"],
    ["blank", "   ", "http://localhost:3001"],
    ["set", "https://api.example.test", "https://api.example.test"],
  ])("resolves to the default when AEMS_API_URL is %s", (_label, value, expected) => {
    if (value === undefined) delete process.env.AEMS_API_URL;
    else process.env.AEMS_API_URL = value;

    expect(resolveApiUrl()).toBe(expected);
  });

  /**
   * The build-time value is the only thing standing between a shipped installer and
   * `http://localhost:3001` — the employee's own laptop. A packaged app inherits no
   * environment, the login screen asks only for an enrolment code, and the stored
   * `apiUrl` exists only after a first run that already knew the answer.
   *
   * `vi.stubGlobal` stands in for what `define` does textually at build time; in this
   * suite the identifier is genuinely undeclared, which is the case the `typeof` guard
   * in `buildTimeApiUrl` exists for.
   */
  it("falls back to the URL frozen in at build time before it falls back to localhost", () => {
    delete process.env.AEMS_API_URL;
    vi.stubGlobal("__AEMS_BUILD_API_URL__", "https://aems-kbb9.onrender.com");

    expect(resolveApiUrl()).toBe("https://aems-kbb9.onrender.com");
  });

  it("still prefers the runtime environment, so one build can be pointed at a local API", () => {
    process.env.AEMS_API_URL = "http://localhost:3001";
    vi.stubGlobal("__AEMS_BUILD_API_URL__", "https://aems-kbb9.onrender.com");

    expect(resolveApiUrl()).toBe("http://localhost:3001");
  });

  it("ignores an empty build-time value rather than reaching for an empty base URL", () => {
    delete process.env.AEMS_API_URL;
    vi.stubGlobal("__AEMS_BUILD_API_URL__", "");

    expect(resolveApiUrl()).toBe("http://localhost:3001");
  });
});

// -- revocation -----------------------------------------------------------

describe("ConfigStore.reset", () => {
  it("wipes enrolment and the token but keeps the revoked flag", () => {
    const store = new ConfigStore(DIR);
    store.load();
    store.update({
      deviceId: "device-1",
      deviceToken: "device-token-abc",
      companyId: "company-1",
      profileId: "profile-1",
      policy: POLICY,
      consentedPolicyVersion: POLICY.version,
      revoked: true,
    });

    const config = store.reset();

    // Clearing `revoked` here would let a restart re-enrol straight out of a
    // revocation, which is the one thing revocation exists to prevent.
    expect(config.revoked).toBe(true);
    expect(config.deviceId).toBeNull();
    expect(config.deviceToken).toBeNull();
    expect(config.consentedPolicyVersion).toBeNull();
    expect(state.files.has(TOKEN_FILE)).toBe(false);
    expect(everythingOnDisk()).not.toContain("device-token-abc");
  });
});
