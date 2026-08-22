/**
 * qrcode-fallback.test.ts - the pure-ASCII fallback and the error paths.
 *
 * `qrcode-terminal` is mocked so its output can be forced to the shapes that
 * trigger the fallback: whitespace-only (some hosts sanitise the block glyphs
 * away) and a throwing generate().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Controls what the mocked qrcode-terminal does, per test. */
const terminal: { mode: "normal" | "blank" | "throw" } = { mode: "normal" };

vi.mock("qrcode-terminal", () => ({
  default: {
    generate: (url: string, _options: unknown, callback: (qr: string) => void) => {
      if (terminal.mode === "throw") throw new Error("terminal unavailable");
      if (terminal.mode === "blank") {
        callback("\n   \n  \n");
        return;
      }
      callback(`[QR for ${url}]`);
    },
  },
}));

const URL = "https://mock-tunnel.trycloudflare.com";

async function loadModule() {
  vi.resetModules();
  return import("./qrcode");
}

beforeEach(() => {
  terminal.mode = "normal";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateQRCodeAsciiPlain fallback", () => {
  it("uses the terminal output when it has content", async () => {
    const { generateQRCodeAsciiPlain } = await loadModule();
    expect(await generateQRCodeAsciiPlain(URL)).toContain("[QR for");
  });

  it("falls back to a pure-ASCII grid when the terminal output is blank", async () => {
    terminal.mode = "blank";
    const { generateQRCodeAsciiPlain } = await loadModule();

    const qr = await generateQRCodeAsciiPlain(URL);

    expect(qr.length).toBeGreaterThan(0);
    // The fallback draws with '#' and '.' pairs.
    expect(qr).toContain("##");
    expect(qr).toContain("..");
    expect(qr.split("\n").length).toBeGreaterThan(10);
  });

  it("draws a square grid with a quiet-zone border", async () => {
    terminal.mode = "blank";
    const { generateQRCodeAsciiPlain } = await loadModule();

    const lines = (await generateQRCodeAsciiPlain(URL)).split("\n");

    // Every row is the same width.
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
    // The first row is the border: no dark modules.
    expect(lines[0].includes("#")).toBe(false);
  });

  it("returns empty when the terminal generator throws", async () => {
    terminal.mode = "throw";
    const { generateQRCodeAsciiPlain } = await loadModule();

    // The throw is caught, yielding "" from the terminal step, which then hits
    // the ASCII fallback -- so a real QR still comes back.
    const qr = await generateQRCodeAsciiPlain(URL);
    expect(qr).toContain("##");
  });
});

describe("error paths", () => {
  it("displayQRCode survives a throwing generator", async () => {
    terminal.mode = "throw";
    const { displayQRCode } = await loadModule();
    const logSpy = vi.spyOn(console, "log");

    await expect(displayQRCode(URL)).resolves.toBeUndefined();
    // It still prints the url so the user can type it.
    expect(logSpy.mock.calls.flat().join(" ")).toContain(URL);
  });

  it("generateQRCodeAscii returns empty when the generator throws", async () => {
    terminal.mode = "throw";
    const { generateQRCodeAscii } = await loadModule();
    expect(await generateQRCodeAscii(URL)).toBe("");
  });

  it("the ASCII fallback reports a failure for un-encodable input", async () => {
    terminal.mode = "blank";
    const { generateQRCodeAsciiPlain } = await loadModule();
    const errorSpy = vi.spyOn(console, "error");

    // Far beyond QR's capacity, so qrcode.create throws and the fallback
    // returns "" after logging.
    const huge = "https://x.example.com/" + "a".repeat(8000);
    const qr = await generateQRCodeAsciiPlain(huge);

    expect(qr).toBe("");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Failed to generate ASCII QR");
  });
});
