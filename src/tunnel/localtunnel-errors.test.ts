/**
 * localtunnel-errors.test.ts - the localtunnel provider's failure and
 * lifecycle paths, driven entirely through the module's dependency injection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

async function loadModule() {
  vi.resetModules();
  return import("./localtunnel");
}

/**
 * A localtunnel stand-in. `err` makes the callback report a failure; otherwise
 * it hands back a tunnel whose close/on handlers are observable.
 */
function fakeModule(options: { err?: Error; url?: string } = {}) {
  const handlers: Record<string, () => void> = {};
  const tunnel = {
    url: options.url ?? "https://mock.loca.lt",
    closed: false,
    close() {
      this.closed = true;
    },
    on(event: string, cb: () => void) {
      handlers[event] = cb;
    },
  };

  const module = vi.fn((_opts: unknown, callback: (e: unknown, t: unknown) => void) => {
    setTimeout(() => callback(options.err ?? null, tunnel), 0);
    return tunnel;
  });

  return { module, tunnel, handlers };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  const { clearInstance } = await import("./localtunnel");
  clearInstance();
  vi.restoreAllMocks();
});

describe("createLocaltunnel failure paths", () => {
  it("wraps a callback error", async () => {
    const { createLocaltunnel } = await loadModule();
    const { module } = fakeModule({ err: new Error("connection refused") });

    await expect(
      createLocaltunnel({ port: 3000 }, { localtunnelModule: module as never }),
    ).rejects.toThrow(/Localtunnel failed: connection refused/);
  });

  it("does not record an instance after a failure", async () => {
    const { createLocaltunnel, getInstance } = await loadModule();
    const { module } = fakeModule({ err: new Error("nope") });

    await createLocaltunnel({ port: 3000 }, { localtunnelModule: module as never }).catch(() => {});
    expect(getInstance()).toBeNull();
  });

  it.each([
    ["undefined", {}],
    ["a string", { port: "3000" }],
    ["zero", { port: 0 }],
  ])("rejects a port that is %s", async (_label, config) => {
    const { createLocaltunnel } = await loadModule();
    await expect(createLocaltunnel(config as never)).rejects.toThrow(/Invalid port/);
  });
});

describe("createLocaltunnel success paths", () => {
  it("logs the url when no onUrl callback is given", async () => {
    const { createLocaltunnel } = await loadModule();
    const { module } = fakeModule();
    const logSpy = vi.spyOn(console, "log");

    await createLocaltunnel({ port: 3000 }, { localtunnelModule: module as never });

    const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("https://mock.loca.lt");
  });

  it("passes the subdomain through", async () => {
    const { createLocaltunnel } = await loadModule();
    const { module } = fakeModule({ url: "https://chosen.loca.lt" });

    await createLocaltunnel(
      { port: 3000, subdomain: "chosen" },
      { localtunnelModule: module as never },
    );

    const [opts] = module.mock.calls[0] as [{ port: number; subdomain?: string }];
    expect(opts.subdomain).toBe("chosen");
    expect(opts.port).toBe(3000);
  });

  it("derives the tunnel id from the url host", async () => {
    const { createLocaltunnel } = await loadModule();
    const { module } = fakeModule({ url: "https://abc123.loca.lt" });

    const result = await createLocaltunnel({ port: 3000 }, { localtunnelModule: module as never });
    expect(result.tunnelId).toBe("abc123");
  });

  it("records the instance so getLocaltunnelUrl can report it", async () => {
    const { createLocaltunnel, getLocaltunnelUrl } = await loadModule();
    const { module } = fakeModule({ url: "https://live.loca.lt" });

    await createLocaltunnel({ port: 3000 }, { localtunnelModule: module as never });
    expect(getLocaltunnelUrl()).toBe("https://live.loca.lt");
  });

  it("clears the instance when the tunnel closes on its own", async () => {
    const { createLocaltunnel, getInstance } = await loadModule();
    const { module, handlers } = fakeModule();

    await createLocaltunnel({ port: 3000 }, { localtunnelModule: module as never });
    expect(getInstance()).not.toBeNull();

    // The provider registers a close handler to drop its reference.
    handlers.close?.();
    expect(getInstance()).toBeNull();
  });
});

describe("stopLocaltunnel", () => {
  it("closes the live tunnel and clears state", async () => {
    const { createLocaltunnel, stopLocaltunnel, getInstance, getLocaltunnelUrl } = await loadModule();
    const { module, tunnel } = fakeModule();

    await createLocaltunnel({ port: 3000 }, { localtunnelModule: module as never });
    await stopLocaltunnel();

    expect(tunnel.closed).toBe(true);
    expect(getInstance()).toBeNull();
    expect(getLocaltunnelUrl()).toBeNull();
  });

  it("is a no-op when nothing is running", async () => {
    const { stopLocaltunnel } = await loadModule();
    await expect(stopLocaltunnel()).resolves.toBeUndefined();
  });
});

describe("getLocaltunnelUrl", () => {
  it("is null with no tunnel", async () => {
    const { getLocaltunnelUrl } = await loadModule();
    expect(getLocaltunnelUrl()).toBeNull();
  });

  it("is null for an instance with no url", async () => {
    const { setInstance, getLocaltunnelUrl } = await loadModule();
    setInstance({});
    expect(getLocaltunnelUrl()).toBeNull();
  });
});
