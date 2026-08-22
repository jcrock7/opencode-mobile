/**
 * metadata.test.ts - tunnel metadata persistence
 *
 * The module resolves its file path from process.env.HOME at import time, so
 * each test redirects HOME to a scratch directory and re-imports rather than
 * writing to the developer's real ~/.config.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let home = "";
let metadataFile = "";

async function loadModule() {
  vi.resetModules();
  return import("./metadata");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-metadata-"));
  process.env.HOME = home;
  metadataFile = path.join(home, ".config/opencode/tunnel.json");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadTunnelMetadata", () => {
  it("returns an all-null record when nothing is stored", async () => {
    const { loadTunnelMetadata } = await loadModule();
    expect(loadTunnelMetadata()).toEqual({
      url: null,
      tunnelId: null,
      provider: null,
      port: null,
      targetPort: null,
      startedAt: null,
      lastUpdated: null,
    });
  });

  it("reads back what was written", async () => {
    const { updateTunnelMetadata, loadTunnelMetadata } = await loadModule();
    updateTunnelMetadata("https://x.trycloudflare.com", "x", "cloudflare", 4097, 4097);

    const loaded = loadTunnelMetadata();
    expect(loaded.url).toBe("https://x.trycloudflare.com");
    expect(loaded.tunnelId).toBe("x");
    expect(loaded.provider).toBe("cloudflare");
    expect(loaded.port).toBe(4097);
    expect(loaded.targetPort).toBe(4097);
    expect(loaded.startedAt).toBeTruthy();
  });

  it("falls back to the empty record when the file is corrupt", async () => {
    const { loadTunnelMetadata } = await loadModule();
    fs.mkdirSync(path.dirname(metadataFile), { recursive: true });
    fs.writeFileSync(metadataFile, "{ not json");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadTunnelMetadata().url).toBeNull();
    expect(spy).toHaveBeenCalled();
  });
});

describe("saveTunnelMetadata", () => {
  it("creates the config directory on first write", async () => {
    const { saveTunnelMetadata } = await loadModule();
    expect(fs.existsSync(path.dirname(metadataFile))).toBe(false);

    const ok = saveTunnelMetadata({
      url: "https://a.example.com",
      tunnelId: "a",
      provider: "ngrok",
      port: 1,
      targetPort: 2,
      startedAt: null,
      lastUpdated: null,
    });

    expect(ok).toBe(true);
    expect(fs.existsSync(metadataFile)).toBe(true);
  });

  it("stamps lastUpdated", async () => {
    const { saveTunnelMetadata } = await loadModule();
    const record = {
      url: null,
      tunnelId: null,
      provider: null,
      port: null,
      targetPort: null,
      startedAt: null,
      lastUpdated: null,
    };
    saveTunnelMetadata(record);
    expect(record.lastUpdated).toBeTruthy();
    expect(() => new Date(record.lastUpdated as unknown as string).toISOString()).not.toThrow();
  });

  it("returns false rather than throwing when the path is unusable", async () => {
    // Point HOME at a regular file: creating .config under it fails with
    // ENOTDIR, which is the real-world shape of an unwritable location.
    const blocker = path.join(home, "not-a-dir");
    fs.writeFileSync(blocker, "");
    process.env.HOME = blocker;

    const { saveTunnelMetadata } = await loadModule();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      saveTunnelMetadata({
        url: null, tunnelId: null, provider: null, port: null,
        targetPort: null, startedAt: null, lastUpdated: null,
      }),
    ).toBe(false);
    expect(spy).toHaveBeenCalled();
  });
});

describe("clearTunnelMetadata", () => {
  it("blanks the record but keeps a lastUpdated stamp", async () => {
    const { updateTunnelMetadata, clearTunnelMetadata, loadTunnelMetadata } = await loadModule();
    updateTunnelMetadata("https://x.example.com", "x", "cloudflare", 4097, 4097);

    clearTunnelMetadata();

    const cleared = loadTunnelMetadata();
    expect(cleared.url).toBeNull();
    expect(cleared.tunnelId).toBeNull();
    expect(cleared.provider).toBeNull();
    expect(cleared.port).toBeNull();
    expect(cleared.targetPort).toBeNull();
    expect(cleared.startedAt).toBeNull();
    expect(cleared.lastUpdated).toBeTruthy();
  });
});
