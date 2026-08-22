/**
 * filters.test.ts - notification filter config and matching
 *
 * The config path is resolved from os.homedir() at import time, so HOME is
 * redirected to a scratch directory and the module re-imported per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let home = "";
let configFile = "";

async function loadModule() {
  vi.resetModules();
  return import("./filters");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-filters-"));
  process.env.HOME = home;
  configFile = path.join(home, ".config/opencode-mobile/notification-filters.json");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadFilterConfig", () => {
  it("defaults to filtering mobile tool calls only", async () => {
    const { loadFilterConfig } = await loadModule();
    expect(loadFilterConfig()).toEqual({ mobileToolCall: true, spacedWordPrefix: false });
  });

  it("reads a stored config", async () => {
    const { saveFilterConfig, loadFilterConfig } = await loadModule();
    saveFilterConfig({ mobileToolCall: false, spacedWordPrefix: true });
    expect(loadFilterConfig()).toEqual({ mobileToolCall: false, spacedWordPrefix: true });
  });

  it("fills in a missing key from the defaults", async () => {
    const { loadFilterConfig } = await loadModule();
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ spacedWordPrefix: true }));

    expect(loadFilterConfig()).toEqual({ mobileToolCall: true, spacedWordPrefix: true });
  });

  it("falls back to defaults on a corrupt file", async () => {
    const { loadFilterConfig } = await loadModule();
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "{{{");

    expect(loadFilterConfig()).toEqual({ mobileToolCall: true, spacedWordPrefix: false });
  });
});

describe("saveFilterConfig", () => {
  it("creates the config directory", async () => {
    const { saveFilterConfig } = await loadModule();
    expect(fs.existsSync(path.dirname(configFile))).toBe(false);

    saveFilterConfig({ mobileToolCall: true, spacedWordPrefix: true });

    expect(fs.existsSync(configFile)).toBe(true);
  });

  it("swallows a write failure rather than throwing", async () => {
    const blocker = path.join(home, "not-a-dir");
    fs.writeFileSync(blocker, "");
    process.env.HOME = blocker;

    const { saveFilterConfig } = await loadModule();
    expect(() => saveFilterConfig({ mobileToolCall: true, spacedWordPrefix: false })).not.toThrow();
  });
});

describe("updateFilterSetting", () => {
  it("changes one key and leaves the other", async () => {
    const { updateFilterSetting, loadFilterConfig } = await loadModule();
    updateFilterSetting("spacedWordPrefix", true);

    expect(loadFilterConfig()).toEqual({ mobileToolCall: true, spacedWordPrefix: true });
  });

  it("can turn a setting back off", async () => {
    const { updateFilterSetting, loadFilterConfig } = await loadModule();
    updateFilterSetting("mobileToolCall", false);
    expect(loadFilterConfig().mobileToolCall).toBe(false);

    updateFilterSetting("mobileToolCall", true);
    expect(loadFilterConfig().mobileToolCall).toBe(true);
  });
});

describe("shouldFilterSession", () => {
  const ON = { mobileToolCall: true, spacedWordPrefix: false };
  const SPACED = { mobileToolCall: false, spacedWordPrefix: true };
  const OFF = { mobileToolCall: false, spacedWordPrefix: false };

  it("never filters a missing title", async () => {
    const { shouldFilterSession } = await loadModule();
    expect(shouldFilterSession(null, ON)).toBe(false);
    expect(shouldFilterSession("", ON)).toBe(false);
  });

  describe("mobileToolCall", () => {
    it("filters the mobile tool call prefix", async () => {
      const { shouldFilterSession } = await loadModule();
      expect(shouldFilterSession("Mobile tool call: qr", ON)).toBe(true);
    });

    it("ignores surrounding whitespace", async () => {
      const { shouldFilterSession } = await loadModule();
      expect(shouldFilterSession("   Mobile tool call: qr   ", ON)).toBe(true);
    });

    it("does not match mid-string", async () => {
      const { shouldFilterSession } = await loadModule();
      expect(shouldFilterSession("re: Mobile tool call: qr", ON)).toBe(false);
    });

    it("does nothing when disabled", async () => {
      const { shouldFilterSession } = await loadModule();
      expect(shouldFilterSession("Mobile tool call: qr", OFF)).toBe(false);
    });
  });

  describe("spacedWordPrefix", () => {
    it("filters a word-then-colon prefix", async () => {
      const { shouldFilterSession } = await loadModule();
      expect(shouldFilterSession("Refactor auth: split middleware", SPACED)).toBe(true);
    });

    it("filters a single word prefix", async () => {
      const { shouldFilterSession } = await loadModule();
      expect(shouldFilterSession("chore: bump deps", SPACED)).toBe(true);
    });

    it("leaves a title with no colon alone", async () => {
      const { shouldFilterSession } = await loadModule();
      expect(shouldFilterSession("Fix the tunnel retry loop", SPACED)).toBe(false);
    });

    it("leaves a colon after punctuation alone", async () => {
      const { shouldFilterSession } = await loadModule();
      expect(shouldFilterSession("fix(auth): tighten", SPACED)).toBe(false);
    });

    it("does nothing when disabled", async () => {
      const { shouldFilterSession } = await loadModule();
      expect(shouldFilterSession("chore: bump deps", OFF)).toBe(false);
    });
  });

  it("filters when either rule matches", async () => {
    const { shouldFilterSession } = await loadModule();
    const both = { mobileToolCall: true, spacedWordPrefix: true };
    expect(shouldFilterSession("Mobile tool call: qr", both)).toBe(true);
    expect(shouldFilterSession("chore: bump", both)).toBe(true);
    expect(shouldFilterSession("Fix the retry loop", both)).toBe(false);
  });
});

describe("getFilterStatus", () => {
  it("reports both switches", async () => {
    const { getFilterStatus } = await loadModule();
    const status = getFilterStatus();
    expect(status).toContain("Mobile tool call: ON");
    expect(status).toContain("Spaced word prefix: OFF");
  });

  it("reflects a changed setting", async () => {
    const { updateFilterSetting, getFilterStatus } = await loadModule();
    updateFilterSetting("spacedWordPrefix", true);
    expect(getFilterStatus()).toContain("Spaced word prefix: ON");
  });
});
