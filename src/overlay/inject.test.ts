import { describe, it, expect } from "vitest";
import { injectOverlay, isInjected, isHtmlContentType, INJECT_ATTRIBUTE } from "./inject";

const OPTS = { cssPath: "/__oc-mobile/overlay.css", jsPath: "/__oc-mobile/overlay.js" };

// Trimmed to the parts that matter: OpenCode's real index.html sets the CSP
// via a header, ships a theme-preload script, and mounts into #root.
const DOC = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="utf-8" />',
  "    <title>OpenCode</title>",
  '    <script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
  "  </head>",
  "  <body>",
  '    <div id="root"></div>',
  "  </body>",
  "</html>",
].join("\n");

describe("injectOverlay", () => {
  it("inserts both tags before </head>", () => {
    const out = injectOverlay(DOC, OPTS);
    expect(out).toContain(`<link rel="stylesheet" href="${OPTS.cssPath}" ${INJECT_ATTRIBUTE}>`);
    expect(out).toContain(`<script src="${OPTS.jsPath}" defer ${INJECT_ATTRIBUTE}></script>`);
    expect(out.indexOf(OPTS.cssPath)).toBeLessThan(out.indexOf("</head>"));
    expect(out.indexOf(OPTS.jsPath)).toBeLessThan(out.indexOf("</head>"));
  });

  it("leaves the rest of the document byte-identical", () => {
    const out = injectOverlay(DOC, OPTS);
    const stripped = out
      .split("\n")
      .filter((line) => !line.includes(INJECT_ATTRIBUTE))
      .join("\n");
    expect(stripped).toBe(DOC);
  });

  it("does not disturb the theme-preload script the CSP hashes", () => {
    const out = injectOverlay(DOC, OPTS);
    expect(out).toContain('<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>');
  });

  it("injects the stylesheet only when no jsPath is given", () => {
    const out = injectOverlay(DOC, { cssPath: OPTS.cssPath });
    expect(out).toContain(OPTS.cssPath);
    expect(out).not.toContain("<script src=");
  });

  it("is idempotent", () => {
    const once = injectOverlay(DOC, OPTS);
    const twice = injectOverlay(once, OPTS);
    expect(twice).toBe(once);
  });

  it("does not stack tags when the marker is already present under other options", () => {
    const once = injectOverlay(DOC, OPTS);
    const twice = injectOverlay(once, { cssPath: "/other.css" });
    expect(twice).toBe(once);
    expect(twice).not.toContain("/other.css");
  });

  it("matches </head> case-insensitively and with whitespace", () => {
    const doc = "<html><HEAD><title>x</title></HEAD ><body></body></html>";
    const out = injectOverlay(doc, OPTS);
    expect(out.indexOf(OPTS.cssPath)).toBeLessThan(out.indexOf("</HEAD >"));
  });

  it("falls back to just after <body> when there is no head", () => {
    const doc = '<html><body class="x"><div id="root"></div></body></html>';
    const out = injectOverlay(doc, OPTS);
    expect(out).toContain(OPTS.cssPath);
    expect(out.indexOf('<body class="x">')).toBeLessThan(out.indexOf(OPTS.cssPath));
    expect(out.indexOf(OPTS.cssPath)).toBeLessThan(out.indexOf('<div id="root">'));
  });

  it("falls back to before </html> when there is no head or body", () => {
    const doc = "<html><div>x</div></html>";
    const out = injectOverlay(doc, OPTS);
    expect(out.indexOf(OPTS.cssPath)).toBeLessThan(out.indexOf("</html>"));
  });

  it("appends when the input is not a recognisable document", () => {
    const out = injectOverlay("just text", OPTS);
    expect(out.startsWith("just text")).toBe(true);
    expect(out).toContain(OPTS.cssPath);
  });

  it("returns empty input untouched", () => {
    expect(injectOverlay("", OPTS)).toBe("");
  });
});

describe("isInjected", () => {
  it("is false before and true after", () => {
    expect(isInjected(DOC)).toBe(false);
    expect(isInjected(injectOverlay(DOC, OPTS))).toBe(true);
  });
});

describe("isHtmlContentType", () => {
  it.each([
    ["text/html", true],
    ["text/html; charset=utf-8", true],
    ["TEXT/HTML", true],
    ["application/json", false],
    ["text/event-stream", false],
    ["text/css", false],
    ["application/javascript", false],
    [undefined, false],
    ["", false],
  ])("%s -> %s", (value, expected) => {
    expect(isHtmlContentType(value as string | undefined)).toBe(expected);
  });
});
