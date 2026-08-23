/**
 * progress.test.ts - the progress-notification tracker.
 *
 * The whole value of this feature is in what it *does not* send, so most of
 * these tests assert silence: a turn that finishes quickly, a session that
 * settles, a repeated busy event. Timers are injected so none of it waits.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createProgressTracker,
  loadProgressConfig,
  formatElapsed,
  type ProgressConfig,
  type ProgressDue,
} from "./progress";

const CONFIG: ProgressConfig = { enabled: true, afterMs: 60_000 };

/** A fake clock: timers fire only when the test advances it. */
function clock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    deps: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    /** Move time forward, firing whatever comes due. */
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of Array.from(pending)) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.fn();
        }
      }
    },
    live: () => pending.size,
  };
}

function tracker(config: Partial<ProgressConfig> = {}) {
  const c = clock();
  const due: ProgressDue[] = [];
  const t = createProgressTracker({
    config: { ...CONFIG, ...config },
    onDue: (d) => due.push(d),
    deps: c.deps,
  });
  return { t, due, clock: c };
}

describe("loadProgressConfig", () => {
  it("is on by default, one minute in", () => {
    expect(loadProgressConfig({})).toEqual({ enabled: true, afterMs: 60_000 });
  });

  it.each(["0", "false", "off", "no", "OFF"])("treats %s as disabled", (value) => {
    expect(loadProgressConfig({ OPENCODE_MOBILE_PROGRESS: value }).enabled).toBe(false);
  });

  it("takes a delay in seconds", () => {
    expect(loadProgressConfig({ OPENCODE_MOBILE_PROGRESS_AFTER: "120" }).afterMs).toBe(120_000);
  });

  it.each(["1", "0", "-30", "99999", "abc", ""])("ignores the out-of-range delay %s", (value) => {
    // A one-second delay would notify on every turn, which is the noise this
    // feature exists to avoid; an hour is longer than anyone waits.
    expect(loadProgressConfig({ OPENCODE_MOBILE_PROGRESS_AFTER: value }).afterMs).toBe(60_000);
  });
});

describe("what it stays quiet about", () => {
  it("says nothing about a turn that finishes before the delay", () => {
    // The case that makes a plain "started" notification not worth having.
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    c.advance(8_000);
    t.onSettled("ses_a");
    c.advance(120_000);

    expect(due).toEqual([]);
  });

  it("cancels on idle arriving through session.status", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    c.advance(30_000);
    t.onStatus("ses_a", "idle");
    c.advance(120_000);

    expect(due).toEqual([]);
  });

  it("leaves no timer behind when a session settles", () => {
    const { t, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    expect(c.live()).toBe(1);
    t.onSettled("ses_a");
    expect(c.live()).toBe(0);
  });

  it("notifies once per busy period, however often busy repeats", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    c.advance(20_000);
    t.onStatus("ses_a", "busy");
    c.advance(20_000);
    t.onStatus("ses_a", "busy");
    c.advance(120_000);

    expect(due).toHaveLength(1);
  });

  it("does not re-arm after firing until the session settles and restarts", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    c.advance(60_000);
    expect(due).toHaveLength(1);

    t.onStatus("ses_a", "busy");
    c.advance(600_000);
    expect(due).toHaveLength(1);

    t.onSettled("ses_a");
    t.onStatus("ses_a", "busy");
    c.advance(60_000);
    expect(due).toHaveLength(2);
  });

  it("does nothing at all when disabled", () => {
    const { t, due, clock: c } = tracker({ enabled: false });
    t.onStatus("ses_a", "busy");
    t.onTool("ses_a", "bash", "npm test");
    c.advance(600_000);

    expect(due).toEqual([]);
    expect(c.live()).toBe(0);
  });

  it("ignores an empty session id", () => {
    const { t, clock: c } = tracker();
    t.onStatus("", "busy");
    expect(c.live()).toBe(0);
  });

  it("tolerates settling a session it never armed", () => {
    // Every session.idle reaches the tracker, including for sessions that
    // finished faster than a status event or started before the plugin loaded.
    const { t } = tracker();
    expect(() => t.onSettled("ses_unknown")).not.toThrow();
    expect(() => t.onSettled("")).not.toThrow();
    expect(t.armed()).toEqual([]);
  });

  it("tolerates a tool for a session it is not tracking", () => {
    const { t, due, clock: c } = tracker();
    t.onTool("ses_untracked", "bash", "npm test");
    c.advance(600_000);
    expect(due).toEqual([]);
  });

  it("keeps a fired entry from being disarmed twice", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    c.advance(60_000);
    expect(due).toHaveLength(1);
    // The handle is already null here; disarming must not call clearTimeout.
    expect(() => t.onSettled("ses_a")).not.toThrow();
    expect(t.armed()).toEqual([]);
  });
});

describe("what it does send", () => {
  it("fires for work that outlives the delay", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    c.advance(60_000);

    expect(due).toHaveLength(1);
    expect(due[0].sessionId).toBe("ses_a");
    expect(due[0].elapsedMs).toBe(60_000);
  });

  it("carries whatever tool was running when it fired", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    t.onTool("ses_a", "grep", "callers of migrate()");
    c.advance(20_000);
    t.onTool("ses_a", "bash", "npm test");
    c.advance(40_000);

    expect(due[0].tool).toBe("bash");
    expect(due[0].title).toBe("npm test");
    expect(due[0].viaChild).toBe(false);
  });

  it("tracks each session's own timer independently", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    c.advance(40_000);
    t.onStatus("ses_b", "busy");
    c.advance(20_000);

    // A is 60s in and due; B is only 20s in.
    expect(due.map((d) => d.sessionId)).toEqual(["ses_a"]);
    c.advance(40_000);
    expect(due.map((d) => d.sessionId)).toEqual(["ses_a", "ses_b"]);
  });

  it("treats a retry as still working", () => {
    // A session retrying a provider call is exactly the case where you want to
    // know it is alive rather than stuck.
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "retry");
    c.advance(60_000);

    expect(due).toHaveLength(1);
  });

  it("honours a custom delay", () => {
    const { t, due, clock: c } = tracker({ afterMs: 10_000 });
    t.onStatus("ses_a", "busy");
    c.advance(9_000);
    expect(due).toEqual([]);
    c.advance(1_000);
    expect(due).toHaveLength(1);
  });
});

describe("sub-agent attribution", () => {
  it("stands a sub-agent's tool in for the waiting parent", () => {
    // The parent is the session the user knows about; a bare child id in a
    // notification means nothing to them.
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_parent", "busy");
    t.onTool("ses_child", "grep", "callers", "ses_parent");
    c.advance(60_000);

    expect(due[0].sessionId).toBe("ses_parent");
    expect(due[0].tool).toBe("grep");
    expect(due[0].viaChild).toBe(true);
  });

  it("prefers the parent's own tool over a sub-agent's", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_parent", "busy");
    t.onTool("ses_child", "grep", "callers", "ses_parent");
    t.onTool("ses_parent", "bash", "npm test");
    c.advance(60_000);

    expect(due[0].tool).toBe("bash");
    expect(due[0].viaChild).toBe(false);
  });

  it("does not let a sub-agent's tool displace the parent's own", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_parent", "busy");
    t.onTool("ses_parent", "bash", "npm test");
    t.onTool("ses_child", "grep", "callers", "ses_parent");
    c.advance(60_000);

    expect(due[0].tool).toBe("bash");
    expect(due[0].viaChild).toBe(false);
  });

  it("lets a later sub-agent tool replace an earlier one", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_parent", "busy");
    t.onTool("ses_c1", "grep", "callers", "ses_parent");
    t.onTool("ses_c2", "read", "schema.ts", "ses_parent");
    c.advance(60_000);

    expect(due[0].tool).toBe("read");
    expect(due[0].viaChild).toBe(true);
  });

  it("ignores a parent id equal to the session's own", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    t.onTool("ses_a", "bash", "npm test", "ses_a");
    c.advance(60_000);

    expect(due[0].viaChild).toBe(false);
  });

  it("ignores a tool with no name", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    t.onTool("ses_a", "", "");
    c.advance(60_000);

    expect(due[0].tool).toBe("");
  });
});

describe("housekeeping", () => {
  it("reports which sessions are armed", () => {
    const { t, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    t.onStatus("ses_b", "busy");
    expect(t.armed().sort()).toEqual(["ses_a", "ses_b"]);

    c.advance(60_000);
    // Fired, so no longer armed -- but still held, so it cannot re-arm.
    expect(t.armed()).toEqual([]);
  });

  it("drops every timer on dispose", () => {
    const { t, due, clock: c } = tracker();
    t.onStatus("ses_a", "busy");
    t.onStatus("ses_b", "busy");
    t.dispose();
    c.advance(600_000);

    expect(c.live()).toBe(0);
    expect(due).toEqual([]);
  });

  it("uses real timers when none are injected", () => {
    // The production path: no deps supplied.
    vi.useFakeTimers();
    try {
      const due: ProgressDue[] = [];
      const t = createProgressTracker({
        config: { enabled: true, afterMs: 1_000 },
        onDue: (d) => due.push(d),
      });
      t.onStatus("ses_a", "busy");
      vi.advanceTimersByTime(1_000);
      expect(due).toHaveLength(1);
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unrefs its real timers so they cannot delay process exit", () => {
    // The plugin has no shutdown hook, so a pending 60s timer must not be the
    // reason OpenCode hangs around after being asked to quit.
    const handles: Array<{ unref?: () => void }> = [];
    const spy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      const handle = { unref: vi.fn(), fn, ms };
      handles.push(handle);
      return handle as never;
    }) as never);
    try {
      const t = createProgressTracker({
        config: { enabled: true, afterMs: 60_000 },
        onDue: () => {},
      });
      t.onStatus("ses_a", "busy");
      expect(handles).toHaveLength(1);
      expect(handles[0].unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("tolerates a timer handle with no unref", () => {
    // Browsers and some runtimes return a number rather than a Timeout.
    const spy = vi.spyOn(global, "setTimeout").mockImplementation((() => 7) as never);
    try {
      const t = createProgressTracker({
        config: { enabled: true, afterMs: 60_000 },
        onDue: () => {},
      });
      expect(() => t.onStatus("ses_a", "busy")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("clears a real timer on dispose before it fires", () => {
    // Exercises the un-injected clearTimeout: disposing after the timer has
    // already fired never reaches it.
    vi.useFakeTimers();
    try {
      const due: ProgressDue[] = [];
      const t = createProgressTracker({
        config: { enabled: true, afterMs: 10_000 },
        onDue: (d) => due.push(d),
      });
      t.onStatus("ses_a", "busy");
      t.dispose();
      vi.advanceTimersByTime(60_000);
      expect(due).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatElapsed", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [60_000, "1m"],
    [90_000, "1m 30s"],
    [3_600_000, "60m"],
    [-5_000, "0s"],
  ])("renders %ims as %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});
