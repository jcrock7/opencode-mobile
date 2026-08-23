#!/usr/bin/env node
/**
 * `npm run preview` -- look at the overlay before someone else has to.
 *
 * Why this exists
 * ---------------
 * Every layout bug in this overlay so far was a DOM or CSS fact: an element
 * mounted outside the padded layout root and ended up under the status bar; a
 * dock grew past the screen and put its Submit button below the fold; two docks
 * rendered at once. None of them needed a phone to observe -- they needed
 * *something* to render the page and measure it. The unit tests run in happy-dom,
 * which has no layout engine at all: it will tell you an element exists and
 * cannot tell you where it is.
 *
 * So: render the real assets over a fixture of upstream's DOM in real Chromium
 * at a real phone size, screenshot it, and assert the geometry.
 *
 * What it proves, and what it does not
 * ------------------------------------
 * Proves: where things land, what covers what, what overflows, what is off
 * screen, and how the overlay's own script behaves against that DOM.
 *
 * Does not: upstream's real stylesheet is not here, so absolute pixel values
 * are the fixture's, not the app's -- the assertions are about relationships
 * (inside/outside, above/below, visible/clipped), which survive that. Solid's
 * timing is not here either. And `env(safe-area-inset-*)` is always 0 in
 * headless Chromium: there is no way to make it report a notch, so the notch is
 * drawn as an overlay bar and the inset test is structural instead -- is the
 * element inside the padded root, which is the thing that actually broke.
 */

import { chromium } from "playwright-core";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = process.env.PREVIEW_OUT || path.join(root, ".preview");
const fixture = path.join(here, "preview", "fixture.html");

// iPhone 14 Pro, and the inset it would report installed to the Home Screen.
const VIEWPORT = { width: 393, height: 852 };
const INSET_TOP = 59;
const SCALE = 2;

const { buildOverlayCss } = await import(path.join(root, "dist/src/overlay/mobile-css.js"));
const { buildOverlayJs } = await import(path.join(root, "dist/src/overlay/mobile-js.js"));
const { loadOverlayConfig } = await import(path.join(root, "dist/src/overlay/config.js"));

const config = loadOverlayConfig({ OPENCODE_MOBILE_OVERLAY_DEBUG: process.env.PREVIEW_DEBUG || "" });
const css = buildOverlayCss(config);
const js = buildOverlayJs({ ...config, askGraceMs: 0 });

const SESSIONS = [
  { id: "ses_a", title: "Navbar scrollbar fix & delete account", time: { created: 1, updated: 30 } },
  { id: "ses_b", title: "Miser Build", time: { created: 1, updated: 20 } },
  { id: "ses_c", title: "Mobile pairing", time: { created: 1, updated: 10 } },
];

const QUESTION = {
  id: "que_1",
  sessionID: "ses_a",
  questions: [
    {
      question: "An account's transactions reference it by foreign key, so the account row cannot be deleted while keeping those transactions. What should \"keep the data\" mean when deleting an account?",
      header: "Delete semantics",
      options: [
        { label: "Soft-delete, keep data (Recommended)", description: "Keep data (default) deactivates the account so it is hidden from the import selector, but all transactions and history stay intact." },
        { label: "Only allow delete when no data", description: "Accounts with transactions cannot be deleted at all." },
      ],
    },
  ],
};

/** Stub the endpoints the overlay reads, in the page, before its script runs. */
function stubApi({ sessions, statuses, questions, permissions }) {
  const data = { sessions, statuses, questions, permissions };
  window.__ocPreview = data;
  const native = window.fetch;
  window.fetch = (input, init) => {
    const url = String(typeof input === "string" ? input : input?.url ?? "");
    const body = url.startsWith("/question")
      ? data.questions
      : url.startsWith("/permission")
        ? data.permissions
        : url.includes("/session/status")
          ? data.statuses
          : url.includes("/session")
            ? data.sessions
            : null;
    if (body === null) return native(input, init);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  // The overlay learns its API addressing by watching the app's own calls, so
  // make one the way the app would.
  void window.fetch("/session?directory=%2Fhome%2Fjared%2Frepo");
  class Stub {
    constructor(url) {
      this.url = url;
      window.__ocStream = this;
    }
    close() {}
  }
  window.EventSource = Stub;
}

const scenarios = [
  {
    name: "01-strip-idle",
    what: "the consolidated chrome row, nothing pending",
    api: { sessions: SESSIONS, statuses: { ses_a: { type: "idle" } }, questions: [], permissions: [] },
  },
  {
    name: "02-strip-busy",
    what: "a session working, with the status bar above the composer",
    api: { sessions: SESSIONS, statuses: { ses_a: { type: "busy" } }, questions: [], permissions: [] },
    after: async (page) => {
      await page.evaluate(() => {
        window.__ocStream?.onmessage?.({
          data: JSON.stringify({
            type: "message.part.updated",
            properties: {
              sessionID: "ses_a",
              part: { type: "tool", callID: "c1", tool: "bash", state: { status: "running", title: "npm test", time: { start: Date.now() - 42_000 } } },
            },
          }),
        });
      });
    },
  },
  {
    name: "03-upstream-dock",
    what: "upstream's own question dock -- ours must not render",
    api: { sessions: SESSIONS, statuses: { ses_a: { type: "busy" } }, questions: [QUESTION], permissions: [] },
    before: async (page) => {
      await page.evaluate(() => {
        const tpl = document.getElementById("upstream-question-dock");
        document.getElementById("upstream-dock-slot").appendChild(tpl.content.cloneNode(true));
      });
    },
  },
  {
    name: "04-our-dock",
    what: "our dock, for when upstream's never arrives",
    api: { sessions: SESSIONS, statuses: { ses_a: { type: "busy" } }, questions: [QUESTION], permissions: [] },
  },
  {
    name: "05-dock-answered-elsewhere",
    what: "upstream's dock is answered and unmounts -- ours must not take over",
    api: { sessions: SESSIONS, statuses: { ses_a: { type: "busy" } }, questions: [QUESTION], permissions: [] },
    before: async (page) => {
      await page.evaluate(() => {
        const tpl = document.getElementById("upstream-question-dock");
        document.getElementById("upstream-dock-slot").appendChild(tpl.content.cloneNode(true));
      });
    },
    after: async (page) => {
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        document.querySelector('[data-component="session-question-dock"]')?.remove();
      });
      await page.waitForTimeout(400);
    },
  },
];

const checks = [];
function check(scenario, name, ok, detail) {
  checks.push({ scenario, name, ok, detail });
}

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.PREVIEW_CHROMIUM || "/opt/pw-browsers/chromium" });
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: SCALE,
  colorScheme: "dark",
  hasTouch: true,
  isMobile: true,
});

// Served from a URL shaped like a real session route, not from file://. The
// overlay reads the session id out of the path -- it deliberately swaps the id
// in the URL it is on rather than reconstructing OpenCode's routes -- so on a
// path with no /session/<id> in it, half the overlay correctly does nothing.
// The assets are served from the same origin at the paths the proxy uses.
const ORIGIN = "https://oc.preview";
const PAGE_URL = `${ORIGIN}/L3RtcC9wcm9q/session/ses_a`;
const fixtureHtml = fs.readFileSync(fixture, "utf-8");

async function newPage(scenario) {
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/__oc-mobile/overlay.css") {
      return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: css });
    }
    if (url.pathname === "/__oc-mobile/overlay.js") {
      return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: js });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      // One source of truth for the simulated inset: the fixture carries a
      // value so it is viewable on its own, and this owns it at run time.
      body: fixtureHtml.replace(/--sim-inset-top: \d+px/, `--sim-inset-top: ${INSET_TOP}px`),
    });
  });
  await page.addInitScript(`(${stubApi.toString()})(${JSON.stringify(scenario.api)})`);
  page.on("pageerror", (error) => {
    check(scenario.name, "no page errors", false, error.message);
  });
  return page;
}

for (const scenario of scenarios) {
  // A fresh page each time: addInitScript is additive, so reusing one page
  // stacks every scenario's stub on top of the last.
  const page = await newPage(scenario);
  await page.goto(PAGE_URL);
  if (scenario.before) await scenario.before(page);

  // Injected the way inject.ts does it: a same-origin <link> and a deferred
  // <script>, both carrying the marker.
  await page.evaluate(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/__oc-mobile/overlay.css";
    link.setAttribute("data-oc-mobile-overlay", "");
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "/__oc-mobile/overlay.js";
    script.defer = true;
    script.setAttribute("data-oc-mobile-overlay", "");
    document.head.appendChild(script);
  });
  await page.waitForTimeout(600);
  if (scenario.after) await scenario.after(page);
  await page.waitForTimeout(200);

  const facts = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const strip = document.querySelector("[data-oc-strip]");
    const layout = document.getElementById("layout-root");
    const submit = Array.from(document.querySelectorAll("button")).find(
      (el) => (el.textContent || "").trim() === "Submit",
    );
    return {
      stripBox: box(strip),
      stripHidden: strip ? strip.hidden : null,
      stripInsideLayout: !!(strip && layout && layout.contains(strip)),
      chips: Array.from(document.querySelectorAll("[data-oc-chip-label]")).map((el) => el.textContent),
      navButtons: Array.from(document.querySelectorAll("[data-oc-nav]")).map((el) => el.getAttribute("data-oc-nav")),
      hasChanges: !!document.querySelector("[data-oc-changes]"),
      titlebarShown: (() => {
        const el = document.querySelector('header[data-slot="titlebar-v2"]');
        return el ? getComputedStyle(el).display !== "none" : null;
      })(),
      ourDock: !!document.querySelector("[data-oc-ask]:not([hidden])"),
      upstreamDock: !!document.querySelector('[data-component="session-question-dock"]'),
      submitBox: box(submit),
      statusText: document.querySelector("[data-oc-status-text]")?.textContent ?? null,
      statusState: document.querySelector("[data-oc-status]")?.getAttribute("data-oc-state") ?? null,
      viewportHeight: window.innerHeight,
    };
  });

  const file = path.join(outDir, `${scenario.name}.png`);
  await page.screenshot({ path: file });

  console.log(`\n${scenario.name} -- ${scenario.what}`);
  console.log(`  ${path.relative(root, file)}`);

  if (facts.stripBox && !facts.stripHidden) {
    check(scenario.name, "strip is inside the padded layout root", facts.stripInsideLayout,
      facts.stripInsideLayout ? "" : "mounted above it: under the status bar on a Home Screen install");
    // env(safe-area-inset-*) is always 0 in headless Chromium and there is no
    // way to make it report a notch, so the fixture also honours a simulated
    // inset on the same element upstream pads. What is being checked is the
    // consequence -- does the strip start below the notch -- not the unit.
    check(scenario.name, "strip starts below the notch", facts.stripBox.top >= INSET_TOP,
      `top=${Math.round(facts.stripBox.top)}, inset=${INSET_TOP}`);
    check(scenario.name, "strip carries Home and New", facts.navButtons.join(",") === "home,new",
      facts.navButtons.join(",") || "none");
    check(scenario.name, "strip carries the changes button", facts.hasChanges);
    check(scenario.name, "upstream's titlebar is hidden", facts.titlebarShown === false,
      `display!=none: ${facts.titlebarShown}`);
  }

  const bothDocks = facts.ourDock && facts.upstreamDock;
  check(scenario.name, "never two answer docks", !bothDocks);

  if (scenario.name === "03-upstream-dock") {
    check(scenario.name, "ours stands down for upstream's", !facts.ourDock);
  }
  if (scenario.name === "04-our-dock") {
    check(scenario.name, "ours renders when upstream's is absent", facts.ourDock);
  }
  if (scenario.name === "05-dock-answered-elsewhere") {
    check(scenario.name, "ours does not take over an answered request", !facts.ourDock);
  }
  if (facts.submitBox) {
    check(scenario.name, "Submit is on screen",
      facts.submitBox.bottom <= facts.viewportHeight && facts.submitBox.top >= 0,
      `bottom=${Math.round(facts.submitBox.bottom)} viewport=${facts.viewportHeight}`);
  }
  if (scenario.name === "02-strip-busy") {
    check(scenario.name, "the status bar says what is running",
      (facts.statusText || "").includes("npm test"), facts.statusText ?? "none");
  }

  await page.close();
}

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log("\n" + "-".repeat(64));
for (const c of checks) {
  const detail = !c.ok && c.detail ? `  (${c.detail})` : "";
  console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.scenario}  ${c.name}${detail}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${path.relative(root, outDir)}/`);
process.exit(failed.length ? 1 : 0);
