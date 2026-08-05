import { describe, expect, it, vi } from "vitest";

import { AemsApiError, AemsClient, AemsNetworkError, DEFAULT_TIMEOUT_MS } from "./client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Records what the client handed the transport, then answers successfully. */
function recordingFetch(calls: RequestInit[], body: unknown = []): typeof globalThis.fetch {
  return ((_url: string, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(jsonResponse(body));
  }) as unknown as typeof globalThis.fetch;
}

/**
 * A fetch that never settles — the hung socket the timeout exists for.
 *
 * Deliberately ignores the abort signal: a fake that honoured it would prove only
 * that undici behaves, not that the client rejects on its own.
 */
function hangingFetch(): typeof globalThis.fetch {
  return (() => new Promise<Response>(() => {})) as typeof globalThis.fetch;
}

describe("request timeout", () => {
  it("rejects once the configured timeout elapses", async () => {
    const client = new AemsClient({
      baseUrl: "https://api.test",
      fetch: hangingFetch(),
      timeoutMs: 10,
    });

    await expect(client.listDevices()).rejects.toThrow(/timed out/i);
  });

  it("reports a timeout as a network fault with no HTTP status", async () => {
    const client = new AemsClient({
      baseUrl: "https://api.test",
      fetch: hangingFetch(),
      timeoutMs: 10,
    });

    const error: unknown = await client.listDevices().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AemsNetworkError);
    expect((error as AemsNetworkError).timedOut).toBe(true);
    // Callers split retry from quarantine on `statusCode`. A request that never got an
    // answer has no status, so the batch must survive to be sent again.
    expect((error as AemsNetworkError).statusCode).toBeNull();
  });

  it("wraps a refused connection as a network fault that did not time out", async () => {
    const refused = new TypeError("fetch failed");
    const client = new AemsClient({
      baseUrl: "https://api.test",
      fetch: (() => Promise.reject(refused)) as typeof globalThis.fetch,
    });

    const error: unknown = await client.listDevices().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AemsNetworkError);
    expect((error as AemsNetworkError).timedOut).toBe(false);
    expect((error as AemsNetworkError).statusCode).toBeNull();
    // "fetch failed" alone is unreadable in a log; the original carries the errno.
    expect((error as AemsNetworkError).cause).toBe(refused);
  });
});

describe("retry versus quarantine", () => {
  it("leaves an HTTP rejection carrying its status", async () => {
    const client = new AemsClient({
      baseUrl: "https://api.test",
      fetch: (() =>
        Promise.resolve(
          jsonResponse({ error: "validation_error", message: "clientEventId missing" }, 400),
        )) as unknown as typeof globalThis.fetch,
    });

    const error: unknown = await client.listDevices().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AemsApiError);
    // Wrapping this as a transport fault would make the caller retry a batch the API
    // has already judged — the buffer would then never drain.
    expect((error as AemsApiError).statusCode).toBe(400);
    expect((error as AemsApiError).code).toBe("validation_error");
  });
});

describe("abort mechanics", () => {
  it("applies the deadline to a body that never finishes, not just to the headers", async () => {
    // Headers arrive, then the socket stalls mid-body. Timing out on the response
    // alone would leave the caller hanging on exactly the failure it guards against.
    const stalledBody = {
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => {}),
    } as unknown as Response;

    const client = new AemsClient({
      baseUrl: "https://api.test",
      fetch: (() => Promise.resolve(stalledBody)) as unknown as typeof globalThis.fetch,
      timeoutMs: 10,
    });

    await expect(client.listDevices()).rejects.toBeInstanceOf(AemsNetworkError);
  });

  it("hands the transport a signal it can cancel the socket with", async () => {
    const calls: RequestInit[] = [];
    const client = new AemsClient({ baseUrl: "https://api.test", fetch: recordingFetch(calls) });

    await client.listDevices();

    // Without this the raced request is only abandoned, never cancelled: the socket
    // and its response body stay open until the OS gives up on them.
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal?.aborted).toBe(false);
  });

  it("gives each request its own controller, so a timeout cannot poison the next call", async () => {
    const calls: RequestInit[] = [];
    let hang = true;
    const client = new AemsClient({
      baseUrl: "https://api.test",
      timeoutMs: 10,
      fetch: ((url: string, init: RequestInit) => {
        calls.push(init);
        return hang ? new Promise<Response>(() => {}) : recordingFetch([])(url, init);
      }) as unknown as typeof globalThis.fetch,
    });

    await expect(client.listDevices()).rejects.toBeInstanceOf(AemsNetworkError);
    hang = false;

    await expect(client.listDevices()).resolves.toEqual([]);
    expect(calls[1]?.signal?.aborted).toBe(false);
  });

  it("still reports a timeout when the transport rejects with its own abort error", async () => {
    // undici surfaces the reason we passed, but a body torn down mid-read can arrive
    // as a bare TypeError instead. Either way the deadline is what happened.
    const client = new AemsClient({
      baseUrl: "https://api.test",
      timeoutMs: 10,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
        })) as unknown as typeof globalThis.fetch,
    });

    const error: unknown = await client.listDevices().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AemsNetworkError);
    expect((error as AemsNetworkError).timedOut).toBe(true);
    expect((error as AemsNetworkError).statusCode).toBeNull();
  });

  it("clears the deadline as soon as the response arrives", async () => {
    vi.useFakeTimers();
    try {
      const client = new AemsClient({ baseUrl: "https://api.test", fetch: recordingFetch([]) });

      await client.listDevices();

      // An armed timer holds the controller alive and, under Node, keeps the process
      // from exiting for the rest of the deadline after the work is already done.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the default deadline when none is configured", async () => {
    vi.useFakeTimers();
    try {
      const client = new AemsClient({ baseUrl: "https://api.test", fetch: hangingFetch() });
      let settled = false;
      const pending = client.listDevices().catch((reason: unknown) => {
        settled = true;
        return reason;
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeInstanceOf(AemsNetworkError);
    } finally {
      vi.useRealTimers();
    }
  });
});
