/**
 * mobile-js.dom.test.ts - behavioural tests for the injected script.
 *
 * The script is a string of browser JavaScript, so the only way to know it
 * works is to run it in a DOM. Everything it touches is stubbed here: a fake
 * composer dock and timeline to mount into, a fake EventSource to push events
 * through, and a fake fetch for the two endpoints it reads.
 *
 * Written after shipping two CSS rules that were wrong about the app's real
 * structure -- asserting on the generated source text would not have caught
 * either.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Window } from "happy-dom";
import { buildOverlayJs } from "./mobile-js";
import type { OverlayConfig } from "./types";

const CONFIG: OverlayConfig = {
  enabled: true,
  sessionStrip: true,
  statusBar: true,
  keyboardViewport: true,
  bubbles: true,
  changesButton: true,
  askDock: true,
  // Collapsed for most tests: the race the wait exists for has its own tests,
  // and every other one would otherwise sit out 2.5 real seconds.
  askGraceMs: 0,
  maxWidth: 767,
  debug: false,
};

const SESSIONS = [
  { id: "ses_a", title: "Migrate auth", time: { created: 1, updated: 20 } },
  { id: "ses_b", title: "Fix tunnel", time: { created: 1, updated: 10 } },
];

interface Harness {
  window: Window;
  document: Document;
  /** Push an SSE payload into the script. */
  emit(payload: unknown): void;
  status(): HTMLElement | null;
  strip(): HTMLElement | null;
  statusText(): string;
  statusState(): string;
  flush(): Promise<void>;
  /** The fake visual viewport, so a test can open and close the keyboard. */
  viewport: { height: number; offsetTop: number; emit(type: string): void };
  /** Every window.scrollTo the script performed. */
  scrollCalls: Array<[number, number]>;
  /** The inline height the script pinned on #root, or "" if it pinned none. */
  rootHeight(): string;
  /** Every request the overlay made, with its headers, method and body. */
  fetched: Array<{ url: string; headers: Record<string, string>; method: string; body: string }>;
  /** Override responses by URL. Return undefined to fall through, null for 404. */
  setResponder(fn: (url: string) => unknown): void;
  /** The injected titlebar button, if it mounted. */
  changesButton(): HTMLElement | null;
  /** One of upstream's own tab triggers. */
  trigger(value: string): HTMLElement | null;
  /** The session-strip chip labels, in order. */
  chips(): string[];
  /** One of the strip's proxy nav buttons. */
  nav(which: "home" | "new"): HTMLElement | null;
  /** Clicks recorded on upstream's own titlebar icon buttons. */
  titlebarClicks: string[];
  /** The injected ask dock, if it mounted. */
  ask(): HTMLElement | null;
  /** The dock's option buttons, in order. */
  askOptions(): HTMLElement[];
  /** The dock's footer buttons, in order. */
  askButtons(): HTMLElement[];
  /** The question text the dock is showing. */
  askText(): string;
}

/** Stand-in EventSource whose instances are captured so tests can emit. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

async function harness(
  options: {
    path?: string;
    sessions?: unknown;
    statusMap?: unknown;
    config?: Partial<OverlayConfig>;
    width?: number;
    withDock?: boolean;
    standalone?: boolean;
    viewportHeight?: number;
    scrolledBy?: number;
    withTabs?: boolean;
    changedFiles?: number;
    /** Answer with data only for calls that name an instance, as OpenCode does. */
    requireContext?: boolean;
    /** Pending question requests, as GET /question returns them. */
    pendingQuestions?: Array<{ id: string; sessionID: string }>;
    /** Pending permission requests, as GET /permission returns them. */
    pendingPermissions?: Array<{ id: string; sessionID: string }>;
    /** Put upstream's own question dock on the page, as a desktop width does. */
    withUpstreamDock?: boolean;
    /** Session ids upstream is showing as titlebar tabs. */
    openTabs?: string[];
    /** Upstream's grid-plus / plus titlebar buttons. Present unless false. */
    withTitlebarControls?: boolean;
  } = {},
): Promise<Harness> {
  const path = options.path ?? "/L3RtcC9wcm9q/session/ses_a";
  const win = new Window({
    url: "https://dev.example.org" + path,
    width: options.width ?? 390,
    height: 844,
  });
  const doc = win.document as unknown as Document;

  // A minimal stand-in for the parts of OpenCode's DOM the script anchors to.
  // The tab bar mirrors upstream's shape: a list of trigger wrappers, each
  // wrapping a Kobalte trigger that carries data-value and aria-selected.
  const tabs =
    options.withTabs === false
      ? ""
      : `
      <div data-component="tabs">
        <div data-slot="tabs-list">
          <div data-slot="tabs-trigger-wrapper" data-value="session">
            <button data-slot="tabs-trigger" data-value="session" aria-selected="true">Session</button>
          </div>
          <div data-slot="tabs-trigger-wrapper" data-value="changes">
            <button data-slot="tabs-trigger" data-value="changes" aria-selected="false">${
              options.changedFiles === undefined ? "Changes" : `${options.changedFiles} files changed`
            }</button>
          </div>
        </div>
      </div>`;

  const tabStrip = (options.openTabs ?? [])
    .map(
      (id) =>
        `<div data-titlebar-tab data-slot="titlebar-tab-item">` +
        `<a data-titlebar-tab-link href="/L3RtcC9wcm9q/session/${id}">${id}</a></div>`,
    )
    .join("");

  // Upstream's own titlebar controls, as IconButtonV2 really renders them: no
  // data-icon (it is commented out upstream), but each icon is a <use> against
  // a named sprite symbol, which is the only thing in the DOM that names it.
  const iconButton = (name: string) =>
    `<button data-component="icon-button-v2" data-icon-name="${name}">` +
    `<svg data-slot="icon-svg"><use href="#opencode-v2-icon-${name}"></use></svg></button>`;
  const titlebarControls =
    options.withTitlebarControls === false ? "" : iconButton("grid-plus") + iconButton("plus");

  doc.body.innerHTML = `
    <div id="root">
      <header data-slot="titlebar-v2">${titlebarControls}${tabStrip}</header>
      ${tabs}
      <div data-component="session-turn"><div data-slot="session-turn-content"></div></div>
      ${options.withDock === false ? "" : '<div data-component="session-prompt-dock"></div>'}
      ${options.withUpstreamDock ? '<div data-component="session-question-dock"></div>' : ""}
    </div>`;

  const titlebarClicks: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("[data-component=\"icon-button-v2\"]"))) {
    el.addEventListener("click", () => {
      titlebarClicks.push(el.getAttribute("data-icon-name") ?? "");
    });
  }

  // Upstream's triggers are a real tab control: clicking one selects it and
  // deselects its sibling. Without that the toggle cannot be tested at all.
  for (const el of Array.from(doc.querySelectorAll('[data-slot="tabs-trigger"]'))) {
    el.addEventListener("click", () => {
      for (const other of Array.from(doc.querySelectorAll('[data-slot="tabs-trigger"]'))) {
        other.setAttribute("aria-selected", other === el ? "true" : "false");
      }
    });
  }

  FakeEventSource.instances = [];
  const w = win as unknown as Record<string, unknown>;
  w.EventSource = FakeEventSource;

  const sessions = options.sessions ?? SESSIONS;
  const statusMap = options.statusMap ?? { ses_a: { type: "idle" }, ses_b: { type: "idle" } };
  const fetched: Array<{ url: string; headers: Record<string, string>; method: string; body: string }> = [];
  // A mutable responder rather than a re-mockable fetch: the overlay wraps
  // window.fetch to learn the app's addressing, so by the time a test runs the
  // global is its wrapper, not this stub.
  let responder: ((url: string) => unknown) | null = null;
  w.fetch = vi.fn((rawUrl: string, init?: { headers?: Record<string, string>; method?: string; body?: string }) => {
    // Real fetch stringifies whatever it is given; the stub must too, or a test
    // for odd input fails inside the stub rather than exercising the overlay.
    const url = String(rawUrl);
    fetched.push({
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      method: init?.method ?? "GET",
      body: init?.body ?? "",
    });
    // Only answer with data when the call is addressed the way the app
    // addresses it. An un-addressed call reaches an instance that knows about
    // nothing, which is what OpenCode really does -- 200 with an empty array.
    const addressed =
      options.requireContext !== true ||
      url.includes("directory=") ||
      !!(init?.headers as Record<string, string> | undefined)?.["x-opencode-directory"];
    if (responder) {
      const custom = responder(url);
      if (custom !== undefined) {
        const status = custom === null ? 404 : 200;
        return Promise.resolve({
          ok: status === 200,
          status,
          json: () => Promise.resolve(custom ?? {}),
        });
      }
    }
    const body = url.startsWith("/question")
      ? (options.pendingQuestions ?? [])
      : url.startsWith("/permission")
        ? (options.pendingPermissions ?? [])
        : url.includes("/session/status")
          ? statusMap
          : sessions;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(addressed ? body : []),
    });
  });

  // happy-dom implements matchMedia but neither predicate we need.
  w.matchMedia = (query: string) => {
    let matches: boolean;
    if (query.indexOf("display-mode") !== -1) {
      matches = options.standalone === true;
    } else {
      const m = /max-width:\s*(\d+)px/.exec(query);
      matches = (options.width ?? 390) <= (m ? Number(m[1]) : 0);
    }
    return {
      matches,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    };
  };

  // The keyboard fix reads visualViewport, which happy-dom does not provide,
  // and resets the document scroll, which it does not track usefully either.
  const vvListeners: Record<string, Array<() => void>> = {};
  const viewport = {
    height: options.viewportHeight ?? 844,
    offsetTop: 0,
    addEventListener(type: string, fn: () => void) {
      (vvListeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    emit(type: string) {
      for (const fn of vvListeners[type] ?? []) fn();
    },
  };
  w.visualViewport = viewport;

  const scrollCalls: Array<[number, number]> = [];
  Object.defineProperty(win, "scrollY", {
    value: options.scrolledBy ?? 0,
    writable: true,
    configurable: true,
  });
  w.scrollTo = (x: number, y: number) => {
    scrollCalls.push([x, y]);
    Object.defineProperty(win, "scrollY", { value: y, writable: true, configurable: true });
  };
  // Deterministic frames, so a flush() is enough to see the coalesced write.
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0) as unknown as number;

  const js = buildOverlayJs({ ...CONFIG, ...options.config });
  win.eval(js);

  const flush = async () => {
    // let the fetch promises and the script's own timers settle
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5));
  };
  await flush();

  const statusEl = () => doc.querySelector("[data-oc-status]") as HTMLElement | null;

  return {
    window: win,
    document: doc,
    emit(payload: unknown) {
      for (const es of FakeEventSource.instances) {
        es.onmessage?.({ data: JSON.stringify(payload) });
      }
    },
    status: statusEl,
    strip: () => doc.querySelector("[data-oc-strip]") as HTMLElement | null,
    statusText: () =>
      (statusEl()?.querySelector("[data-oc-status-text]") as HTMLElement | null)?.textContent ?? "",
    statusState: () => statusEl()?.getAttribute("data-oc-state") ?? "",
    flush,
    viewport,
    scrollCalls,
    rootHeight: () =>
      (doc.getElementById("root") as HTMLElement | null)?.style.getPropertyValue("height") ?? "",
    fetched,
    /** Override responses by URL. Return undefined to fall through, null for 404. */
    setResponder(fn: (url: string) => unknown) {
      responder = fn;
    },
    changesButton: () => doc.querySelector("[data-oc-changes]") as HTMLElement | null,
    trigger: (value: string) =>
      doc.querySelector(`[data-slot="tabs-trigger"][data-value="${value}"]`) as HTMLElement | null,
    chips: () =>
      Array.from(doc.querySelectorAll("[data-oc-chip-label]")).map((el) => el.textContent ?? ""),
    nav: (which: "home" | "new") =>
      doc.querySelector(`[data-oc-nav="${which}"]`) as HTMLElement | null,
    titlebarClicks,
    ask: () => {
      const el = doc.querySelector("[data-oc-ask]") as HTMLElement | null;
      return el && !el.hidden ? el : null;
    },
    askOptions: () =>
      Array.from(doc.querySelectorAll("[data-oc-ask-option]")) as unknown as HTMLElement[],
    askButtons: () =>
      Array.from(doc.querySelectorAll("[data-oc-ask-foot] > button")) as unknown as HTMLElement[],
    askText: () =>
      (doc.querySelector("[data-oc-ask-text]") as HTMLElement | null)?.textContent ?? "",
  };
}

function toolPart(overrides: Record<string, unknown> = {}) {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_a",
      part: {
        type: "tool",
        callID: "call_1",
        tool: "bash",
        state: { status: "running", title: "npm test", time: { start: Date.now() - 5000 } },
        ...overrides,
      },
    },
  };
}

let h: Harness | null = null;

beforeEach(() => {
  h = null;
});

afterEach(async () => {
  await h?.window.happyDOM?.close?.();
  vi.restoreAllMocks();
});

describe("mounting", () => {
  it("inserts the status bar immediately before the composer dock", async () => {
    h = await harness();
    const bar = h.status();
    expect(bar).not.toBeNull();
    expect(bar!.nextElementSibling?.getAttribute("data-component")).toBe("session-prompt-dock");
  });

  it("falls back to after the timeline when there is no dock", async () => {
    h = await harness({ withDock: false });
    expect(h.status()).not.toBeNull();
  });

  it("does not mount on a wide viewport", async () => {
    h = await harness({ width: 1200 });
    expect(h.status()).toBeNull();
    expect(h.strip()).toBeNull();
  });

  it("omits the status bar when the switch is off", async () => {
    h = await harness({ config: { statusBar: false } });
    expect(h.status()).toBeNull();
  });

  it("still mounts the status bar when the strip is off", async () => {
    h = await harness({ config: { sessionStrip: false } });
    expect(h.status()).not.toBeNull();
    expect(h.strip()).toBeNull();
  });
});

describe("what the agent is doing", () => {
  it("is hidden while the session is idle", async () => {
    h = await harness();
    expect(h.status()!.hidden).toBe(true);
  });

  it("names the running tool and its title", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart());

    expect(h.status()!.hidden).toBe(false);
    expect(h.statusState()).toBe("busy");
    expect(h.statusText()).toBe("bash · npm test");
  });

  it("shows just the tool when it has no distinct title", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart({ tool: "grep", state: { status: "running", title: "grep", time: { start: Date.now() } } }));
    expect(h.statusText()).toBe("grep");
  });

  it("counts elapsed time from the tool's own start", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart({ state: { status: "running", title: "npm test", time: { start: Date.now() - 65_000 } } }));

    const time = h.status()!.querySelector("[data-oc-status-time]")?.textContent;
    expect(time).toBe("1:05");
  });

  it("drops the label when that tool completes", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart());
    expect(h.statusText()).toBe("bash · npm test");

    h.emit(toolPart({ state: { status: "completed", title: "npm test", time: { start: 1, end: 2 } } }));
    // Still busy, but no specific tool to report.
    expect(h.status()!.hidden).toBe(false);
    expect(h.statusText()).toBe("Working");
  });

  it("ignores a tool from another session", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_b",
        part: { type: "tool", tool: "grep", state: { status: "running", time: { start: Date.now() } } },
      },
    });
    expect(h.statusText()).toBe("Working");
  });

  it("ignores non-tool parts", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit({
      type: "message.part.updated",
      properties: { sessionID: "ses_a", part: { type: "text", text: "hello" } },
    });
    expect(h.statusText()).toBe("Working");
  });

  it("hides again when the session goes idle", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart());
    expect(h.status()!.hidden).toBe(false);

    h.emit({ type: "session.idle", properties: { sessionID: "ses_a" } });
    expect(h.status()!.hidden).toBe(true);
  });

  it("reports a retry distinctly", async () => {
    h = await harness();
    h.emit({ type: "session.status", properties: { sessionID: "ses_a", status: { type: "retry" } } });
    expect(h.statusState()).toBe("busy");
    expect(h.statusText()).toBe("Retrying");
  });
});

describe("states that need you", () => {
  it("takes priority over a running tool", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart());
    h.emit({ type: "permission.asked", properties: { sessionID: "ses_a", id: "p1" } });

    expect(h.statusState()).toBe("attention");
    expect(h.statusText()).toBe("Waiting for you to approve");
  });

  it("clears when the permission is answered", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart());
    h.emit({ type: "permission.asked", properties: { sessionID: "ses_a", id: "p1" } });
    h.emit({ type: "permission.replied", properties: { sessionID: "ses_a", id: "p1" } });

    expect(h.statusState()).toBe("busy");
    expect(h.statusText()).toBe("bash · npm test");
  });

  it("reports an errored session", async () => {
    h = await harness();
    h.emit({ type: "session.error", properties: { sessionID: "ses_a", error: "boom" } });

    expect(h.statusState()).toBe("error");
    expect(h.statusText()).toBe("Session failed");
  });
});

describe("the session strip", () => {
  it("renders one chip per parent session", async () => {
    h = await harness();
    expect(h.strip()).not.toBeNull();
    expect(h.strip()!.querySelectorAll("[data-oc-chip]").length).toBe(2);
  });

  it("drops the chips with only one session, but keeps the bar", async () => {
    // One session is not a switcher. The bar itself stays, because it carries
    // the navigation and changes buttons now -- a row that came and went with
    // the session count would move everything under it.
    h = await harness({ sessions: [SESSIONS[0]] });
    expect(h.chips()).toEqual([]);
    expect(h.strip()!.hidden).toBe(false);
  });

  it("excludes child sessions", async () => {
    h = await harness({
      sessions: [...SESSIONS, { id: "ses_c", parentID: "ses_a", title: "sub", time: { created: 1, updated: 5 } }],
    });
    expect(h.strip()!.querySelectorAll("[data-oc-chip]").length).toBe(2);
  });

  it("marks the session in the URL as current", async () => {
    h = await harness();
    const current = h.strip()!.querySelector('[data-oc-current="true"]');
    expect(current?.textContent).toContain("Migrate auth");
  });

  it("sorts the session needing attention first", async () => {
    h = await harness();
    h.emit({ type: "permission.asked", properties: { sessionID: "ses_b", id: "p1" } });

    const first = h.strip()!.querySelector("[data-oc-chip]");
    expect(first?.getAttribute("data-oc-state")).toBe("attention");
    expect(first?.textContent).toContain("Fix tunnel");
  });

  it("builds hrefs by swapping the session id in the current path", async () => {
    h = await harness();
    const hrefs = [...h.strip()!.querySelectorAll("[data-oc-chip]")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/L3RtcC9wcm9q/session/ses_b");
  });
});

describe("one row of chrome instead of three", () => {
  // The phone had this strip, upstream's titlebar with its own session tabs,
  // and the session panel's title row -- two of them switching sessions. The
  // titlebar goes, so the strip has to carry what it carried.

  it("puts Home and New on the strip", async () => {
    h = await harness();

    expect(h.nav("home")).not.toBeNull();
    expect(h.nav("new")).not.toBeNull();
    expect(h.nav("home")!.parentElement?.getAttribute("data-oc-strip")).toBe("");
  });

  it("keeps the buttons out of the scrolling region", async () => {
    // Pinned either side of the chips, or they scroll away exactly when wanted.
    h = await harness();

    expect(h.nav("home")!.parentElement?.hasAttribute("data-oc-chips")).toBe(false);
    expect(h.document.querySelector("[data-oc-chip]")!.parentElement?.hasAttribute("data-oc-chips"))
      .toBe(true);
  });

  it("drives upstream's own Home button rather than reimplementing it", async () => {
    // IconButtonV2 sets no data-icon, but every v2 icon renders a <use> against
    // a named sprite symbol -- so the name is in the DOM either way.
    h = await harness();
    h.nav("home")!.click();

    expect(h.titlebarClicks).toEqual(["grid-plus"]);
  });

  it("drives upstream's own New button", async () => {
    h = await harness();
    h.nav("new")!.click();

    expect(h.titlebarClicks).toEqual(["plus"]);
  });

  it("does nothing rather than throwing when the control is not there", async () => {
    // An older build, or a layout that renders no titlebar at all.
    h = await harness({ withTitlebarControls: false });
    h.nav("home")!.click();

    expect(h.titlebarClicks).toEqual([]);
    expect(h.strip()).not.toBeNull();
  });

  it("mounts inside the layout root that carries the safe-area padding", async () => {
    // The bug this fixes: anchorPoint()'s last resort was "#root, first child",
    // which is OUTSIDE the padded layout container -- so on a Home Screen
    // install the strip rendered under the status bar with the clock on top of
    // the chips. It only showed up once the strip stopped hiding itself, since
    // that fallback is what a cold load takes before the timeline exists.
    h = await harness();
    const header = h.document.querySelector('header[data-slot="titlebar-v2"]')!;

    expect(h.strip()!.previousElementSibling).toBe(header);
  });

  it("moves to the titlebar anchor when it appears later", async () => {
    // A cold load renders the shell before the session, so the first mount can
    // land on a fallback. It has to move, not stay.
    h = await harness({ withDock: false, withTabs: false });
    const root = h.document.getElementById("root")!;
    root.innerHTML = "";
    await h.flush();
    // Nothing to anchor to yet.
    const header = h.document.createElement("header");
    header.setAttribute("data-slot", "titlebar-v2");
    root.appendChild(header);
    await h.flush();

    expect(h.strip()!.previousElementSibling).toBe(header);
  });

  it("orders the row: Home, the sessions, New, changes", async () => {
    h = await harness();
    const order = Array.from(h.strip()!.children).map(
      (el) =>
        el.getAttribute("data-oc-nav") ??
        (el.hasAttribute("data-oc-chips") ? "chips" : null) ??
        (el.hasAttribute("data-oc-changes") ? "changes" : "?"),
    );

    expect(order).toEqual(["home", "chips", "new", "changes"]);
  });
});

describe("resilience", () => {
  it("survives a malformed event", async () => {
    h = await harness();
    for (const es of FakeEventSource.instances) es.onmessage?.({ data: "not json" });
    expect(h.status()).not.toBeNull();
  });

  it("survives an event with no properties", async () => {
    h = await harness();
    h.emit({ type: "message.part.updated" });
    expect(h.status()).not.toBeNull();
  });

  it("keeps the bar and its buttons when the session list cannot be read", async () => {
    const win = new Window({ url: "https://dev.example.org/d/session/ses_a", width: 390 });
    const w = win as unknown as Record<string, unknown>;
    w.EventSource = FakeEventSource;
    w.matchMedia = () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    w.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }));
    (win.document as unknown as Document).body.innerHTML =
      '<div id="root"><div data-component="session-prompt-dock"></div></div>';

    win.eval(buildOverlayJs(CONFIG));
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5));

    const doc = win.document as unknown as Document;
    // No chips, since there is no list -- but the bar and its buttons stay, so
    // a failed request does not strand you with no way to navigate.
    expect(doc.querySelectorAll("[data-oc-chip]")).toHaveLength(0);
    expect((doc.querySelector("[data-oc-strip]") as HTMLElement).hidden).toBe(false);
    expect(doc.querySelector('[data-oc-nav="home"]')).not.toBeNull();
    await win.happyDOM?.close?.();
  });

  it("re-mounts the status bar if the app replaces the dock", async () => {
    h = await harness();
    const root = h.document.getElementById("root")!;
    h.status()!.remove();
    expect(h.status()).toBeNull();

    // A SPA re-render: swap the dock out and back.
    root.querySelector('[data-component="session-prompt-dock"]')!.remove();
    const dock = h.document.createElement("div");
    dock.setAttribute("data-component", "session-prompt-dock");
    root.appendChild(dock);

    await h.flush();
    expect(h.status()).not.toBeNull();
  });
});

describe("the keyboard viewport", () => {
  // Installed to the Home Screen, OpenCode sets `#root { height: 100vh }` --
  // the layout viewport, which iOS does not shrink for the software keyboard.
  // It shrinks only the visual viewport and scrolls the document to reveal the
  // focused field, which drags the shell up under the status bar and leaves
  // the composer adrift above the keyboard.

  it("pins the shell to the visible area when the keyboard opens", async () => {
    h = await harness({ standalone: true });
    expect(h.rootHeight()).toBe("");

    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();

    expect(h.rootHeight()).toBe("460px");
  });

  it("marks the pin important, since upstream's own height is not", async () => {
    h = await harness({ standalone: true });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();

    const root = h.document.getElementById("root") as HTMLElement;
    expect(root.style.getPropertyPriority("height")).toBe("important");
  });

  it("hands the height back when the keyboard closes", async () => {
    // Rather than leaving a pixel value pinned that the next rotation would
    // make wrong.
    h = await harness({ standalone: true });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();
    expect(h.rootHeight()).toBe("460px");

    h.viewport.height = 844;
    h.viewport.emit("resize");
    await h.flush();

    expect(h.rootHeight()).toBe("");
  });

  it("undoes the document scroll iOS applied to reach the composer", async () => {
    // This is the scroll that puts the timeline under the clock.
    h = await harness({ standalone: true, scrolledBy: 120 });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();

    expect(h.scrollCalls).toContainEqual([0, 0]);
  });

  it("leaves the height alone in a browser tab", async () => {
    // Safari's own toolbar collapses on scroll, which moves the visual
    // viewport for reasons that have nothing to do with the keyboard.
    h = await harness({ standalone: false });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();

    expect(h.rootHeight()).toBe("");
    expect(h.scrollCalls).toHaveLength(0);
  });

  it("leaves the height alone on a desktop viewport", async () => {
    h = await harness({ standalone: true, width: 1440 });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();

    expect(h.rootHeight()).toBe("");
  });

  it("coalesces the burst of events the keyboard animation fires", async () => {
    h = await harness({ standalone: true, scrolledBy: 120 });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    h.viewport.emit("scroll");
    h.viewport.emit("resize");
    await h.flush();

    // One frame, one write -- not one per event.
    expect(h.scrollCalls).toHaveLength(1);
  });

  it("marks the shell while the keyboard is open, and unmarks it after", async () => {
    // The mark is what lets the stylesheet collapse the bottom safe-area
    // inset: iOS keeps reporting it with the keyboard up, so the layout goes
    // on reserving a strip for a home indicator the keyboard is covering.
    h = await harness({ standalone: true });
    const root = () => h!.document.getElementById("root") as HTMLElement;
    expect(root().getAttribute("data-oc-keyboard")).toBeNull();

    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();
    expect(root().getAttribute("data-oc-keyboard")).toBe("open");

    h.viewport.height = 844;
    h.viewport.emit("resize");
    await h.flush();
    expect(root().getAttribute("data-oc-keyboard")).toBeNull();
  });

  it("does not mark the shell in a browser tab", async () => {
    h = await harness({ standalone: false });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();

    const root = h.document.getElementById("root") as HTMLElement;
    expect(root.getAttribute("data-oc-keyboard")).toBeNull();
  });

  it("renders no debug readout unless asked", async () => {
    h = await harness({ standalone: true });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();

    expect(h.document.querySelector("[data-oc-kbdebug]")).toBeNull();
  });

  it("reports the measurements it acts on when debug is enabled", async () => {
    // So the next round of this is a measurement rather than another attempt
    // to read a gap off a screenshot in pixels.
    h = await harness({ standalone: true, config: { debug: true } });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();

    const text = h.document.querySelector("[data-oc-kbdebug]")?.textContent ?? "";
    expect(text).toContain("kb open");
    expect(text).toContain("vv 460");
    expect(text).toContain("inner 844");
    expect(text).toContain("root 460");
    expect(text).toContain("sab ");
  });

  it("keeps the debug readout current when the keyboard closes", async () => {
    h = await harness({ standalone: true, config: { debug: true } });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();
    h.viewport.height = 844;
    h.viewport.emit("resize");
    await h.flush();

    const text = h.document.querySelector("[data-oc-kbdebug]")?.textContent ?? "";
    expect(text).toContain("kb closed");
    expect(text).toContain("root auto");
  });

  it("does nothing when the fix is switched off", async () => {
    h = await harness({ standalone: true, config: { keyboardViewport: false } });
    h.viewport.height = 460;
    h.viewport.emit("resize");
    await h.flush();

    expect(h.rootHeight()).toBe("");
  });

  it("still renders the strip and status bar with the fix off", async () => {
    // The switch must not take the rest of the overlay with it.
    h = await harness({
      standalone: true,
      statusMap: { ses_a: { type: "busy" } },
      config: { keyboardViewport: false },
    });
    h.emit(toolPart());
    await h.flush();

    expect(h.status()!.hidden).toBe(false);
    expect(h.statusText()).toBe("bash · npm test");
  });
});

describe("the diagnostic readout", () => {
  // Three rounds of this were spent inferring which gate the status bar was
  // failing at, from screenshots that could not show any of them. Every gate
  // between "the script runs" and "the bar is on screen" is now reported.
  it("renders nothing unless debug is on", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    expect(h.document.querySelector("[data-oc-diag]")).toBeNull();
  });

  it("reports the parsed route, the session count and the list result", async () => {
    h = await harness({ config: { debug: true }, statusMap: { ses_a: { type: "busy" } } });
    const line = h.document.querySelector("[data-oc-diag]")?.textContent ?? "";
    expect(line).toContain("route ses_a");
    expect(line).toContain("sess 2");
    expect(line).toContain("list 200");
  });

  it("reports the stream state and what it last received", async () => {
    h = await harness({ config: { debug: true }, statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart());
    await h.flush();

    const line = h.document.querySelector("[data-oc-diag]")?.textContent ?? "";
    expect(line).toContain("message.part.updated");
    expect(line).toMatch(/sse \w+\/[1-9]/);
  });

  it("reports the status and whether the bar is on screen", async () => {
    h = await harness({ config: { debug: true }, statusMap: { ses_a: { type: "busy" } } });
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("st busy");
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("bar shown");
  });

  it("says the bar is hidden, and why, for an idle session", async () => {
    // The exact case that produced "still nothing" with no way to tell which
    // gate closed.
    h = await harness({ config: { debug: true } });
    const line = h.document.querySelector("[data-oc-diag]")?.textContent ?? "";
    expect(line).toContain("st idle");
    expect(line).toContain("bar hidden");
  });

  it("reports a pending question as attention", async () => {
    h = await harness({ config: { debug: true }, statusMap: { ses_a: { type: "busy" } } });
    h.emit({ type: "question.asked", properties: { sessionID: "ses_a", id: "que_1" } });

    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("att question");
  });

  it("reports a route it could not parse", async () => {
    h = await harness({ config: { debug: true }, path: "/somewhere/else" });
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("route NONE");
  });
});

describe("blocked on a human", () => {
  // Both kinds stop the session dead. The status bar is the only on-screen
  // signal the overlay controls, and it has to say which is wanted.
  it("shows the approve wording for a permission", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit({ type: "permission.v2.asked", properties: { sessionID: "ses_a", action: "bash" } });

    expect(h.statusState()).toBe("attention");
    expect(h.statusText()).toBe("Waiting for you to approve");
  });

  it("shows the answer wording for a question", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit({ type: "question.asked", properties: { sessionID: "ses_a", id: "que_1" } });

    expect(h.statusState()).toBe("attention");
    expect(h.statusText()).toBe("Waiting for your answer");
  });

  it("handles the v2 question event too", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit({ type: "question.v2.asked", properties: { sessionID: "ses_a", id: "que_1" } });
    expect(h.statusText()).toBe("Waiting for your answer");
  });

  it("clears once the question is answered", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit({ type: "question.asked", properties: { sessionID: "ses_a", id: "que_1" } });
    expect(h.statusState()).toBe("attention");

    h.emit({ type: "question.replied", properties: { sessionID: "ses_a", requestID: "que_1" } });
    expect(h.statusState()).not.toBe("attention");
  });

  it("clears when the question is dismissed rather than answered", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit({ type: "question.asked", properties: { sessionID: "ses_a", id: "que_1" } });
    h.emit({ type: "question.rejected", properties: { sessionID: "ses_a", requestID: "que_1" } });
    expect(h.statusState()).not.toBe("attention");
  });

  it("marks the session chip as needing you", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" }, ses_b: { type: "busy" } } });
    h.emit({ type: "question.asked", properties: { sessionID: "ses_b", id: "que_1" } });

    const chip = Array.from(h.document.querySelectorAll("[data-oc-chip]")).find(
      (el) => el.querySelector("[data-oc-chip-label]")?.textContent === "Fix tunnel",
    ) as HTMLElement | undefined;
    expect(chip?.getAttribute("data-oc-state")).toBe("attention");
  });
});

describe("sub-agent sessions", () => {
  // Child sessions are excluded from the strip as chips of their own, but the
  // work they do has to be visible somewhere: it used to show nowhere at all.
  const WITH_CHILD = [
    { id: "ses_a", title: "Migrate auth", time: { created: 1, updated: 20 } },
    { id: "ses_b", title: "Fix tunnel", time: { created: 1, updated: 10 } },
    { id: "ses_c", title: "Search callers", parentID: "ses_a", time: { created: 2, updated: 21 } },
    { id: "ses_d", title: "Read schema", parentID: "ses_a", time: { created: 2, updated: 22 } },
  ];

  function childTool(sessionID: string, tool: string, title: string) {
    return {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          type: "tool",
          callID: "call_" + sessionID,
          tool,
          state: { status: "running", title, time: { start: Date.now() - 3000 } },
        },
      },
    };
  }

  it("reports a sub-agent's tool on the parent's status bar", async () => {
    // The parent is busy with no tool of its own while it delegates, so the bar
    // used to say only "Working" and the delegated work was invisible.
    h = await harness({
      sessions: WITH_CHILD,
      statusMap: { ses_a: { type: "busy" }, ses_c: { type: "busy" } },
    });
    h.emit(childTool("ses_c", "grep", "callers of migrate()"));

    expect(h.status()!.hidden).toBe(false);
    expect(h.statusText()).toBe("sub-agent · grep · callers of migrate()");
  });

  it("prefers the session's own tool over a sub-agent's", async () => {
    h = await harness({
      sessions: WITH_CHILD,
      statusMap: { ses_a: { type: "busy" }, ses_c: { type: "busy" } },
    });
    h.emit(childTool("ses_c", "grep", "callers"));
    h.emit(childTool("ses_a", "bash", "npm test"));

    expect(h.statusText()).toBe("bash · npm test");
  });

  it("does not let a sub-agent finishing clear its parent's tool", async () => {
    h = await harness({
      sessions: WITH_CHILD,
      statusMap: { ses_a: { type: "busy" } },
    });
    h.emit(childTool("ses_a", "bash", "npm test"));
    h.emit({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_c",
        part: {
          type: "tool",
          callID: "call_c",
          tool: "bash",
          state: { status: "completed", title: "npm test", time: { start: 1 } },
        },
      },
    });

    expect(h.statusText()).toBe("bash · npm test");
  });

  it("does not let another session's tool overwrite the one on screen", async () => {
    // The tracker used to be a single global, so a tool starting anywhere
    // relabelled the bar for the session you were looking at.
    h = await harness({
      sessions: WITH_CHILD,
      statusMap: { ses_a: { type: "busy" }, ses_b: { type: "busy" } },
    });
    h.emit(childTool("ses_a", "bash", "npm test"));
    h.emit(childTool("ses_b", "edit", "tunnel.ts"));

    expect(h.statusText()).toBe("bash · npm test");
  });

  it("badges the parent chip with its busy sub-agent count", async () => {
    h = await harness({
      sessions: WITH_CHILD,
      statusMap: { ses_a: { type: "busy" }, ses_c: { type: "busy" }, ses_d: { type: "busy" } },
    });

    const chips = h.document.querySelectorAll("[data-oc-chip]");
    const first = chips[0] as HTMLElement;
    expect(first.querySelector("[data-oc-chip-sub]")?.textContent).toBe("+2");
    expect(first.getAttribute("aria-label")).toContain("2 sub-agents");
  });

  it("counts a sub-agent that is running a tool but has no status entry", async () => {
    h = await harness({ sessions: WITH_CHILD, statusMap: { ses_a: { type: "busy" } } });
    h.emit(childTool("ses_c", "grep", "callers"));
    await h.flush();

    const first = h.document.querySelector("[data-oc-chip]") as HTMLElement;
    expect(first.querySelector("[data-oc-chip-sub]")?.textContent).toBe("+1");
  });

  it("gives sub-agents no chip of their own", async () => {
    // Several can run at once; their chips would push the sessions you
    // navigate by off the end of the strip.
    h = await harness({
      sessions: WITH_CHILD,
      statusMap: { ses_a: { type: "busy" }, ses_c: { type: "busy" }, ses_d: { type: "busy" } },
    });

    const labels = Array.from(h.document.querySelectorAll("[data-oc-chip-label]")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Migrate auth", "Fix tunnel"]);
  });

  it("drops the badge once the sub-agents go idle", async () => {
    h = await harness({
      sessions: WITH_CHILD,
      statusMap: { ses_a: { type: "busy" }, ses_c: { type: "busy" } },
    });
    expect(h.document.querySelector("[data-oc-chip-sub]")).not.toBeNull();

    h.emit({ type: "session.status", properties: { sessionID: "ses_c", status: { type: "idle" } } });

    expect(h.document.querySelector("[data-oc-chip-sub]")).toBeNull();
  });

  it("falls back to the parent's own label when no sub-agent has a tool yet", async () => {
    h = await harness({
      sessions: WITH_CHILD,
      statusMap: { ses_a: { type: "busy" }, ses_c: { type: "busy" } },
    });

    expect(h.statusText()).toBe("Working");
  });
});

describe("the changes button", () => {
  // Replaces upstream's Session / Changes tab bar, which costs a permanent row
  // above the timeline. It drives upstream's own triggers, because `mobileTab`
  // is local component state in session.tsx rather than a route.

  it("mounts onto the session strip", async () => {
    // The strip replaced the titlebar on a phone, so this is where the rest of
    // the chrome lives.
    h = await harness();
    const button = h.changesButton();
    expect(button).not.toBeNull();
    expect(button!.parentElement?.getAttribute("data-oc-strip")).toBe("");
  });

  it("falls back to the titlebar when the strip is switched off", async () => {
    // The titlebar is only hidden when the strip is on to replace it, so with
    // the strip off the header is still there -- and still the right host.
    h = await harness({ config: { sessionStrip: false } });
    const button = h.changesButton();
    expect(button).not.toBeNull();
    expect(button!.parentElement?.tagName.toLowerCase()).toBe("header");
  });

  it("shows the changes panel by clicking upstream's own trigger", async () => {
    h = await harness();
    h.changesButton()!.click();

    expect(h.trigger("changes")!.getAttribute("aria-selected")).toBe("true");
    expect(h.trigger("session")!.getAttribute("aria-selected")).toBe("false");
  });

  it("becomes a close control once the changes panel is showing", async () => {
    h = await harness();
    h.changesButton()!.click();
    await h.flush();

    const button = h.changesButton()!;
    expect(button.getAttribute("data-oc-changes")).toBe("open");
    expect(button.getAttribute("aria-label")).toBe("Back to the session");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("returns to the session on the second tap", async () => {
    h = await harness();
    h.changesButton()!.click();
    await h.flush();
    h.changesButton()!.click();
    await h.flush();

    expect(h.trigger("session")!.getAttribute("aria-selected")).toBe("true");
    expect(h.changesButton()!.getAttribute("data-oc-changes")).toBe("closed");
  });

  it("follows the tab changing without us", async () => {
    // Opening a review comment switches the tab upstream; the button must not
    // then claim the session is showing.
    h = await harness();
    h.trigger("changes")!.click();
    await h.flush();

    expect(h.changesButton()!.getAttribute("data-oc-changes")).toBe("open");
  });

  it("badges the changed-file count from the tab's own label", async () => {
    // Reading the digits survives translation; matching the words would not.
    h = await harness({ changedFiles: 7 });
    const badge = h.changesButton()!.querySelector("[data-oc-changes-count]");
    expect(badge?.textContent).toBe("7");
  });

  it("shows no badge when nothing has changed", async () => {
    h = await harness();
    expect(h.changesButton()!.querySelector("[data-oc-changes-count]")).toBeNull();
  });

  it("drops the badge while the changes panel is open", async () => {
    // The count is a reason to look; it is noise once you are looking.
    h = await harness({ changedFiles: 3 });
    h.changesButton()!.click();
    await h.flush();

    expect(h.changesButton()!.querySelector("[data-oc-changes-count]")).toBeNull();
  });

  it("does not mount where upstream renders no tab bar", async () => {
    // A desktop width, or no session open: there is nothing to toggle.
    h = await harness({ withTabs: false });
    expect(h.changesButton()).toBeNull();
  });

  it("does not mount on a desktop viewport", async () => {
    h = await harness({ width: 1440 });
    expect(h.changesButton()).toBeNull();
  });

  it("does not spin the DOM observer with its own writes", async () => {
    // The regression that broke every control on the page. The overlay watches
    // document.body for childList changes to re-mount after SPA navigation.
    // renderChanges() writes innerHTML, which IS a childList change in body --
    // so the observer re-entered on its own output, forever, pegging the main
    // thread. Nothing on the page answered a tap.
    h = await harness({ changedFiles: 2 });

    let writes = 0;
    const spy = new (h.window as unknown as {
      MutationObserver: typeof MutationObserver;
    }).MutationObserver(() => {
      writes += 1;
    });
    spy.observe(h.changesButton()!, { childList: true, subtree: true });

    // One external mutation, of the kind SPA navigation produces.
    const root = h.document.getElementById("root")!;
    root.appendChild(h.document.createElement("div"));
    await h.flush();
    spy.disconnect();

    // Settling costs a write or two; a loop costs hundreds.
    expect(writes).toBeLessThan(5);
  });

  it("does not spin on the strip's or the status bar's writes either", async () => {
    // Same shape, and they only escaped by luck: the strip rebuilds its chips
    // and the status bar rewrites its text, both childList mutations in body.
    // With two sessions and a busy one, all three renderers are live.
    h = await harness({ statusMap: { ses_a: { type: "busy" }, ses_b: { type: "busy" } } });
    h.emit(toolPart());
    await h.flush();

    let writes = 0;
    const spy = new (h.window as unknown as {
      MutationObserver: typeof MutationObserver;
    }).MutationObserver((records) => {
      writes += records.length;
    });
    spy.observe(h.document.getElementById("root")!, { childList: true, subtree: true });

    h.document.getElementById("root")!.appendChild(h.document.createElement("div"));
    await h.flush();
    spy.disconnect();

    expect(h.strip()).not.toBeNull();
    expect(h.status()!.hidden).toBe(false);
    expect(writes).toBeLessThan(20);
  });

  it("does not mount when switched off", async () => {
    h = await harness({ config: { changesButton: false } });
    expect(h.changesButton()).toBeNull();
  });

  it("mounts without the strip or status bar, and polls nothing", async () => {
    // The button reads the DOM only, so it must survive both being disabled --
    // and must not open an event stream to do it.
    h = await harness({
      config: { sessionStrip: false, statusBar: false, askDock: false, changesButton: true },
    });

    expect(h.changesButton()).not.toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

describe("addressing the API the way the app does", () => {
  // The bug this exists for: OpenCode resolves an instance per request from
  // `?directory=` or `x-opencode-directory`, and on top of that there is a
  // workspace/server proxy layer. A call naming none succeeds and returns
  // nothing -- 200 with an empty array -- so it looks exactly like having no
  // sessions. The v2 route encodes a server key, not a directory, so there is
  // nothing in the URL to reconstruct it from. The only reliable source is the
  // app's own calls.

  it("starts with no context and reports it", async () => {
    h = await harness({ config: { debug: true } });
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("ctx none");
  });

  it("learns the query the app uses and reuses it", async () => {
    h = await harness({ config: { debug: true } });
    // The app makes a call of its own.
    await (h.window as unknown as { fetch: typeof fetch }).fetch(
      "/session?directory=%2Fhome%2Fdev%2Fmiser",
    );
    await h.flush();

    const ours = h.fetched.filter((call) => call.url.startsWith("/session"));
    expect(ours.some((call) => call.url.includes("directory=%2Fhome%2Fdev%2Fmiser"))).toBe(true);
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("ctx ?directory=");
  });

  it("learns the directory header when the app sends one instead", async () => {
    h = await harness();
    await (h.window as unknown as { fetch: typeof fetch }).fetch("/session", {
      headers: { "x-opencode-directory": "/home/dev/miser" },
    });
    await h.flush();

    const ours = h.fetched.filter((call) => call.headers["x-opencode-directory"]);
    expect(ours.some((call) => call.headers["x-opencode-directory"] === "/home/dev/miser")).toBe(true);
  });

  it("re-points the event stream at the learned context", async () => {
    // The stream is the half the overlay could never fix by other means:
    // EventSource cannot set a header, so the query is the only handle.
    h = await harness();
    await (h.window as unknown as { fetch: typeof fetch }).fetch(
      "/session?directory=%2Fhome%2Fdev%2Fmiser",
    );
    await h.flush();

    const urls = FakeEventSource.instances.map((es) => es.url);
    expect(urls.some((url) => url.includes("directory=%2Fhome%2Fdev%2Fmiser"))).toBe(true);
  });

  it("finds the sessions it could not see before", async () => {
    // End to end: with the server answering only addressed calls, the strip
    // stays empty until the context is learned, then fills.
    h = await harness({ requireContext: true, config: { debug: true } });
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("sess 0");

    await (h.window as unknown as { fetch: typeof fetch }).fetch(
      "/session?directory=%2Fhome%2Fdev%2Fmiser",
    );
    await h.flush();

    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("sess 2");
  });

  it("keeps only the addressing, discarding the caller's pagination", async () => {
    // The observed failure: the app fetches
    // '/session/<id>/message?limit=200&before=<cursor>'. Taking the whole query
    // taught the overlay the pagination, which it then appended to '/session'
    // -- asking the wrong question and getting an empty list back.
    h = await harness({ config: { debug: true } });
    await (h.window as unknown as { fetch: typeof fetch }).fetch(
      "/session/ses_a/message?limit=200&before=cursor123&directory=%2Fhome%2Fdev%2Fmiser",
    );
    await h.flush();

    const line = h.document.querySelector("[data-oc-diag]")?.textContent ?? "";
    expect(line).toContain("ctx ?directory=");
    expect(line).not.toContain("limit=");
    expect(line).not.toContain("before=");

    const ours = h.fetched.filter((call) => call.url.startsWith("/session?"));
    expect(ours.length).toBeGreaterThan(0);
    for (const call of ours) {
      expect(call.url).not.toContain("limit=");
      expect(call.url).not.toContain("before=");
    }
  });

  it("does not let a paginated call unlearn a good context", async () => {
    // The second observed failure: a later call carrying no directory replaced
    // the working context with its own pagination.
    h = await harness({ config: { debug: true } });
    const appFetch = (h.window as unknown as { fetch: typeof fetch }).fetch;

    await appFetch("/session?directory=%2Fhome%2Fdev%2Fmiser");
    await h.flush();
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("ctx ?directory=");

    await appFetch("/session/ses_a/message?limit=20");
    await h.flush();
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("ctx ?directory=");
  });

  it("keeps a workspace parameter, which also selects an instance", async () => {
    h = await harness({ config: { debug: true } });
    await (h.window as unknown as { fetch: typeof fetch }).fetch(
      "/session?workspace=ws_1&limit=50",
    );
    await h.flush();

    const line = h.document.querySelector("[data-oc-diag]")?.textContent ?? "";
    expect(line).toContain("workspace=ws_1");
    expect(line).not.toContain("limit=");
  });

  it("relearns when the project changes", async () => {
    h = await harness({ config: { debug: true } });
    const appFetch = (h.window as unknown as { fetch: typeof fetch }).fetch;

    await appFetch("/session?directory=%2Fa");
    await h.flush();
    await appFetch("/session?directory=%2Fb");
    await h.flush();

    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("directory=%2Fb");
  });

  it("ignores a call that teaches nothing", async () => {
    h = await harness({ config: { debug: true } });
    await (h.window as unknown as { fetch: typeof fetch }).fetch("/session");
    await h.flush();
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("ctx none");
  });

  it("reports the status endpoint's own code", async () => {
    // /session/status is a forwarded route while GET /session is answered
    // locally, so the two can fail independently.
    h = await harness({ config: { debug: true } });
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("list 200/200");
  });

  it("ignores calls to paths that are not the session API", async () => {
    h = await harness({ config: { debug: true } });
    await (h.window as unknown as { fetch: typeof fetch }).fetch("/config?directory=%2Fwrong");
    await h.flush();
    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("ctx none");
  });

  it("leaves the app's own fetch working and untouched", async () => {
    // Wrapping a global in someone else's app must be invisible to it.
    h = await harness();
    const res = await (h.window as unknown as { fetch: typeof fetch }).fetch("/session");
    expect(res.status).toBe(200);
  });

  it("survives a fetch it cannot make sense of", async () => {
    h = await harness();
    const f = (h.window as unknown as { fetch: typeof fetch }).fetch;
    await expect(f(undefined as unknown as string)).resolves.toBeDefined();
    await expect(f({ weird: true } as unknown as string)).resolves.toBeDefined();
  });
});

describe("a request that was already pending", () => {
  // The monitoring case, and the one that was broken: `attention` was only ever
  // set from a live event, so anything asked BEFORE the page loaded was
  // invisible. Open the phone an hour after the agent asked something and the
  // overlay showed no sign of it -- the event had come and gone.

  it("shows a question asked before the page loaded", async () => {
    h = await harness({
      statusMap: { ses_a: { type: "idle" } },
      pendingQuestions: [{ id: "que_1", sessionID: "ses_a" }],
    });
    await h.flush();

    expect(h.statusState()).toBe("attention");
    expect(h.statusText()).toBe("Waiting for your answer");
  });

  it("shows a permission asked before the page loaded", async () => {
    h = await harness({
      statusMap: { ses_a: { type: "idle" } },
      pendingPermissions: [{ id: "per_1", sessionID: "ses_a" }],
    });
    await h.flush();

    expect(h.statusText()).toBe("Waiting for you to approve");
  });

  it("keeps a request the fetch found after a live reply for a different one", async () => {
    h = await harness({
      pendingQuestions: [{ id: "que_1", sessionID: "ses_a" }],
    });
    await h.flush();
    h.emit({ type: "question.replied", properties: { sessionID: "ses_b", requestID: "que_9" } });

    expect(h.statusState()).toBe("attention");
  });

  it("goes amber on a running question tool, without waiting for a fetch", async () => {
    // The gap behind "it didn't turn amber until I made a selection". The live
    // event reaches only a client that was connected when it fired, and the
    // pending fetch is on a 20s poll -- so one missed event left the bar cold
    // for up to twenty seconds while the agent sat waiting. The question tool's
    // part stays running for exactly as long as the question is pending, and
    // those updates repeat, so this cannot be missed the same way.
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart({ tool: "question", state: { status: "running", title: "Asked 1 question" } }));

    expect(h.statusState()).toBe("attention");
    expect(h.statusText()).toBe("Waiting for your answer");
  });

  it("retires the mark when the question tool finishes", async () => {
    // Symmetric, for the same reason: the reply event can be missed too, and
    // the tool returns as soon as the answer lands.
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart({ tool: "question", state: { status: "running", title: "Asked 1 question" } }));
    expect(h.statusState()).toBe("attention");

    h.emit(toolPart({ tool: "question", state: { status: "completed", title: "Asked 1 question" } }));
    expect(h.statusState()).not.toBe("attention");
  });

  it("does not read a pending question into any other tool", async () => {
    h = await harness({ statusMap: { ses_a: { type: "busy" } } });
    h.emit(toolPart({ tool: "bash", state: { status: "running", title: "npm test" } }));

    expect(h.statusState()).toBe("busy");
  });

  it("fetches the request body once, not on every part update", async () => {
    // Those updates repeat for as long as the session is blocked. Marking is
    // free; refetching on each one is not.
    h = await harness({ pendingQuestions: [{ id: "que_1", sessionID: "ses_a" }] });
    await h.flush();
    const before = h.fetched.filter((entry) => entry.url.startsWith("/question")).length;

    for (let i = 0; i < 5; i++) {
      h.emit(toolPart({ tool: "question", state: { status: "running", title: "Asked 1 question" } }));
    }
    await h.flush();

    const after = h.fetched.filter((entry) => entry.url.startsWith("/question")).length;
    expect(after - before).toBe(1);
  });

  it("marks the right chip when the request belongs to another session", async () => {
    h = await harness({ pendingQuestions: [{ id: "que_1", sessionID: "ses_b" }] });
    await h.flush();

    const chip = Array.from(h.document.querySelectorAll("[data-oc-chip]")).find(
      (el) => el.querySelector("[data-oc-chip-label]")?.textContent === "Fix tunnel",
    ) as HTMLElement | undefined;
    expect(chip?.getAttribute("data-oc-state")).toBe("attention");
  });

  it("clears a request that has since been answered", async () => {
    // Rebuilt wholesale from each fetch, so an answered request stops showing
    // even if the reply event was missed too.
    h = await harness({ pendingQuestions: [{ id: "que_1", sessionID: "ses_a" }] });
    await h.flush();
    expect(h.statusState()).toBe("attention");

    h.setResponder((url) =>
      url.startsWith("/question") || url.startsWith("/permission") ? [] : undefined,
    );
    h.emit({ type: "session.updated", properties: { sessionID: "ses_a" } });
    // session.updated schedules a debounced refresh; wait past the 400ms.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.flush();

    // Hidden is the signal; the state attribute is reset with it so nothing
    // stale can flash the next time the bar appears.
    expect(h.status()!.hidden).toBe(true);
    expect(h.statusState()).not.toBe("attention");
  });

  it("does not let one endpoint's failure cost the other", async () => {
    // An older server may not have both.
    h = await harness({ pendingPermissions: [{ id: "per_1", sessionID: "ses_a" }] });
    // null means 404: this server has no /question endpoint.
    h.setResponder((url) => (url.startsWith("/question") ? null : undefined));
    h.emit({ type: "session.updated", properties: { sessionID: "ses_a" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.flush();

    expect(h.statusText()).toBe("Waiting for you to approve");
  });

  it("tolerates a shape it does not recognise", async () => {
    h = await harness();
    h.setResponder((url) => (url.startsWith("/question") ? { nope: true } : undefined));
    h.emit({ type: "session.updated", properties: { sessionID: "ses_a" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.flush();

    expect(h.status()).not.toBeNull();
  });
});

describe("answering from the phone", () => {
  // The point of all the pending-request work: a notification you cannot act
  // on just sends you to find a laptop. These drive the dock end to end,
  // including the two POSTs that actually answer.

  const QUESTION = {
    id: "que_1",
    sessionID: "ses_a",
    questions: [
      {
        question: "Delete the account rows too?",
        header: "Delete strategy",
        options: [
          { label: "Cascade", description: "Delete the transactions with it" },
          { label: "Keep", description: "Orphan the transactions" },
        ],
      },
    ],
  };

  /** A responder that serves the request until it is answered, then stops. */
  function servedOnce(request: unknown, path: string) {
    let answered = false;
    return (url: string) => {
      if (url.indexOf("/reply") !== -1 || url.indexOf("/reject") !== -1) {
        answered = true;
        return true;
      }
      if (url.startsWith(path)) return answered ? [] : [request];
      return undefined;
    };
  }

  function posts(h: Harness) {
    return h.fetched.filter((entry) => entry.method === "POST");
  }

  it("renders the question and its options", async () => {
    h = await harness({ pendingQuestions: [QUESTION] });
    await h.flush();

    expect(h.ask()).not.toBeNull();
    expect(h.askText()).toBe("Delete the account rows too?");
    expect(h.askOptions().map((el) => el.getAttribute("data-oc-ask-option"))).toEqual([
      "Cascade",
      "Keep",
    ]);
  });

  it("shows nothing when nothing is pending", async () => {
    h = await harness();
    await h.flush();

    expect(h.ask()).toBeNull();
  });

  it("stays out of the way when upstream's own dock is on the page", async () => {
    // Two docks for one request is worse than none: the same mistake as the
    // double bubble, where upstream already drew what we were adding.
    h = await harness({ pendingQuestions: [QUESTION], withUpstreamDock: true });
    await h.flush();

    expect(h.ask()).toBeNull();
  });

  it("will not submit until something is picked", async () => {
    h = await harness({ pendingQuestions: [QUESTION] });
    await h.flush();

    const submit = h.askButtons().find((el) => el.textContent === "Submit");
    expect(submit?.hasAttribute("disabled")).toBe(true);
  });

  it("marks the option you tap and enables the submit", async () => {
    h = await harness({ pendingQuestions: [QUESTION] });
    await h.flush();
    h.askOptions()[0].click();
    await h.flush();

    expect(h.askOptions()[0].getAttribute("data-picked")).toBe("true");
    expect(h.askOptions()[1].getAttribute("data-picked")).toBe("false");
    const submit = h.askButtons().find((el) => el.textContent === "Submit");
    expect(submit?.hasAttribute("disabled")).toBe(false);
  });

  it("replaces the pick rather than adding to it, for a single-answer question", async () => {
    h = await harness({ pendingQuestions: [QUESTION] });
    await h.flush();
    h.askOptions()[0].click();
    await h.flush();
    h.askOptions()[1].click();
    await h.flush();

    expect(h.askOptions()[0].getAttribute("data-picked")).toBe("false");
    expect(h.askOptions()[1].getAttribute("data-picked")).toBe("true");
  });

  it("posts the chosen label to the reply endpoint", async () => {
    h = await harness({ pendingQuestions: [QUESTION] });
    h.setResponder(servedOnce(QUESTION, "/question"));
    await h.flush();
    h.askOptions()[0].click();
    await h.flush();
    h.askButtons().find((el) => el.textContent === "Submit")!.click();
    await h.flush();

    const [post] = posts(h);
    expect(post.url).toContain("/question/que_1/reply");
    expect(JSON.parse(post.body)).toEqual({ answers: [["Cascade"]] });
  });

  it("takes the dock down once the request is answered", async () => {
    h = await harness({ pendingQuestions: [QUESTION] });
    h.setResponder(servedOnce(QUESTION, "/question"));
    await h.flush();
    h.askOptions()[0].click();
    await h.flush();
    h.askButtons().find((el) => el.textContent === "Submit")!.click();
    await h.flush();
    await h.flush();

    expect(h.ask()).toBeNull();
  });

  it("keeps the dock up when the reply fails", async () => {
    // The request may still be waiting; dropping the only way to answer it
    // because one POST failed would be the worst of both.
    h = await harness({ pendingQuestions: [QUESTION] });
    h.setResponder((url) => (url.indexOf("/reply") !== -1 ? null : undefined));
    await h.flush();
    h.askOptions()[0].click();
    await h.flush();
    h.askButtons().find((el) => el.textContent === "Submit")!.click();
    await h.flush();

    expect(h.ask()).not.toBeNull();
    expect(h.askText()).toBe("Delete the account rows too?");
  });

  it("walks through several questions and sends every answer", async () => {
    const two = {
      id: "que_2",
      sessionID: "ses_a",
      questions: [
        { question: "First?", header: "One", options: [{ label: "A", description: "" }] },
        { question: "Second?", header: "Two", options: [{ label: "B", description: "" }] },
      ],
    };
    h = await harness({ pendingQuestions: [two] });
    h.setResponder(servedOnce(two, "/question"));
    await h.flush();

    expect(h.askText()).toBe("First?");
    h.askOptions()[0].click();
    await h.flush();
    h.askButtons().find((el) => el.textContent === "Next")!.click();
    await h.flush();

    expect(h.askText()).toBe("Second?");
    h.askOptions()[0].click();
    await h.flush();
    h.askButtons().find((el) => el.textContent === "Submit")!.click();
    await h.flush();

    expect(JSON.parse(posts(h)[0].body)).toEqual({ answers: [["A"], ["B"]] });
  });

  it("goes back to a question you have already answered", async () => {
    const two = {
      id: "que_3",
      sessionID: "ses_a",
      questions: [
        { question: "First?", header: "One", options: [{ label: "A", description: "" }] },
        { question: "Second?", header: "Two", options: [{ label: "B", description: "" }] },
      ],
    };
    h = await harness({ pendingQuestions: [two] });
    await h.flush();
    h.askOptions()[0].click();
    await h.flush();
    h.askButtons().find((el) => el.textContent === "Next")!.click();
    await h.flush();
    h.askButtons().find((el) => el.textContent === "Back")!.click();
    await h.flush();

    expect(h.askText()).toBe("First?");
    expect(h.askOptions()[0].getAttribute("data-picked")).toBe("true");
  });

  it("lets a multiple-choice question take more than one answer", async () => {
    const multi = {
      id: "que_4",
      sessionID: "ses_a",
      questions: [
        {
          question: "Which files?",
          header: "Files",
          multiple: true,
          options: [
            { label: "a.ts", description: "" },
            { label: "b.ts", description: "" },
          ],
        },
      ],
    };
    h = await harness({ pendingQuestions: [multi] });
    h.setResponder(servedOnce(multi, "/question"));
    await h.flush();
    h.askOptions()[0].click();
    await h.flush();
    h.askOptions()[1].click();
    await h.flush();
    h.askButtons().find((el) => el.textContent === "Submit")!.click();
    await h.flush();

    expect(JSON.parse(posts(h)[0].body)).toEqual({ answers: [["a.ts", "b.ts"]] });
  });

  it("un-picks a multiple-choice option on a second tap", async () => {
    const multi = {
      id: "que_5",
      sessionID: "ses_a",
      questions: [
        {
          question: "Which files?",
          header: "Files",
          multiple: true,
          options: [{ label: "a.ts", description: "" }],
        },
      ],
    };
    h = await harness({ pendingQuestions: [multi] });
    await h.flush();
    h.askOptions()[0].click();
    await h.flush();
    h.askOptions()[0].click();
    await h.flush();

    expect(h.askOptions()[0].getAttribute("data-picked")).toBe("false");
  });

  it("rejects a question through the reject endpoint", async () => {
    h = await harness({ pendingQuestions: [QUESTION] });
    h.setResponder(servedOnce(QUESTION, "/question"));
    await h.flush();
    (h.document.querySelector('[data-oc-ask-act="reject"]') as HTMLElement).click();
    await h.flush();

    expect(posts(h)[0].url).toContain("/question/que_1/reject");
  });

  it("says a typed answer needs the desktop rather than pretending otherwise", async () => {
    // Upstream's dock takes free text; this one does not. Saying so beats
    // leaving someone hunting for the field.
    h = await harness({ pendingQuestions: [QUESTION] });
    await h.flush();

    expect(h.document.querySelector("[data-oc-ask-note]")?.textContent).toContain("desktop");
  });

  it("omits the note when the question forbids a custom answer", async () => {
    const fixed = {
      id: "que_6",
      sessionID: "ses_a",
      questions: [
        {
          question: "Pick one",
          header: "Pick",
          custom: false,
          options: [{ label: "A", description: "" }],
        },
      ],
    };
    h = await harness({ pendingQuestions: [fixed] });
    await h.flush();

    expect(h.document.querySelector("[data-oc-ask-note]")).toBeNull();
  });

  it("shows a permission request with what it wants to touch", async () => {
    h = await harness({
      pendingPermissions: [
        { id: "per_1", sessionID: "ses_a", permission: "bash", patterns: ["rm -rf build"] },
      ] as never,
    });
    await h.flush();

    expect(h.ask()?.getAttribute("data-oc-ask-kind")).toBe("permission");
    expect(h.document.querySelector("[data-oc-ask-patterns] code")?.textContent).toBe(
      "rm -rf build",
    );
  });

  it.each([
    ["Allow once", "once"],
    ["Always", "always"],
    ["Reject", "reject"],
  ])("sends %s as reply %s", async (label, reply) => {
    const request = { id: "per_2", sessionID: "ses_a", permission: "bash", patterns: ["ls"] };
    h = await harness({ pendingPermissions: [request] as never });
    h.setResponder(servedOnce(request, "/permission"));
    await h.flush();
    h.askButtons().find((el) => el.textContent === label)!.click();
    await h.flush();

    const [post] = posts(h);
    expect(post.url).toContain("/permission/per_2/reply");
    expect(JSON.parse(post.body)).toEqual({ reply });
  });

  it("prefers a question over a permission when both are waiting", async () => {
    // A question is always a person deciding; a permission request can
    // sometimes be settled by a rule instead.
    h = await harness({
      pendingQuestions: [QUESTION],
      pendingPermissions: [{ id: "per_3", sessionID: "ses_a", permission: "bash" }] as never,
    });
    await h.flush();

    expect(h.ask()?.getAttribute("data-oc-ask-kind")).toBe("question");
  });

  it("leaves another session's request to that session", async () => {
    h = await harness({ pendingQuestions: [{ ...QUESTION, sessionID: "ses_b" }] });
    await h.flush();

    expect(h.ask()).toBeNull();
    expect(h.statusState()).not.toBe("attention");
  });

  it("answers a sub-agent's question from the parent you are looking at", async () => {
    // Same reasoning as the status bar: the child id means nothing to you, and
    // the parent is the session you opened.
    h = await harness({
      sessions: [
        { id: "ses_a", title: "Migrate auth", time: { created: 1, updated: 20 } },
        { id: "ses_kid", title: "sub", parentID: "ses_a", time: { created: 2, updated: 21 } },
      ],
      pendingQuestions: [{ ...QUESTION, sessionID: "ses_kid" }],
    });
    await h.flush();

    expect(h.askText()).toBe("Delete the account rows too?");
  });

  it("does not rewrite the dock when nothing about it changed", async () => {
    // The DOM observer watches body for childList changes, so an
    // unconditional rewrite is a mutation that wakes the observer, which
    // renders again. That loop is what killed every control on the page once.
    h = await harness({ pendingQuestions: [QUESTION] });
    await h.flush();
    const before = h.askOptions()[0];
    h.document.body.appendChild(h.document.createElement("div"));
    await h.flush();

    expect(h.askOptions()[0]).toBe(before);
  });

  it("waits for upstream's dock before standing in for it", async () => {
    // The duplication: the pending fetch resolves before Solid has mounted the
    // real dock, so a single check found nothing and both were on screen at
    // once -- mine over the bottom of the page, upstream's underneath -- until
    // the next DOM mutation took mine down.
    h = await harness({ config: { askGraceMs: 2500 }, pendingQuestions: [QUESTION] });
    await h.flush();

    expect(h.ask()).toBeNull();
  });

  it("does not take over a request upstream has already shown", async () => {
    // The duplication as it actually reached the phone. Waiting for upstream
    // was not enough: the wait ends AFTER its dock unmounts, and answering it
    // is what unmounts it -- so ours appeared showing the request that had just
    // been answered. Upstream showing a request once means it owns it.
    h = await harness({
      config: { askGraceMs: 0 },
      pendingQuestions: [QUESTION],
      withUpstreamDock: true,
    });
    await h.flush();
    expect(h.ask()).toBeNull();

    h.document.querySelector('[data-component="session-question-dock"]')!.remove();
    h.emit({ type: "session.updated", properties: { sessionID: "ses_a" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.flush();

    expect(h.ask()).toBeNull();
  });

  it("forgets that upstream owned a request once it is gone", async () => {
    // Otherwise the note outlives the request and grows for the life of the
    // page -- and a later request that happened to reuse an id would be
    // suppressed for no reason.
    h = await harness({
      config: { askGraceMs: 0 },
      pendingQuestions: [QUESTION],
      withUpstreamDock: true,
    });
    await h.flush();
    h.document.querySelector('[data-component="session-question-dock"]')!.remove();
    // The request is answered and gone...
    h.setResponder((url) => (url.startsWith("/question") ? [] : undefined));
    h.emit({ type: "session.updated", properties: { sessionID: "ses_a" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.flush();
    // ...and a fresh one arrives that upstream has not shown.
    h.setResponder((url) => (url.startsWith("/question") ? [QUESTION] : undefined));
    h.emit({ type: "session.updated", properties: { sessionID: "ses_a" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.flush();

    expect(h.ask()).not.toBeNull();
  });

  it("stands down for good once upstream's dock arrives during the wait", async () => {
    h = await harness({ config: { askGraceMs: 300 }, pendingQuestions: [QUESTION] });
    await h.flush();
    const dock = h.document.createElement("div");
    dock.setAttribute("data-component", "session-question-dock");
    h.document.getElementById("root")!.appendChild(dock);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.flush();

    expect(h.ask()).toBeNull();
  });

  it("renders anyway when upstream's dock never arrives", async () => {
    // The wait has to be bounded by a timer, not by the next mutation: a
    // request upstream never renders would otherwise sit invisible until
    // something unrelated happened to redraw.
    h = await harness({ config: { askGraceMs: 200 }, pendingQuestions: [QUESTION] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await h.flush();

    expect(h.ask()).not.toBeNull();
    expect(h.askText()).toBe("Delete the account rows too?");
  });

  it("restarts the wait for a different request", async () => {
    h = await harness({ config: { askGraceMs: 2500 }, pendingQuestions: [QUESTION] });
    await h.flush();
    h.setResponder((url) =>
      url.startsWith("/question") ? [{ ...QUESTION, id: "que_next" }] : undefined,
    );
    h.emit({ type: "session.updated", properties: { sessionID: "ses_a" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.flush();

    expect(h.ask()).toBeNull();
  });

  it("unmounts at a desktop width", async () => {
    h = await harness({ width: 1200, pendingQuestions: [QUESTION] });
    await h.flush();

    expect(h.document.querySelector("[data-oc-ask]")).toBeNull();
  });

  it("renders nothing when the dock is switched off", async () => {
    h = await harness({ config: { askDock: false }, pendingQuestions: [QUESTION] });
    await h.flush();

    expect(h.document.querySelector("[data-oc-ask]")).toBeNull();
    // The status bar still says a request is waiting: only the answering UI is
    // off, not the signal that something needs you.
    expect(h.statusState()).toBe("attention");
  });

  it("escapes an option label rather than letting it become markup", async () => {
    const nasty = {
      id: "que_7",
      sessionID: "ses_a",
      questions: [
        {
          question: "Pick",
          header: "Pick",
          options: [{ label: '<img src=x onerror="boom">', description: "" }],
        },
      ],
    };
    h = await harness({ pendingQuestions: [nasty] });
    await h.flush();

    expect(h.document.querySelector("[data-oc-ask-options] img")).toBeNull();
    expect(h.document.querySelector("[data-oc-ask-label]")?.textContent).toBe(
      '<img src=x onerror="boom">',
    );
  });

  it("survives a question with no options at all", async () => {
    h = await harness({
      pendingQuestions: [{ id: "que_8", sessionID: "ses_a", questions: [{ question: "Well?" }] }],
    });
    await h.flush();

    expect(h.askText()).toBe("Well?");
    expect(h.askOptions()).toHaveLength(0);
  });

  it("reports what the pending endpoints answered", async () => {
    // The one readout that separates "nothing is pending" from "this server
    // cannot see what is pending", which look identical from the phone.
    h = await harness({ config: { debug: true }, pendingQuestions: [QUESTION] });
    await h.flush();

    const line = h.document.querySelector("[data-oc-diag]")?.textContent ?? "";
    expect(line).toContain("pend q200:1 p200:0");
  });

  it("reports a pending endpoint that refused", async () => {
    h = await harness({ config: { debug: true } });
    h.setResponder((url) => (url.startsWith("/question") ? null : undefined));
    h.emit({ type: "session.updated", properties: { sessionID: "ses_a" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.flush();

    expect(h.document.querySelector("[data-oc-diag]")?.textContent).toContain("pend q404:-");
  });
});
