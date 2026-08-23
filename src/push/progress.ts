/**
 * Progress notifications -- the "is it still going?" signal.
 *
 * Before this, four event types pushed: `session.idle`, `session.error` and the
 * two permission events. All four fire when the agent has *stopped*. Nothing
 * told you work was underway, so a long run looked identical to a dead tunnel
 * until it finished.
 *
 * The naive fix -- notify when a session goes busy -- doubles the notification
 * volume and most of what it adds is worthless: a turn that finishes in eight
 * seconds does not need a "started" push followed immediately by a "finished"
 * one. So this is deliberately not a start notification. It arms a timer when
 * the session goes busy and *cancels it* if the session settles first. Only
 * work that outlives the delay ever notifies, which is exactly the work you
 * cannot otherwise tell is happening.
 *
 * One notification per busy period. No repeats: a ping every minute for an
 * hour-long run is the noise this is trying to avoid, and the completion
 * notification still closes the loop.
 *
 * The tool a session is running arrives on `message.part.updated`, which is far
 * too frequent to notify on but cheap to record. Whatever was running when the
 * timer fires goes in the body, so the notification says what is happening
 * rather than just that something is.
 */

/** Injected so tests do not wait in real time. */
export interface ProgressDeps {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export interface ProgressConfig {
  enabled: boolean;
  /** How long a session must stay busy before it is worth a notification. */
  afterMs: number;
}

/** What the tracker hands back when a session has been busy long enough. */
export interface ProgressDue {
  sessionId: string;
  startedAt: number;
  elapsedMs: number;
  /** The tool running when the timer fired, if one was reported. */
  tool: string;
  /** That tool's own title, when it differs from the tool name. */
  title: string;
  /** Set when the tool belongs to a sub-agent rather than this session. */
  viaChild: boolean;
}

export interface ProgressTracker {
  /** A `session.status` event. `type` is "busy" | "idle" | "retry". */
  onStatus(sessionId: string, type: string): void;
  /** A tool part. `parentId` attributes a sub-agent's tool to its parent too. */
  onTool(sessionId: string, tool: string, title: string, parentId?: string): void;
  /** Work stopped, for whatever reason: cancel anything still armed. */
  onSettled(sessionId: string): void;
  /**
   * Drop every timer. The plugin has no shutdown hook to call this from,
   * which is why the real timers are unref'd -- but any future teardown,
   * and every test, needs it.
   */
  dispose(): void;
  /** Sessions with a notification still armed. Test seam. */
  armed(): string[];
}

const MIN_AFTER_MS = 5_000;
const MAX_AFTER_MS = 60 * 60_000;
const DEFAULT_AFTER_MS = 60_000;

interface Entry {
  startedAt: number;
  handle: unknown;
  notified: boolean;
  tool: string;
  title: string;
  viaChild: boolean;
}

function isDisabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

function parseAfterMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds)) return null;
  const ms = Math.floor(seconds * 1000);
  // Out of range is a typo, not an intent: a 1-second delay would notify on
  // every turn, and an hour is longer than any session anyone waits on.
  if (ms < MIN_AFTER_MS || ms > MAX_AFTER_MS) return null;
  return ms;
}

export function loadProgressConfig(env: NodeJS.ProcessEnv = process.env): ProgressConfig {
  return {
    enabled: !isDisabled(env.OPENCODE_MOBILE_PROGRESS),
    afterMs: parseAfterMs(env.OPENCODE_MOBILE_PROGRESS_AFTER) ?? DEFAULT_AFTER_MS,
  };
}

export function createProgressTracker(options: {
  config: ProgressConfig;
  onDue: (due: ProgressDue) => void;
  deps?: Partial<ProgressDeps>;
}): ProgressTracker {
  const { config, onDue } = options;
  const deps: ProgressDeps = {
    setTimeout:
      options.deps?.setTimeout ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // Unref'd: a pending timer must never be the reason OpenCode takes an
        // extra minute to exit. The plugin has no shutdown hook to call
        // dispose() from, so the timer has to be harmless if it outlives its
        // usefulness.
        if (typeof (handle as { unref?: () => void }).unref === "function") {
          (handle as unknown as { unref: () => void }).unref();
        }
        return handle;
      }),
    clearTimeout: options.deps?.clearTimeout ?? ((handle) => clearTimeout(handle as never)),
    now: options.deps?.now ?? (() => Date.now()),
  };

  const entries = new Map<string, Entry>();

  function disarm(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    if (entry.handle !== null) deps.clearTimeout(entry.handle);
    entries.delete(sessionId);
  }

  function fire(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry || entry.notified) return;
    // Kept in the map, marked notified, so the same busy period cannot arm a
    // second timer -- `session.status` repeats while a session works.
    entry.notified = true;
    entry.handle = null;
    onDue({
      sessionId,
      startedAt: entry.startedAt,
      elapsedMs: Math.max(0, deps.now() - entry.startedAt),
      tool: entry.tool,
      title: entry.title,
      viaChild: entry.viaChild,
    });
  }

  return {
    onStatus(sessionId: string, type: string): void {
      if (!config.enabled || !sessionId) return;
      if (type !== "busy" && type !== "retry") {
        disarm(sessionId);
        return;
      }
      if (entries.has(sessionId)) return;
      const startedAt = deps.now();
      const entry: Entry = {
        startedAt,
        handle: null,
        notified: false,
        tool: "",
        title: "",
        viaChild: false,
      };
      entries.set(sessionId, entry);
      entry.handle = deps.setTimeout(() => fire(sessionId), config.afterMs);
    },

    onTool(sessionId: string, tool: string, title: string, parentId?: string): void {
      if (!config.enabled || !sessionId || !tool) return;
      // The session's own tool.
      const own = entries.get(sessionId);
      if (own && !own.notified) {
        own.tool = tool;
        own.title = title;
        own.viaChild = false;
      }
      // And, when this is a sub-agent, the parent that is waiting on it. The
      // parent is the session the user knows about; a bare child id in a
      // notification means nothing to them.
      if (!parentId || parentId === sessionId) return;
      const parent = entries.get(parentId);
      // A tool the parent is running itself is the better label, so only
      // stand in when the parent has none of its own.
      if (parent && !parent.notified && (!parent.tool || parent.viaChild)) {
        parent.tool = tool;
        parent.title = title;
        parent.viaChild = true;
      }
    },

    onSettled(sessionId: string): void {
      if (!sessionId) return;
      disarm(sessionId);
    },

    dispose(): void {
      for (const sessionId of Array.from(entries.keys())) disarm(sessionId);
    },

    armed(): string[] {
      const out: string[] = [];
      for (const [sessionId, entry] of entries) {
        if (!entry.notified) out.push(sessionId);
      }
      return out;
    },
  };
}

/** "1m 30s" / "45s" -- a duration a glance can read. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}
