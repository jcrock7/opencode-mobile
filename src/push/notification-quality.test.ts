/**
 * Covers the notification defects fixed alongside the mobile overlay:
 *   A1 newlines survive into the expanded body
 *   A2 the title carries project identity, not a constant
 *   A3 iOS thread grouping is set on every branch, not only completions
 *   A6 errors get the same body budget and expanded style as completions
 *   A4 progress notifications, the "is it still going?" signal
 */

import { describe, it, expect } from "vitest";
import { formatNotification, projectLabel } from "./formatter";
import { truncate, truncateMultiline } from "./token-store";
import type { NotificationEvent } from "./types";

const SERVER_URL = "https://tunnel.example.com";

const STRUCTURED = [
  "Migrated auth to sessions.",
  "",
  "- normalised two raw-cookie call sites",
  "- added a regression test",
].join("\n");

describe("A1: line structure survives into the expanded body", () => {
  describe("truncate (collapsed one-liner)", () => {
    it("flattens newlines", () => {
      expect(truncate("a\nb", 100)).toBe("a b");
    });

    it("collapses a blank line to a single space rather than two", () => {
      expect(truncate("a\n\nb", 100)).toBe("a b");
    });

    it("does not leave whitespace around the join", () => {
      expect(truncate("a  \n   b", 100)).toBe("a b");
    });

    it("still truncates with an ellipsis", () => {
      expect(truncate("abcdefghij", 8)).toBe("abcde...");
    });

    it("returns empty for empty input", () => {
      expect(truncate(undefined, 10)).toBe("");
      expect(truncate("", 10)).toBe("");
    });
  });

  describe("truncateMultiline (expanded body)", () => {
    it("keeps single newlines", () => {
      expect(truncateMultiline("a\nb", 100)).toBe("a\nb");
    });

    it("keeps bullet structure intact", () => {
      expect(truncateMultiline(STRUCTURED, 500)).toBe(STRUCTURED);
    });

    it("collapses runs of blank lines to one", () => {
      expect(truncateMultiline("a\n\n\n\nb", 100)).toBe("a\n\nb");
    });

    it("normalises CRLF", () => {
      expect(truncateMultiline("a\r\nb", 100)).toBe("a\nb");
    });

    it("strips trailing spaces per line", () => {
      expect(truncateMultiline("a   \nb", 100)).toBe("a\nb");
    });

    it("truncates without leaving a dangling space before the ellipsis", () => {
      // Cut lands right after the space: "abcde " -> "abcde..."
      expect(truncateMultiline("abcde fghij", 9)).toBe("abcde...");
    });

    it("truncates mid-word without inventing a break", () => {
      expect(truncateMultiline("hello world again", 14)).toBe("hello world...");
    });

    it("leaves text at exactly the limit alone", () => {
      expect(truncateMultiline("abcdefghij", 10)).toBe("abcdefghij");
    });

    it("returns empty for empty input", () => {
      expect(truncateMultiline(undefined, 10)).toBe("");
    });
  });

  it("puts multi-line text in the notification body", () => {
    const notification = formatNotification(
      {
        type: "session.idle",
        properties: { title: "Migrate auth", lastAssistantMessage: STRUCTURED },
        sessionID: "ses_1",
      },
      SERVER_URL,
    );
    expect(notification?.body).toContain("\n- normalised");
  });

  it("gives Android the untruncated text in the bigtext style", () => {
    const long = "x".repeat(900);
    const notification = formatNotification(
      {
        type: "session.idle",
        properties: { title: "Long one", lastAssistantMessage: long },
        sessionID: "ses_1",
      },
      SERVER_URL,
    );
    expect(notification?.android?.notification?.style?.text).toBe(long);
    expect(notification?.body.length).toBeLessThanOrEqual(320);
  });
});

describe("A2: the title carries project identity", () => {
  describe("projectLabel", () => {
    it.each([
      ["/Users/me/code/opencode-mobile", "opencode-mobile"],
      ["/Users/me/code/opencode-mobile/", "opencode-mobile"],
      ["C:\\Users\\me\\code\\miser", "miser"],
      ["C:\\Users\\me\\code\\miser\\", "miser"],
      ["/single", "single"],
    ])("%s -> %s", (input, expected) => {
      expect(projectLabel(input)).toBe(expected);
    });

    it.each([null, "", "/", "//"])("returns null for %s", (input) => {
      expect(projectLabel(input as string | null)).toBeNull();
    });
  });

  it("uses the project name as the title and the session as the subtitle", () => {
    const notification = formatNotification(
      {
        type: "session.idle",
        directory: "/Users/me/code/opencode-mobile",
        properties: { title: "Fix tunnel retry", lastAssistantMessage: "Done." },
        sessionID: "ses_1",
      },
      SERVER_URL,
    );
    expect(notification?.title).toBe("opencode-mobile");
    expect(notification?.subtitle).toBe("Fix tunnel retry");
  });

  it("distinguishes two sessions in different projects", () => {
    const base = { type: "session.idle", properties: { title: "Work", lastAssistantMessage: "ok" } };
    const a = formatNotification({ ...base, directory: "/code/alpha" } as NotificationEvent, SERVER_URL);
    const b = formatNotification({ ...base, directory: "/code/beta" } as NotificationEvent, SERVER_URL);
    expect(a?.title).toBe("alpha");
    expect(b?.title).toBe("beta");
    expect(a?.title).not.toBe(b?.title);
  });

  it("keeps the old wording when no project can be resolved", () => {
    const notification = formatNotification(
      { type: "session.idle", properties: { title: "Session", lastAssistantMessage: "ok" } },
      SERVER_URL,
    );
    expect(notification?.title).toBe("Agent finished the task");
    expect(notification?.subtitle).toBe("Session");
  });

  it("names the project on an error", () => {
    const notification = formatNotification(
      { type: "session.error", directory: "/code/alpha", properties: { error: "boom" } },
      SERVER_URL,
    );
    expect(notification?.title).toBe("alpha failed");
  });

  it("names the project on a permission prompt", () => {
    const notification = formatNotification(
      {
        type: "permission.asked",
        directory: "/code/alpha",
        properties: { id: "p1", sessionID: "ses_1", permission: "bash" },
      },
      SERVER_URL,
    );
    expect(notification?.title).toBe("alpha needs you");
  });
});

describe("A3: iOS threading on every branch", () => {
  const cases: Array<[string, NotificationEvent]> = [
    ["session.idle", { type: "session.idle", properties: { sessionID: "ses_1", title: "T", lastAssistantMessage: "m" } }],
    ["session.error", { type: "session.error", properties: { sessionID: "ses_1", error: "boom" } }],
    ["permission.updated", { type: "permission.updated", properties: { sessionID: "ses_1", tool: "bash" } }],
    ["permission.asked", { type: "permission.asked", properties: { sessionID: "ses_1", id: "p1", permission: "bash" } }],
  ];

  it.each(cases)("%s groups by session", (_label, event) => {
    const notification = formatNotification(event, SERVER_URL);
    expect(notification?.ios?.threadId).toBe("ses_1");
    expect(notification?.ios?.summaryArg).toBeTruthy();
  });

  it("uses the project as the group summary when available", () => {
    const notification = formatNotification(
      { type: "session.error", directory: "/code/alpha", properties: { sessionID: "ses_1", error: "boom" } },
      SERVER_URL,
    );
    expect(notification?.ios?.summaryArg).toBe("alpha");
  });

  it("leaves threadId undefined rather than empty when there is no session id", () => {
    const notification = formatNotification(
      { type: "session.error", properties: { error: "boom" } },
      SERVER_URL,
    );
    expect(notification?.ios?.threadId).toBeUndefined();
  });
});

describe("A6: errors get a full body and an expanded style", () => {
  const STACK = [
    "Error: tunnel retry exhausted",
    "    at startCloudflareTunnel (src/tunnel/cloudflare.ts:187:11)",
    "    at startTunnelWithFallback (index.ts:123:22)",
  ].join("\n");

  it("keeps the same body budget as a completion", () => {
    const notification = formatNotification(
      { type: "session.error", properties: { sessionID: "ses_1", error: STACK } },
      SERVER_URL,
    );
    // The old 100-char cut lost the frames entirely.
    expect(notification!.body.length).toBeGreaterThan(100);
    expect(notification?.body).toContain("cloudflare.ts:187");
  });

  it("keeps the stack's line structure", () => {
    const notification = formatNotification(
      { type: "session.error", properties: { sessionID: "ses_1", error: STACK } },
      SERVER_URL,
    );
    expect(notification?.body).toContain("\n    at ");
  });

  it("gets an expanded style like completions do", () => {
    const notification = formatNotification(
      { type: "session.error", properties: { sessionID: "ses_1", error: STACK } },
      SERVER_URL,
    );
    expect(notification?.android?.notification?.style?.type).toBe("bigtext");
    expect(notification?.android?.notification?.style?.text).toBe(STACK);
  });

  it("carries the full error text in the payload", () => {
    const notification = formatNotification(
      { type: "session.error", properties: { sessionID: "ses_1", error: STACK } },
      SERVER_URL,
    );
    expect(notification?.data).toMatchObject({ error: STACK });
  });

  it("falls back to message, then a default", () => {
    expect(
      formatNotification({ type: "session.error", properties: { message: "nope" } }, SERVER_URL)?.body,
    ).toBe("nope");
    expect(
      formatNotification({ type: "session.error", properties: {} }, SERVER_URL)?.body,
    ).toBe("An error occurred");
  });
});

describe("regressions guarded", () => {
  it("still suppresses child sessions", () => {
    expect(
      formatNotification(
        { type: "session.idle", properties: { sessionID: "ses_2", parentID: "ses_1", title: "child" } },
        SERVER_URL,
      ),
    ).toBeNull();
  });

  it("still suppresses bracket-tagged titles", () => {
    expect(
      formatNotification({ type: "session.error", properties: { title: "Main [sub]", error: "x" } }, SERVER_URL),
    ).toBeNull();
  });

  it("still returns null for an unhandled event type", () => {
    expect(formatNotification({ type: "message.updated", properties: {} }, SERVER_URL)).toBeNull();
  });

  it("keeps the permission category id Expo requires", () => {
    const notification = formatNotification(
      { type: "permission.asked", properties: { id: "p1", sessionID: "ses_1", permission: "bash" } },
      SERVER_URL,
    );
    expect(notification?.categoryId).toBe("opencode_permission");
  });

  it("keeps listing permission patterns in the body", () => {
    const notification = formatNotification(
      {
        type: "permission.asked",
        properties: { id: "p1", sessionID: "ses_1", permission: "edit", patterns: ["src/a.ts", "src/b.ts"] },
      },
      SERVER_URL,
    );
    expect(notification?.body).toBe("Approve edit (src/a.ts, src/b.ts)?");
  });
});

describe("A4 progress notifications", () => {
  const props = (extra: Record<string, unknown> = {}) => ({
    sessionID: "ses_1",
    title: "Migrate auth",
    directory: "/home/dev/repos/miser",
    elapsed: "1m 30s",
    ...extra,
  });

  it("names the tool and how long it has been running", () => {
    const notification = formatNotification(
      { type: "session.progress", properties: props({ tool: "bash", toolTitle: "npm test" }) },
      SERVER_URL,
    );
    expect(notification?.body).toBe("bash · npm test -- running 1m 30s");
  });

  it("carries the project in the title and the session in the subtitle", () => {
    // Same identity rule as A2: a notification that says only "Still working"
    // is useless when two projects are running.
    const notification = formatNotification(
      { type: "session.progress", properties: props({ tool: "bash", toolTitle: "npm test" }) },
      SERVER_URL,
    );
    expect(notification?.title).toBe("miser still working");
    expect(notification?.subtitle).toBe("Migrate auth");
  });

  it("names a sub-agent's tool as one", () => {
    const notification = formatNotification(
      {
        type: "session.progress",
        properties: props({ tool: "grep", toolTitle: "callers", viaChild: true }),
      },
      SERVER_URL,
    );
    expect(notification?.body).toBe("sub-agent · grep · callers -- running 1m 30s");
  });

  it("drops a tool title that just repeats the tool name", () => {
    const notification = formatNotification(
      { type: "session.progress", properties: props({ tool: "grep", toolTitle: "grep" }) },
      SERVER_URL,
    );
    expect(notification?.body).toBe("grep -- running 1m 30s");
  });

  it("falls back to the elapsed time when no tool was reported", () => {
    const notification = formatNotification(
      { type: "session.progress", properties: props() },
      SERVER_URL,
    );
    expect(notification?.body).toBe("Still working -- 1m 30s");
  });

  it("still says something with neither tool nor elapsed", () => {
    const notification = formatNotification(
      { type: "session.progress", properties: { sessionID: "ses_1", title: "Migrate auth" } },
      SERVER_URL,
    );
    expect(notification?.body).toBe("Still working");
  });

  it("delivers silently at normal priority", () => {
    // An update on work you already know you started should be there when you
    // look, not demand that you do.
    const notification = formatNotification(
      { type: "session.progress", properties: props({ tool: "bash" }) },
      SERVER_URL,
    );
    expect(notification?.priority).toBe("normal");
    expect(notification?.sound).toBeNull();
  });

  it("threads with the rest of the session, like every other kind", () => {
    const notification = formatNotification(
      { type: "session.progress", properties: props({ tool: "bash" }) },
      SERVER_URL,
    );
    expect(notification?.ios?.threadId).toBe("ses_1");
  });

  it("is suppressed for a sub-agent's own session", () => {
    // Children are filtered globally; a progress ping must not be the one kind
    // that leaks them.
    const notification = formatNotification(
      {
        type: "session.progress",
        properties: props({ tool: "bash", parentSessionID: "ses_parent" }),
      },
      SERVER_URL,
    );
    expect(notification).toBeNull();
  });
});
