/**
 * formatter-extract.test.ts - the event-shape extractors.
 *
 * These functions exist because OpenCode has moved fields between releases, so
 * each one probes several spellings. The point of these tests is that every
 * probe actually works -- an untested fallback is a fallback that has silently
 * stopped matching.
 */

import { describe, it, expect } from "vitest";
import {
  extractProjectPath,
  extractSessionId,
  extractLastAssistantMessage,
  isChildSession,
  projectLabel,
} from "./formatter";
import type { NotificationEvent } from "./types";

describe("extractProjectPath", () => {
  it("reads session.updated from properties.info.directory", () => {
    const event: NotificationEvent = {
      type: "session.updated",
      properties: { info: { directory: "/code/alpha" } },
    };
    expect(extractProjectPath(event)).toBe("/code/alpha");
  });

  it("returns null for session.updated with no directory", () => {
    expect(extractProjectPath({ type: "session.updated", properties: {} })).toBeNull();
  });

  it("reads message.updated from properties.info.path.cwd", () => {
    const event: NotificationEvent = {
      type: "message.updated",
      properties: { info: { path: { cwd: "/code/beta" } } },
    };
    expect(extractProjectPath(event)).toBe("/code/beta");
  });

  it("falls back to properties.info.path.root for message.updated", () => {
    const event: NotificationEvent = {
      type: "message.updated",
      properties: { info: { path: { root: "/code/gamma" } } },
    };
    expect(extractProjectPath(event)).toBe("/code/gamma");
  });

  it("returns null for message.updated with no path", () => {
    expect(extractProjectPath({ type: "message.updated", properties: {} })).toBeNull();
  });

  describe("session.idle and friends", () => {
    it("prefers properties.directory", () => {
      const event: NotificationEvent = {
        type: "session.idle",
        properties: { directory: "/a", projectPath: "/b" },
        directory: "/c",
      };
      expect(extractProjectPath(event)).toBe("/a");
    });

    it("then properties.projectPath", () => {
      expect(
        extractProjectPath({ type: "session.idle", properties: { projectPath: "/b" } }),
      ).toBe("/b");
    });

    it("then the event's own directory", () => {
      expect(extractProjectPath({ type: "session.error", properties: {}, directory: "/c" })).toBe("/c");
    });

    it("then the plugin context directory", () => {
      expect(
        extractProjectPath({ type: "permission.asked", properties: {} }, { directory: "/d" }),
      ).toBe("/d");
    });

    it("then the plugin context worktree", () => {
      expect(
        extractProjectPath({ type: "permission.updated", properties: {} }, { worktree: "/e" }),
      ).toBe("/e");
    });

    it("returns null with nothing to go on", () => {
      expect(extractProjectPath({ type: "session.idle", properties: {} })).toBeNull();
    });
  });

  describe("any other event type", () => {
    it("walks the fallback chain", () => {
      expect(
        extractProjectPath({ type: "command.executed", properties: { projectPath: "/a" } }),
      ).toBe("/a");
      expect(
        extractProjectPath({ type: "command.executed", properties: { directory: "/b" } }),
      ).toBe("/b");
      expect(
        extractProjectPath({ type: "command.executed", properties: { info: { directory: "/c" } } }),
      ).toBe("/c");
      expect(
        extractProjectPath({
          type: "command.executed",
          properties: { info: { path: { cwd: "/d" } } },
        }),
      ).toBe("/d");
      expect(
        extractProjectPath({ type: "command.executed", properties: {} }, { directory: "/e" }),
      ).toBe("/e");
      expect(
        extractProjectPath({ type: "command.executed", properties: {} }, { worktree: "/f" }),
      ).toBe("/f");
      expect(extractProjectPath({ type: "command.executed", properties: {} })).toBeNull();
    });
  });
});

describe("extractSessionId", () => {
  it.each([
    ["properties.sessionId", { properties: { sessionId: "s1" } }],
    ["properties.sessionID", { properties: { sessionID: "s1" } }],
    ["event.sessionId", { properties: {}, sessionId: "s1" }],
    ["event.sessionID", { properties: {}, sessionID: "s1" }],
    ["properties.info.sessionID", { properties: { info: { sessionID: "s1" } } }],
    ["properties.info.id", { properties: { info: { id: "s1" } } }],
  ])("reads %s", (_label, shape) => {
    expect(extractSessionId({ type: "session.idle", ...shape } as NotificationEvent)).toBe("s1");
  });

  it("returns null when no id is present", () => {
    expect(extractSessionId({ type: "session.idle", properties: {} })).toBeNull();
  });
});

describe("isChildSession", () => {
  it.each([
    "parentSessionId",
    "parentSessionID",
    "parentId",
    "parentID",
  ])("detects properties.%s", (key) => {
    expect(isChildSession({ type: "session.idle", properties: { [key]: "p1" } })).toBe(true);
  });

  it.each([
    "parentSessionId",
    "parentSessionID",
    "parentId",
    "parentID",
  ])("detects event.%s", (key) => {
    expect(
      isChildSession({ type: "session.idle", properties: {}, [key]: "p1" } as NotificationEvent),
    ).toBe(true);
  });

  it.each([
    "parentSessionId",
    "parentSessionID",
    "parentId",
    "parentID",
  ])("detects properties.info.%s", (key) => {
    expect(
      isChildSession({ type: "session.idle", properties: { info: { [key]: "p1" } } }),
    ).toBe(true);
  });

  it("is false with no parent anywhere", () => {
    expect(isChildSession({ type: "session.idle", properties: { sessionID: "s1" } })).toBe(false);
  });

  it("ignores a blank parent id", () => {
    expect(isChildSession({ type: "session.idle", properties: { parentID: "   " } })).toBe(false);
    expect(isChildSession({ type: "session.idle", properties: { parentID: "" } })).toBe(false);
  });

  it("ignores a non-string parent id", () => {
    expect(
      isChildSession({ type: "session.idle", properties: { parentID: 123 } } as never),
    ).toBe(false);
  });
});

describe("extractLastAssistantMessage", () => {
  it("takes the last assistant entry from properties.messages", () => {
    const text = extractLastAssistantMessage({
      type: "session.idle",
      properties: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "first" },
          { role: "assistant", content: "second" },
        ],
      },
    });
    expect(text).toBe("second");
  });

  it("accepts sender in place of role", () => {
    const text = extractLastAssistantMessage({
      type: "session.idle",
      properties: { messages: [{ sender: "assistant", content: "via sender" }] },
    });
    expect(text).toBe("via sender");
  });

  it("accepts text in place of content", () => {
    const text = extractLastAssistantMessage({
      type: "session.idle",
      properties: { messages: [{ role: "assistant", text: "via text" }] },
    });
    expect(text).toBe("via text");
  });

  it("returns empty when an assistant entry has neither", () => {
    const text = extractLastAssistantMessage({
      type: "session.idle",
      properties: { messages: [{ role: "assistant" }] },
    });
    expect(text).toBe("");
  });

  it("falls through an empty messages array", () => {
    const text = extractLastAssistantMessage({
      type: "session.idle",
      properties: { messages: [], lastAssistantMessage: "fallback" },
    });
    expect(text).toBe("fallback");
  });

  it("falls through a user-only messages array", () => {
    const text = extractLastAssistantMessage({
      type: "session.idle",
      properties: { messages: [{ role: "user", content: "go" }], lastAssistantMessage: "fallback" },
    });
    expect(text).toBe("fallback");
  });

  it("reads properties.lastAssistantMessage", () => {
    expect(
      extractLastAssistantMessage({
        type: "session.idle",
        properties: { lastAssistantMessage: "direct" },
      }),
    ).toBe("direct");
  });

  it("reads properties.conversation as a last resort", () => {
    const text = extractLastAssistantMessage({
      type: "session.idle",
      properties: {
        conversation: [
          { role: "assistant", content: "older" },
          { role: "assistant", content: "newest" },
        ],
      },
    });
    expect(text).toBe("newest");
  });

  it("accepts sender and text in conversation entries", () => {
    expect(
      extractLastAssistantMessage({
        type: "session.idle",
        properties: { conversation: [{ sender: "assistant", text: "conv text" }] },
      }),
    ).toBe("conv text");
  });

  it("returns empty for a conversation with no assistant entry", () => {
    expect(
      extractLastAssistantMessage({
        type: "session.idle",
        properties: { conversation: [{ role: "user", content: "go" }] },
      }),
    ).toBe("");
  });

  it("returns empty when there is nothing to read", () => {
    expect(extractLastAssistantMessage({ type: "session.idle", properties: {} })).toBe("");
  });

  it("ignores a non-array messages value", () => {
    expect(
      extractLastAssistantMessage({
        type: "session.idle",
        properties: { messages: "nope", lastAssistantMessage: "fallback" } as never,
      }),
    ).toBe("fallback");
  });
});

describe("projectLabel", () => {
  it("handles a mixed separator path", () => {
    expect(projectLabel("/code\\alpha")).toBe("alpha");
  });

  it("handles repeated trailing separators", () => {
    expect(projectLabel("/code/alpha///")).toBe("alpha");
  });

  it("returns null for whitespace-only segments", () => {
    expect(projectLabel("/code/   ")).toBeNull();
  });
});
