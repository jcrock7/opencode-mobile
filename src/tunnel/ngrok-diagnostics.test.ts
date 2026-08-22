/**
 * ngrok-diagnostics.test.ts - the offline-reachable parts of the ngrok provider
 *
 * `diagnoseNgrok` locates its config via process.env.HOME, so HOME is pointed at
 * a scratch directory and the module re-imported per test. This keeps every case
 * below off the network except the authtoken-validation branch, which is
 * explicitly marked.
 *
 * The four connection strategies in `startNgrokTunnel` need the live ngrok
 * service and are covered by the OPENCODE_TEST_NGROK_LIVE suite in ngrok.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let home = "";

async function loadModule() {
  vi.resetModules();
  return import("./ngrok");
}

/** Write an ngrok.yml at the path diagnoseNgrok looks for on Linux. */
function writeConfig(contents: string): string {
  const dir = path.join(home, ".config/ngrok");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ngrok.yml");
  fs.writeFileSync(file, contents);
  return file;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ngrok-"));
  process.env.HOME = home;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("diagnoseNgrok", () => {
  it("reports the SDK as installed", async () => {
    const { diagnoseNgrok } = await loadModule();
    const result = await diagnoseNgrok();
    expect(result.installed).toBe(true);
  });

  it("returns the full diagnostics shape", async () => {
    const { diagnoseNgrok } = await loadModule();
    const result = await diagnoseNgrok();

    expect(result).toHaveProperty("installed");
    expect(result).toHaveProperty("authtokenConfigured");
    expect(result).toHaveProperty("authtokenValid");
    expect(result).toHaveProperty("existingTunnels");
    expect(result).toHaveProperty("configPath");
    expect(result).toHaveProperty("error");
  });

  it("reports no config when none exists", async () => {
    const { diagnoseNgrok } = await loadModule();
    const result = await diagnoseNgrok();

    expect(result.configPath).toBeNull();
    expect(result.error).toBe("No ngrok config found");
    expect(result.authtokenConfigured).toBe(false);
  });

  it("finds the config under ~/.config/ngrok", async () => {
    const file = writeConfig('version: "3"\n');
    const { diagnoseNgrok } = await loadModule();
    const result = await diagnoseNgrok();

    expect(result.configPath).toBe(file);
  });

  it("reports a config with no authtoken", async () => {
    writeConfig('version: "3"\n');
    const { diagnoseNgrok } = await loadModule();
    const result = await diagnoseNgrok();

    expect(result.authtokenConfigured).toBe(false);
    expect(result.error).toBe("No authtoken in config");
  });

  it("rejects an implausibly short authtoken", async () => {
    writeConfig("authtoken: short\n");
    const { diagnoseNgrok } = await loadModule();
    const result = await diagnoseNgrok();

    expect(result.authtokenConfigured).toBe(false);
    expect(result.error).toBe("No authtoken in config");
  });

  it("reports a read failure when the config path is a directory", async () => {
    // A directory where ngrok.yml should be: existsSync passes, readFileSync fails.
    fs.mkdirSync(path.join(home, ".config/ngrok/ngrok.yml"), { recursive: true });
    const { diagnoseNgrok } = await loadModule();
    const result = await diagnoseNgrok();

    expect(result.error).toMatch(/^Failed to read config:/);
  });

  // These reach the authtoken-validation branch, which shells out to curl.
  // Whether the call succeeds or fails, the function must resolve and report the
  // token as configured -- that is what is asserted.
  describe("with a plausible authtoken", () => {
    it("accepts the v2 format", async () => {
      writeConfig("authtoken: 2abcdefghijklmnopqrstuvwxyz\n");
      const { diagnoseNgrok } = await loadModule();
      const result = await diagnoseNgrok();

      expect(result.authtokenConfigured).toBe(true);
    }, 20000);

    it("accepts the v3 format", async () => {
      writeConfig('version: "3"\nagent:\n  authtoken: 2abcdefghijklmnopqrstuvwxyz\n');
      const { diagnoseNgrok } = await loadModule();
      const result = await diagnoseNgrok();

      expect(result.authtokenConfigured).toBe(true);
    }, 20000);
  });
});

describe("ensureNgrokReady", () => {
  it("is not ready when no authtoken is configured", async () => {
    const { ensureNgrokReady } = await loadModule();
    const result = await ensureNgrokReady({ interactive: false });

    expect(result.ready).toBe(false);
    expect(result.authtoken).toBeNull();
  });

  it("resolves rather than prompting when non-interactive", async () => {
    const { ensureNgrokReady } = await loadModule();
    // An interactive prompt would hang; resolving at all is the assertion.
    await expect(ensureNgrokReady({ interactive: false })).resolves.toBeDefined();
  });

  it("extracts the authtoken from a v3 config", async () => {
    writeConfig('version: "3"\nagent:\n  authtoken: 2abcdefghijklmnopqrstuvwxyz\n');
    const { ensureNgrokReady } = await loadModule();
    const result = await ensureNgrokReady({ interactive: false });

    if (result.ready) {
      expect(result.authtoken).toBe("2abcdefghijklmnopqrstuvwxyz");
    } else {
      // The validation branch decided the token was bad; it must still not hang.
      expect(result.authtoken).toBeNull();
    }
  }, 20000);
});

describe("isNgrokInstalled", () => {
  it("is true when the SDK resolves", async () => {
    const { isNgrokInstalled } = await loadModule();
    expect(await isNgrokInstalled()).toBe(true);
  });
});

describe("instance helpers", () => {
  it("round-trips an instance", async () => {
    const { setInstance, getInstance, clearInstance } = await loadModule();

    expect(getInstance()).toBeNull();
    const fake = { url: "https://x.ngrok.app" };
    setInstance(fake);
    expect(getInstance()).toBe(fake);

    clearInstance();
    expect(getInstance()).toBeNull();
  });
});

describe("stopNgrokTunnel", () => {
  it("closes and clears an injected instance", async () => {
    const { setInstance, getInstance, stopNgrokTunnel } = await loadModule();

    let closed = false;
    setInstance({ close: async () => { closed = true; } });

    await stopNgrokTunnel();

    expect(closed).toBe(true);
    expect(getInstance()).toBeNull();
  });

  it("survives an instance whose close throws", async () => {
    const { setInstance, getInstance, stopNgrokTunnel } = await loadModule();
    setInstance({ close: async () => { throw new Error("already gone"); } });

    await expect(stopNgrokTunnel()).resolves.toBeUndefined();
    expect(getInstance()).toBeNull();
  });

  it("is a no-op when nothing is running", async () => {
    const { stopNgrokTunnel } = await loadModule();
    await expect(stopNgrokTunnel()).resolves.toBeUndefined();
  });

  it("stopNgrok delegates to it", async () => {
    const { setInstance, getInstance, stopNgrok } = await loadModule();

    let closed = false;
    setInstance({ close: async () => { closed = true; } });

    await stopNgrok();

    expect(closed).toBe(true);
    expect(getInstance()).toBeNull();
  });
});

describe("startNgrokTunnel", () => {
  it("refuses to start when no authtoken is configured", async () => {
    const { startNgrokTunnel } = await loadModule();
    // Guards the fix that made the authtoken prompt non-interactive: before it,
    // this call blocked on stdin instead of throwing.
    await expect(startNgrokTunnel({ port: 4097 })).rejects.toThrow(/Ngrok not configured/);
  }, 20000);
});
