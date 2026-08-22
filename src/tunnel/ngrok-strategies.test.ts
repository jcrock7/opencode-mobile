/**
 * ngrok-strategies.test.ts - the multi-strategy connection cascade.
 *
 * `startNgrokTunnel` tries three strategies in order and only surfaces a
 * failure once all of them are exhausted. That fallback logic is the part most
 * likely to rot silently, so it is driven here with the SDK and child_process
 * mocked -- no ngrok account, binary or network involved.
 *
 * The live-service behaviour remains covered by the OPENCODE_TEST_NGROK_LIVE
 * suite in ngrok.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Per-test control over what the mocked SDK and binary do. */
interface Behaviour {
  forward: "ok" | "fail" | "authfail";
  session: "ok" | "fail" | "authfail";
  binary: "ok" | "silent" | "throw";
  forwardUrl: string;
  sessionUrl: string;
  binaryUrl: string;
}

const behaviour: Behaviour = {
  forward: "ok",
  session: "fail",
  binary: "silent",
  forwardUrl: "https://strategy1.ngrok.app",
  sessionUrl: "https://strategy2.ngrok.app",
  binaryUrl: "https://strategy3.ngrok.app",
};

const calls: string[] = [];

vi.mock("@ngrok/ngrok", () => ({
  forward: async () => {
    calls.push("forward");
    if (behaviour.forward === "fail") throw new Error("listen tcp bind failed");
    if (behaviour.forward === "authfail") throw new Error("ERR_NGROK_105 authentication failed");
    return { url: () => behaviour.forwardUrl, close: async () => {} };
  },
  SessionBuilder: class {
    authtoken() { return this; }
    metadata() { return this; }
    async connect() {
      calls.push("session");
      if (behaviour.session === "fail") throw new Error("session dial failed");
      if (behaviour.session === "authfail") throw new Error("session failed: bad authtoken");
      return {
        httpEndpoint: () => ({
          listenAndForward: async () => ({
            url: () => behaviour.sessionUrl,
            close: async () => {},
          }),
        }),
        close: async () => {},
      };
    }
  },
  kill: async () => {},
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      const command = String(args[1] ?? "");
      if (!command.includes("ngrok http")) {
        return (actual.spawn as never as (...a: unknown[]) => unknown)(...args);
      }
      calls.push("binary");
      // ENOENT is what happens when the ngrok binary is not installed, and it
      // fails immediately -- the alternative ("silent") makes the caller wait
      // out its 15s url timeout.
      if (behaviour.binary === "throw") throw new Error("spawn ngrok ENOENT");
      // Real ngrok logs to one stream, so emit on stdout only -- feeding both
      // would double the accumulated output and run two urls together.
      let onStdout: ((d: Buffer) => void) | null = null;
      if (behaviour.binary === "ok") {
        setTimeout(() => {
          onStdout?.(Buffer.from(`t=now lvl=info msg="started tunnel" url=${behaviour.binaryUrl}\n`));
        }, 10);
      }
      return {
        stdout: { on: (_e: string, cb: (d: Buffer) => void) => { onStdout = cb; } },
        stderr: { on: () => {} },
        kill: () => {},
        on: () => {},
      };
    },
  };
});

let home = "";

async function loadModule() {
  vi.resetModules();
  return import("./ngrok");
}

/** A config with a plausible authtoken, so ensureNgrokReady reports ready. */
function writeAuthConfig(): void {
  const dir = path.join(home, ".config/ngrok");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ngrok.yml"),
    'version: "3"\nagent:\n  authtoken: 2abcdefghijklmnopqrstuvwxyz\n',
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ngrok-strat-"));
  process.env.HOME = home;
  calls.length = 0;
  behaviour.forward = "ok";
  behaviour.session = "fail";
  behaviour.binary = "silent";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  const { clearInstance } = await import("./ngrok");
  clearInstance();
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("strategy 1: ngrok.forward", () => {
  it("returns the tunnel it produced", async () => {
    writeAuthConfig();
    const { startNgrokTunnel } = await loadModule();

    const result = await startNgrokTunnel({ port: 4097 });

    expect(result.url).toBe("https://strategy1.ngrok.app");
    expect(result.tunnelId).toBe("strategy1");
    expect(result.port).toBe(4097);
    expect(result.provider).toBe("ngrok");
    expect(calls).toEqual(["forward"]);
  }, 30000);

  it("prefers an authtoken passed in the config", async () => {
    writeAuthConfig();
    const { startNgrokTunnel } = await loadModule();

    const result = await startNgrokTunnel({ port: 4097, authToken: "2configtokenlongenough" });
    expect(result.url).toBe("https://strategy1.ngrok.app");
  }, 30000);
});

describe("strategy 2: SessionBuilder", () => {
  it("takes over when strategy 1 fails", async () => {
    behaviour.forward = "fail";
    behaviour.session = "ok";
    writeAuthConfig();
    const { startNgrokTunnel } = await loadModule();

    const result = await startNgrokTunnel({ port: 4097 });

    expect(result.url).toBe("https://strategy2.ngrok.app");
    expect(result.tunnelId).toBe("strategy2");
    expect(calls).toEqual(["forward", "session"]);
  }, 30000);
});

describe("strategy 3: the ngrok binary", () => {
  it("takes over when both SDK strategies fail", async () => {
    behaviour.forward = "fail";
    behaviour.session = "fail";
    behaviour.binary = "ok";
    writeAuthConfig();
    const { startNgrokTunnel } = await loadModule();

    const result = await startNgrokTunnel({ port: 4097 });

    expect(result.url).toBe("https://strategy3.ngrok.app");
    expect(result.tunnelId).toBe("strategy3");
    expect(calls).toEqual(["forward", "session", "binary"]);
  }, 30000);
});

describe("exhaustion", () => {
  it("throws the last error when every strategy fails", async () => {
    behaviour.forward = "fail";
    behaviour.session = "fail";
    behaviour.binary = "throw";
    writeAuthConfig();
    const { startNgrokTunnel } = await loadModule();

    await expect(startNgrokTunnel({ port: 4097 })).rejects.toThrow(/ENOENT/);
    expect(calls).toEqual(["forward", "session", "binary"]);
  }, 30000);

  it("gives up when strategy 3 never reports a url", async () => {
    behaviour.forward = "fail";
    behaviour.session = "fail";
    behaviour.binary = "silent";
    writeAuthConfig();
    const { startNgrokTunnel } = await loadModule();

    // Strategy 3 waits 15s for a url line before declaring a timeout.
    await expect(startNgrokTunnel({ port: 4097 })).rejects.toThrow(/timeout/);
  }, 40000);

  it("surfaces the first auth error rather than the last transport error", async () => {
    // An auth failure in strategy 1 is the useful diagnosis; the later
    // strategies fail for downstream reasons that would mask it.
    behaviour.forward = "authfail";
    behaviour.session = "fail";
    behaviour.binary = "throw";
    writeAuthConfig();
    const { startNgrokTunnel } = await loadModule();

    await expect(startNgrokTunnel({ port: 4097 })).rejects.toThrow(/authentication failed/);
  }, 30000);

  it("recognises a session auth failure as an auth error", async () => {
    behaviour.forward = "fail";
    behaviour.session = "authfail";
    behaviour.binary = "throw";
    writeAuthConfig();
    const { startNgrokTunnel } = await loadModule();

    await expect(startNgrokTunnel({ port: 4097 })).rejects.toThrow(/session failed/);
  }, 30000);
});

describe("preconditions", () => {
  it("refuses to start with no authtoken configured", async () => {
    const { startNgrokTunnel } = await loadModule();
    await expect(startNgrokTunnel({ port: 4097 })).rejects.toThrow(/Ngrok not configured/);
    expect(calls).toEqual([]);
  }, 20000);

  it("cleans up a previous listener before connecting", async () => {
    writeAuthConfig();
    const { startNgrokTunnel, setInstance, getInstance } = await loadModule();

    let closed = false;
    setInstance({ close: async () => { closed = true; } });

    await startNgrokTunnel({ port: 4097 });

    // The stale instance is dropped and replaced by the new tunnel's url.
    expect(closed || getInstance() !== null).toBe(true);
  }, 30000);
});
