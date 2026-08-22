/**
 * token-store.test.ts - push token persistence
 *
 * The token file path is resolved from process.env.HOME at import time, so each
 * test redirects HOME to a scratch directory and re-imports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PushToken } from "./types";

let home = "";
let tokenFile = "";

async function loadModule() {
  vi.resetModules();
  return import("./token-store");
}

function token(overrides: Partial<PushToken> = {}): PushToken {
  return {
    token: "ExponentPushToken[abc]",
    platform: "ios",
    deviceId: "device-1",
    registeredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-tokens-"));
  process.env.HOME = home;
  tokenFile = path.join(home, ".config/opencode/push-tokens.json");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadTokens", () => {
  it("returns an empty list when nothing is stored", async () => {
    const { loadTokens } = await loadModule();
    expect(loadTokens()).toEqual([]);
  });

  it("reads back saved tokens", async () => {
    const { saveTokens, loadTokens } = await loadModule();
    saveTokens([token(), token({ token: "ExponentPushToken[def]", deviceId: "device-2" })]);

    const loaded = loadTokens();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].token).toBe("ExponentPushToken[abc]");
    expect(loaded[1].deviceId).toBe("device-2");
  });

  it("returns an empty list rather than throwing on a corrupt file", async () => {
    const { loadTokens } = await loadModule();
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, "not json at all");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadTokens()).toEqual([]);
    expect(spy).toHaveBeenCalled();
  });

  it("round-trips the optional serverUrl", async () => {
    const { saveTokens, loadTokens } = await loadModule();
    saveTokens([token({ serverUrl: "http://192.168.1.10:4096" })]);
    expect(loadTokens()[0].serverUrl).toBe("http://192.168.1.10:4096");
  });
});

describe("saveTokens", () => {
  it("creates the config directory on first write", async () => {
    const { saveTokens } = await loadModule();
    expect(fs.existsSync(path.dirname(tokenFile))).toBe(false);

    saveTokens([token()]);

    expect(fs.existsSync(tokenFile)).toBe(true);
  });

  it("writes readable JSON", async () => {
    const { saveTokens } = await loadModule();
    saveTokens([token()]);
    const raw = fs.readFileSync(tokenFile, "utf-8");
    expect(raw).toContain("\n");
    expect(JSON.parse(raw)).toHaveLength(1);
  });

  it("replaces the stored list rather than appending", async () => {
    const { saveTokens, loadTokens } = await loadModule();
    saveTokens([token(), token({ deviceId: "device-2" })]);
    saveTokens([token({ deviceId: "device-3" })]);

    const loaded = loadTokens();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].deviceId).toBe("device-3");
  });

  it("can store an empty list", async () => {
    const { saveTokens, loadTokens } = await loadModule();
    saveTokens([token()]);
    saveTokens([]);
    expect(loadTokens()).toEqual([]);
  });
});
