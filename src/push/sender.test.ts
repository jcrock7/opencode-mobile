/**
 * sender.test.ts - Expo push delivery
 *
 * `fetch` is stubbed, so nothing leaves the machine. The token file path is
 * resolved from process.env.HOME at import time, so HOME points at a scratch
 * directory and the module is re-imported per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Notification, PushToken } from "./types";

const EXPO_URL = "https://exp.host/--/api/v2/push/send";

let home = "";
let tokenFile = "";
let fetchMock: ReturnType<typeof vi.fn>;

async function loadModule() {
  vi.resetModules();
  return import("./sender");
}

async function seedTokens(tokens: PushToken[]): Promise<void> {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify(tokens));
}

function token(overrides: Partial<PushToken> = {}): PushToken {
  return {
    token: "ExponentPushToken[abc]",
    platform: "ios",
    deviceId: "device-1",
    registeredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    title: "opencode-mobile",
    body: "Done.",
    data: { type: "session.idle", sessionId: "ses_1" },
    ...overrides,
  };
}

/** The JSON body the sender POSTed. */
function sentMessages(): Array<Record<string, unknown>> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

function okResponse(data: Array<Record<string, unknown>>) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sender-"));
  process.env.HOME = home;
  tokenFile = path.join(home, ".config/opencode/push-tokens.json");

  fetchMock = vi.fn().mockResolvedValue(okResponse([{ status: "ok" }]));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendPush", () => {
  it("does nothing when no device is registered", async () => {
    const { sendPush } = await loadModule();
    await sendPush(notification());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the Expo push endpoint", async () => {
    await seedTokens([token()]);
    const { sendPush } = await loadModule();
    await sendPush(notification());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXPO_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends one message per registered device", async () => {
    await seedTokens([token(), token({ token: "ExponentPushToken[def]", deviceId: "device-2" })]);
    const { sendPush } = await loadModule();
    await sendPush(notification());

    const messages = sentMessages();
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.to)).toEqual([
      "ExponentPushToken[abc]",
      "ExponentPushToken[def]",
    ]);
  });

  it("carries the title, body and data through", async () => {
    await seedTokens([token()]);
    const { sendPush } = await loadModule();
    await sendPush(notification({ title: "alpha", body: "line one\nline two" }));

    const [message] = sentMessages();
    expect(message.title).toBe("alpha");
    expect(message.body).toBe("line one\nline two");
    expect(message.data).toMatchObject({ type: "session.idle", sessionId: "ses_1" });
    expect(message.priority).toBe("high");
    expect(message.sound).toBe("default");
  });

  it("includes the subtitle only when set", async () => {
    await seedTokens([token()]);
    const { sendPush } = await loadModule();

    await sendPush(notification({ subtitle: "Fix the tunnel" }));
    expect(sentMessages()[0].subtitle).toBe("Fix the tunnel");

    fetchMock.mockClear();
    await sendPush(notification());
    expect("subtitle" in sentMessages()[0]).toBe(false);
  });

  it("includes the platform blocks only when set", async () => {
    await seedTokens([token()]);
    const { sendPush } = await loadModule();

    await sendPush(
      notification({
        categoryId: "opencode_permission",
        ios: { threadId: "ses_1", summaryArg: "alpha" },
        android: { notification: { channelId: "opencode-sessions" } },
      }),
    );

    const [message] = sentMessages();
    expect(message.categoryId).toBe("opencode_permission");
    expect(message.ios).toMatchObject({ threadId: "ses_1" });
    expect(message.android).toMatchObject({ notification: { channelId: "opencode-sessions" } });
  });

  it("sends high priority with sound unless told otherwise", async () => {
    await seedTokens([token()]);
    const { sendPush } = await loadModule();

    await sendPush(notification());
    const [message] = sentMessages();
    expect(message.priority).toBe("high");
    expect(message.sound).toBe("default");
  });

  it("honours a quieter delivery when one is asked for", async () => {
    // Progress updates ask for this: present when you look, not demanding.
    await seedTokens([token()]);
    const { sendPush } = await loadModule();

    await sendPush(notification({ priority: "normal", sound: null }));
    const [message] = sentMessages();
    expect(message.priority).toBe("normal");
    expect(message.sound).toBeNull();
  });

  it("overrides serverUrl per device when that device stored one", async () => {
    await seedTokens([
      token({ serverUrl: "http://192.168.1.10:4096" }),
      token({ token: "ExponentPushToken[def]", deviceId: "device-2" }),
    ]);
    const { sendPush } = await loadModule();
    await sendPush(notification({ data: { serverUrl: "https://tunnel.example.com" } }));

    const messages = sentMessages();
    expect((messages[0].data as Record<string, unknown>).serverUrl).toBe("http://192.168.1.10:4096");
    expect((messages[1].data as Record<string, unknown>).serverUrl).toBe("https://tunnel.example.com");
  });

  describe("token pruning", () => {
    it("drops a DeviceNotRegistered token", async () => {
      await seedTokens([token(), token({ token: "ExponentPushToken[def]", deviceId: "device-2" })]);
      fetchMock.mockResolvedValue(
        okResponse([
          { status: "error", details: { error: "DeviceNotRegistered" } },
          { status: "ok" },
        ]),
      );

      const { sendPush } = await loadModule();
      await sendPush(notification());

      const remaining = JSON.parse(fs.readFileSync(tokenFile, "utf-8")) as PushToken[];
      expect(remaining).toHaveLength(1);
      expect(remaining[0].token).toBe("ExponentPushToken[def]");
    });

    it("drops an InvalidCredentials token", async () => {
      await seedTokens([token()]);
      fetchMock.mockResolvedValue(
        okResponse([{ status: "error", details: { error: "InvalidCredentials" } }]),
      );

      const { sendPush } = await loadModule();
      await sendPush(notification());

      expect(JSON.parse(fs.readFileSync(tokenFile, "utf-8"))).toEqual([]);
    });

    it("keeps a token that failed for another reason", async () => {
      await seedTokens([token()]);
      fetchMock.mockResolvedValue(
        okResponse([{ status: "error", details: { error: "MessageTooBig" } }]),
      );

      const { sendPush } = await loadModule();
      await sendPush(notification());

      expect(JSON.parse(fs.readFileSync(tokenFile, "utf-8"))).toHaveLength(1);
    });

    it("keeps every token on success", async () => {
      await seedTokens([token()]);
      const { sendPush } = await loadModule();
      await sendPush(notification());

      expect(JSON.parse(fs.readFileSync(tokenFile, "utf-8"))).toHaveLength(1);
    });
  });

  describe("failure handling", () => {
    it("returns quietly on a non-ok response", async () => {
      await seedTokens([token()]);
      fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

      const { sendPush } = await loadModule();
      await expect(sendPush(notification())).resolves.toBeUndefined();
      // The token list is left alone: a 429 says nothing about the device.
      expect(JSON.parse(fs.readFileSync(tokenFile, "utf-8"))).toHaveLength(1);
    });

    it("swallows a network error", async () => {
      await seedTokens([token()]);
      fetchMock.mockRejectedValue(new Error("ENOTFOUND exp.host"));

      const { sendPush } = await loadModule();
      await expect(sendPush(notification())).resolves.toBeUndefined();
    });

    it("tolerates a response with no data array", async () => {
      await seedTokens([token()]);
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

      const { sendPush } = await loadModule();
      await expect(sendPush(notification())).resolves.toBeUndefined();
    });

    it("tolerates an unexpected per-message status", async () => {
      await seedTokens([token()]);
      fetchMock.mockResolvedValue(okResponse([{ status: "queued" }]));

      const { sendPush } = await loadModule();
      await expect(sendPush(notification())).resolves.toBeUndefined();
      expect(JSON.parse(fs.readFileSync(tokenFile, "utf-8"))).toHaveLength(1);
    });
  });
});
