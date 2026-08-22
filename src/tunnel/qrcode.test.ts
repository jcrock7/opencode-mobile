/**
 * qrcode.test.ts - QR rendering helpers
 *
 * These are pure rendering functions over the qrcode/qrcode-terminal packages;
 * no network involved. The module keeps `lastDisplayedUrl` state to suppress
 * duplicate output, so tests re-import to reset it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const URL = "https://mock-tunnel.trycloudflare.com";

const ANSI = new RegExp("\\[[0-9;]*[A-Za-z]");

async function loadModule() {
  vi.resetModules();
  return import("./qrcode");
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("displayQRCode", () => {
  it("prints a QR and the url", async () => {
    const { displayQRCode } = await loadModule();
    await displayQRCode(URL);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain(URL);
    expect(logSpy).toHaveBeenCalled();
  });

  it("suppresses an immediately repeated url", async () => {
    const { displayQRCode } = await loadModule();
    await displayQRCode(URL);
    const first = logSpy.mock.calls.length;

    await displayQRCode(URL);
    expect(logSpy.mock.calls.length).toBe(first);
  });

  it("prints again for a different url", async () => {
    const { displayQRCode } = await loadModule();
    await displayQRCode(URL);
    const first = logSpy.mock.calls.length;

    await displayQRCode("https://other.trycloudflare.com");
    expect(logSpy.mock.calls.length).toBeGreaterThan(first);
  });

  it.each(["", "undefined", "not-a-url", "ftp://x"])("rejects %s", async (bad) => {
    const { displayQRCode } = await loadModule();
    await displayQRCode(bad);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("generateQRCodeAscii", () => {
  it("returns a multi-line block", async () => {
    const { generateQRCodeAscii } = await loadModule();
    const qr = await generateQRCodeAscii(URL);

    expect(qr.length).toBeGreaterThan(0);
    expect(qr.split("\n").length).toBeGreaterThan(5);
  });

  it("returns empty for an invalid url", async () => {
    const { generateQRCodeAscii } = await loadModule();
    expect(await generateQRCodeAscii("nope")).toBe("");
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("generateQRCodeAsciiPlain", () => {
  it("strips ANSI escapes", async () => {
    const { generateQRCodeAsciiPlain } = await loadModule();
    const qr = await generateQRCodeAsciiPlain(URL);

    expect(qr.length).toBeGreaterThan(0);
    expect(ANSI.test(qr)).toBe(false);
  });

  it("has no leading or trailing blank lines", async () => {
    const { generateQRCodeAsciiPlain } = await loadModule();
    const lines = (await generateQRCodeAsciiPlain(URL)).split("\n");

    expect(lines[0].trim()).not.toBe("");
    expect(lines[lines.length - 1].trim()).not.toBe("");
  });

  it("returns empty for an invalid url", async () => {
    const { generateQRCodeAsciiPlain } = await loadModule();
    expect(await generateQRCodeAsciiPlain("")).toBe("");
  });
});

describe("displayQRCodeAndSave", () => {
  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-qr-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the url when no path is given", async () => {
    const { displayQRCodeAndSave } = await loadModule();
    expect(await displayQRCodeAndSave(URL)).toBe(URL);
  });

  it("writes a png and returns its path", async () => {
    const { displayQRCodeAndSave } = await loadModule();
    const target = path.join(dir, "qr.png");

    expect(await displayQRCodeAndSave(URL, target)).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).size).toBeGreaterThan(0);
  });

  it("falls back to the url when the file cannot be written", async () => {
    const { displayQRCodeAndSave } = await loadModule();
    const target = path.join(dir, "missing-dir", "qr.png");

    expect(await displayQRCodeAndSave(URL, target)).toBe(URL);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("generateQRCodeDataUrl", () => {
  it("returns a png data url", async () => {
    const { generateQRCodeDataUrl } = await loadModule();
    const dataUrl = await generateQRCodeDataUrl(URL);

    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(100);
  });
});
