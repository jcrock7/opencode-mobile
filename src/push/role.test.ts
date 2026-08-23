/**
 * role.test.ts - which process does what.
 *
 * The gate this replaces returned a no-op event handler in every process that
 * was not the one serving, and again in a serving process that lost the port
 * race. The event hook is in-process, so that meant an agent running anywhere
 * else could ask a question and nobody would ever hear it -- and the serving
 * process cannot find out over the API either, because a pending request lives
 * in the asking process's memory.
 *
 * Pure functions with argv and env passed in, because index.ts is not testable
 * in place -- the same reason auth.ts exists.
 */

import { describe, it, expect } from "vitest";
import {
  resolvePluginRole,
  roleWithoutPort,
  isServeInvocation,
  notifiesAlways,
  describeRole,
} from "./role";

const ON = { OPENCODE_MOBILE_NOTIFY_ALWAYS: "1" };

describe("isServeInvocation", () => {
  it("recognises the serve subcommand", () => {
    expect(isServeInvocation(["bun", "opencode", "serve"])).toBe(true);
    expect(isServeInvocation(["bun", "opencode", "serve", "--port", "4096"])).toBe(true);
  });

  it("does not treat attach as serving", () => {
    expect(isServeInvocation(["bun", "opencode", "attach", "serve"])).toBe(false);
  });

  it.each([
    ["a TUI session", ["bun", "opencode"]],
    ["a one-off run", ["bun", "opencode", "run", "fix the build"]],
    ["debug wait, which still has a serverUrl", ["bun", "opencode", "debug", "wait"]],
  ])("does not treat %s as serving", (_label, argv) => {
    expect(isServeInvocation(argv)).toBe(false);
  });
});

describe("notifiesAlways", () => {
  it.each(["1", "true", "on", "yes", "TRUE", " On "])("opts in on %s", (value) => {
    expect(notifiesAlways({ OPENCODE_MOBILE_NOTIFY_ALWAYS: value })).toBe(true);
  });

  it.each(["0", "false", "off", "no", ""])("stays off for %s", (value) => {
    expect(notifiesAlways({ OPENCODE_MOBILE_NOTIFY_ALWAYS: value })).toBe(false);
  });

  it("is off when unset", () => {
    expect(notifiesAlways({})).toBe(false);
  });
});

describe("resolvePluginRole", () => {
  it("serves when started to serve", () => {
    expect(resolvePluginRole({ argv: ["opencode", "serve"], env: {} })).toBe("serve");
  });

  it("serves whether or not notify-always is set", () => {
    // Serving already notifies; the flag is about the processes that do not.
    expect(resolvePluginRole({ argv: ["opencode", "serve"], env: ON })).toBe("serve");
  });

  it("does nothing in another process by default", () => {
    // The old behaviour, kept as the default: a push for every turn you just
    // watched finish at the TUI is noise.
    expect(resolvePluginRole({ argv: ["opencode"], env: {} })).toBe("idle");
  });

  it("notifies from another process when asked to", () => {
    // The case this exists for: the agent runs under a desktop app's own
    // sidecar, and a question it asks has to reach the phone from there --
    // nothing else can see it.
    expect(resolvePluginRole({ argv: ["opencode"], env: ON })).toBe("notify-only");
  });
});

describe("roleWithoutPort", () => {
  it("goes quiet by default when another process is already serving", () => {
    expect(roleWithoutPort({})).toBe("idle");
  });

  it("keeps notifying when asked to, rather than losing the bus with the port", () => {
    // Losing the port race says another process is serving. It says nothing
    // about which process the agent is running in.
    expect(roleWithoutPort(ON)).toBe("notify-only");
  });
});

describe("describeRole", () => {
  it("names the flag in the line the user reads when nothing happens", () => {
    // "Plugin init OK" followed by silence was the confusing part.
    expect(describeRole("idle")).toContain("OPENCODE_MOBILE_NOTIFY_ALWAYS");
  });

  it("says what a notify-only process will not do", () => {
    expect(describeRole("notify-only")).toContain("no tunnel");
  });

  it("says what a serving process does", () => {
    expect(describeRole("serve")).toContain("tunnel");
  });
});
