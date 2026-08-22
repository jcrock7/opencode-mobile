/**
 * cloudflare-lifecycle.test.ts - config discovery, lifecycle and the
 * custom-domain branch of the Cloudflare provider.
 *
 * Complements cloudflare.test.ts, which covers the free-tier factory. Nothing
 * here touches the network or the real cloudflared binary: `spawn` and
 * `existsSync` come in through the factory's dependency injection, `fetch` is
 * stubbed for the readiness poll, and config discovery is redirected by pointing
 * HOME at a scratch directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChildProcess } from "child_process";

let home = "";

async function loadModule() {
  vi.resetModules();
  return import("./cloudflare");
}

function writeSavedConfig(config: Record<string, unknown>): string {
  const dir = path.join(home, ".config", "opencode-mobile");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "tunnel-config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

/**
 * A stand-in cloudflared process.
 *
 * `stdoutData` is emitted on stdout shortly after spawn; `exitCode` (when set)
 * is emitted afterwards. `emitError` raises a spawn error instead.
 */
function fakeProcess(options: {
  stdoutData?: string;
  exitCode?: number | null;
  emitError?: Error;
} = {}): ChildProcess & { killed: boolean } {
  const proc = {
    killed: false,
    stdout: {
      on: (event: string, cb: (data: Buffer) => void) => {
        if (event === "data" && options.stdoutData !== undefined) {
          setTimeout(() => cb(Buffer.from(options.stdoutData as string)), 5);
        }
      },
    },
    stderr: { on: () => {} },
    on: (event: string, cb: (arg: unknown) => void) => {
      if (event === "error" && options.emitError) {
        setTimeout(() => cb(options.emitError), 10);
      }
      if (event === "exit" && options.exitCode !== undefined) {
        setTimeout(() => cb(options.exitCode), 20);
      }
    },
    kill: function () {
      this.killed = true;
    },
  };
  return proc as unknown as ChildProcess & { killed: boolean };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cf-"));
  process.env.HOME = home;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  const { clearState } = await import("./cloudflare");
  clearState();
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("findCloudflared", () => {
  it("returns the first path that exists", async () => {
    const { findCloudflared } = await loadModule();
    const found = findCloudflared(["/a/cloudflared", "/b/cloudflared"], (p) => p === "/b/cloudflared");
    expect(found).toBe("/b/cloudflared");
  });

  it("returns null when none exist", async () => {
    const { findCloudflared } = await loadModule();
    expect(findCloudflared(["/a", "/b"], () => false)).toBeNull();
  });

  it("skips a path whose check throws", async () => {
    const { findCloudflared } = await loadModule();
    const found = findCloudflared(["/boom", "/ok"], (p) => {
      if (p === "/boom") throw new Error("EACCES");
      return true;
    });
    expect(found).toBe("/ok");
  });

  it("falls back to the built-in path list", async () => {
    const { findCloudflared } = await loadModule();
    // No cloudflared installed in this environment.
    expect(findCloudflared(undefined, () => false)).toBeNull();
  });
});

describe("state helpers", () => {
  it("round-trips the url", async () => {
    const { setUrl, getCloudflareUrl, clearState } = await loadModule();

    expect(getCloudflareUrl()).toBeNull();
    setUrl("https://x.trycloudflare.com");
    expect(getCloudflareUrl()).toBe("https://x.trycloudflare.com");

    clearState();
    expect(getCloudflareUrl()).toBeNull();
  });

  it("round-trips the process", async () => {
    const { setProcess, getProcess, clearState } = await loadModule();

    expect(getProcess()).toBeNull();
    const proc = fakeProcess();
    setProcess(proc);
    expect(getProcess()).toBe(proc);

    clearState();
    expect(getProcess()).toBeNull();
  });
});

describe("stopCloudflareTunnel", () => {
  it("kills the process and clears state", async () => {
    const { setProcess, setUrl, stopCloudflareTunnel, getProcess, getCloudflareUrl } =
      await loadModule();

    const proc = fakeProcess();
    setProcess(proc);
    setUrl("https://x.trycloudflare.com");

    await stopCloudflareTunnel();

    expect(proc.killed).toBe(true);
    expect(getProcess()).toBeNull();
    expect(getCloudflareUrl()).toBeNull();
  });

  it("is a no-op when nothing is running", async () => {
    const { stopCloudflareTunnel } = await loadModule();
    await expect(stopCloudflareTunnel()).resolves.toBeUndefined();
  });
});

describe("isCloudflareInstalled", () => {
  it("resolves to a boolean without throwing", async () => {
    const { isCloudflareInstalled } = await loadModule();
    // cloudflared is absent here, so this exercises every negative branch:
    // the path list, `cloudflared --version`, and the saved config.
    expect(await isCloudflareInstalled()).toBe(false);
  });

  it("is true when a saved config points at an existing binary", async () => {
    const binary = path.join(home, "cloudflared");
    fs.writeFileSync(binary, "");
    writeSavedConfig({ provider: "cloudflare", cloudflaredPath: binary });

    const { isCloudflareInstalled } = await loadModule();
    expect(await isCloudflareInstalled()).toBe(true);
  });

  it("ignores a saved config pointing at a missing binary", async () => {
    writeSavedConfig({ provider: "cloudflare", cloudflaredPath: path.join(home, "gone") });

    const { isCloudflareInstalled } = await loadModule();
    expect(await isCloudflareInstalled()).toBe(false);
  });

  it("tolerates a corrupt saved config", async () => {
    const dir = path.join(home, ".config", "opencode-mobile");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tunnel-config.json"), "{{{ not json");

    const { isCloudflareInstalled } = await loadModule();
    expect(await isCloudflareInstalled()).toBe(false);
  });
});

describe("startCloudflareTunnel", () => {
  it("rejects when cloudflared is not installed", async () => {
    const { startCloudflareTunnel } = await loadModule();
    await expect(startCloudflareTunnel({ port: 4097 })).rejects.toThrow(/cloudflared not found/);
  });

  it("rejects an invalid port before looking for the binary", async () => {
    const { startCloudflareTunnel } = await loadModule();
    await expect(startCloudflareTunnel({} as never)).rejects.toThrow(/Invalid port/);
  });
});

describe("createCloudflareTunnel: free-tier failure paths", () => {
  it("rejects when the process errors", async () => {
    const { createCloudflareTunnel } = await loadModule();
    const spawnFn = vi.fn(() => fakeProcess({ emitError: new Error("ENOENT") }));

    await expect(
      createCloudflareTunnel({ port: 4097 }, spawnFn as never, () => true, undefined, () => null),
    ).rejects.toThrow(/ENOENT/);
  });

  it("rejects when the process exits before printing a url", async () => {
    const { createCloudflareTunnel } = await loadModule();
    const spawnFn = vi.fn(() => fakeProcess({ exitCode: 0 }));

    await expect(
      createCloudflareTunnel({ port: 4097 }, spawnFn as never, () => true, undefined, () => null),
    ).rejects.toThrow(/exited without providing a tunnel URL/);
  });

  it("ignores non-url output while waiting", async () => {
    const { createCloudflareTunnel } = await loadModule();
    // An ERR line then a url: the url must still win.
    const proc = {
      stdout: {
        on: (event: string, cb: (d: Buffer) => void) => {
          if (event !== "data") return;
          setTimeout(() => cb(Buffer.from("ERR failed to connect, retrying")), 5);
          setTimeout(() => cb(Buffer.from("https://ok.trycloudflare.com")), 15);
        },
      },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => {},
    } as unknown as ChildProcess;

    const result = await createCloudflareTunnel(
      { port: 4097 },
      vi.fn(() => proc) as never,
      () => true,
      undefined,
      () => null,
    );

    expect(result.url).toBe("https://ok.trycloudflare.com");
    expect(result.tunnelId).toBe("ok");
    expect(result.provider).toBe("cloudflare");
    expect(result.port).toBe(4097);
  });
});

describe("createCloudflareTunnel: custom-domain branch", () => {
  const SAVED = {
    provider: "cloudflare",
    mode: "custom" as const,
    domain: "code.example.com",
    tunnelName: "opencode",
  };

  it("resolves with the configured domain once the tunnel answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));

    const { createCloudflareTunnel } = await loadModule();
    const spawnFn = vi.fn(() => fakeProcess());

    const result = await createCloudflareTunnel(
      { port: 4097 },
      spawnFn as never,
      () => true,
      undefined,
      () => SAVED,
    );

    expect(result.url).toBe("https://code.example.com");
    expect(result.provider).toBe("cloudflare");
    expect(result.port).toBe(4097);
    expect(spawnFn).toHaveBeenCalled();
  }, 20000);

  it("runs cloudflared with the named-tunnel arguments", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));

    const { createCloudflareTunnel } = await loadModule();
    const spawnFn = vi.fn(() => fakeProcess());

    await createCloudflareTunnel(
      { port: 4097 },
      spawnFn as never,
      () => true,
      undefined,
      () => SAVED,
    );

    const args = (spawnFn.mock.calls[0] as unknown[])[1] as string[];
    expect(args).toContain("tunnel");
    expect(args).toContain("run");
    expect(args).toContain("opencode");
    expect(args).toContain("http://127.0.0.1:4097");
  }, 20000);

  it("reports the url through the onUrl callback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));

    const { createCloudflareTunnel } = await loadModule();
    let seen: string | null = null;

    await createCloudflareTunnel(
      { port: 4097 },
      vi.fn(() => fakeProcess()) as never,
      () => true,
      (url) => { seen = url; },
      () => SAVED,
    );

    expect(seen).toBe("https://code.example.com");
  }, 20000);

  it("keeps polling past a 530 before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 530 })
      .mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const { createCloudflareTunnel } = await loadModule();

    const result = await createCloudflareTunnel(
      { port: 4097 },
      vi.fn(() => fakeProcess()) as never,
      () => true,
      undefined,
      () => SAVED,
    );

    expect(result.url).toBe("https://code.example.com");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  }, 20000);

  it("keeps polling when the request throws", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const { createCloudflareTunnel } = await loadModule();

    const result = await createCloudflareTunnel(
      { port: 4097 },
      vi.fn(() => fakeProcess()) as never,
      () => true,
      undefined,
      () => SAVED,
    );

    expect(result.url).toBe("https://code.example.com");
  }, 20000);

  it("falls back to the free-tier branch when the domain is missing", async () => {
    const { createCloudflareTunnel } = await loadModule();
    const spawnFn = vi.fn(() => fakeProcess({ stdoutData: "https://free.trycloudflare.com" }));

    const result = await createCloudflareTunnel(
      { port: 4097 },
      spawnFn as never,
      () => true,
      undefined,
      () => ({ provider: "cloudflare", mode: "custom" as const, tunnelName: "opencode" }),
    );

    expect(result.url).toBe("https://free.trycloudflare.com");
  });

  it("falls back to the free-tier branch when the tunnel name is missing", async () => {
    const { createCloudflareTunnel } = await loadModule();
    const spawnFn = vi.fn(() => fakeProcess({ stdoutData: "https://free2.trycloudflare.com" }));

    const result = await createCloudflareTunnel(
      { port: 4097 },
      spawnFn as never,
      () => true,
      undefined,
      () => ({ provider: "cloudflare", mode: "custom" as const, domain: "code.example.com" }),
    );

    expect(result.url).toBe("https://free2.trycloudflare.com");
  });
});
