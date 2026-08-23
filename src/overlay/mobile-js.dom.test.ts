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
  doc.body.innerHTML = `
    <div id="root">
      <div data-component="session-turn"><div data-slot="session-turn-content"></div></div>
      ${options.withDock === false ? "" : '<div data-component="session-prompt-dock"></div>'}
    </div>`;

  FakeEventSource.instances = [];
  const w = win as unknown as Record<string, unknown>;
  w.EventSource = FakeEventSource;

  const sessions = options.sessions ?? SESSIONS;
  const statusMap = options.statusMap ?? { ses_a: { type: "idle" }, ses_b: { type: "idle" } };
  w.fetch = vi.fn((url: string) => {
    const body = url.includes("/session/status") ? statusMap : sessions;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
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

  it("hides itself with only one session", async () => {
    h = await harness({ sessions: [SESSIONS[0]] });
    expect(h.strip()!.hidden).toBe(true);
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

  it("hides the strip when the session list cannot be read", async () => {
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

    const strip = (win.document as unknown as Document).querySelector("[data-oc-strip]") as HTMLElement;
    expect(strip.hidden).toBe(true);
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
