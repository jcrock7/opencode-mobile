/**
 * Notification formatting utilities
 */

import type { Notification, NotificationEvent, PluginContext } from "./types";
import { truncateMultiline } from "./token-store";
import { loadFilterConfig, shouldFilterSession } from "./filters";

const DEBUG_ENABLED = process.env.OPENCODE_MOBILE_DEBUG === "1";
const debugLog = (...args: unknown[]): void => {
  if (DEBUG_ENABLED) {
    console.log(...args);
  }
};

interface EventProperties {
  // Info object
  info?: {
    directory?: string;
    path?: {
      cwd?: string;
      root?: string;
    };
    sessionID?: string;
    id?: string;
    parentSessionId?: string;
    parentSessionID?: string;
    parentId?: string;
    parentID?: string;
  };
  // Top-level properties
  projectPath?: string;
  directory?: string;
  messages?: Array<{ role?: string; sender?: string; content?: string; text?: string }>;
  lastAssistantMessage?: string;
  conversation?: Array<{ role?: string; sender?: string; content?: string; text?: string }>;
  sessionId?: string;
  sessionID?: string;
  parentSessionId?: string;
  parentId?: string;
  parentSessionID?: string;
  parentID?: string;
  title?: string;
  sessionTitle?: string;
  summary?: string;
  messageId?: string;
  error?: string;
  message?: string;
  tool?: string;
  type?: string;
  permissionId?: string;
  id?: string;
  permission?: string;
  patterns?: string[];
  /** session.progress: how long the session has been busy, preformatted. */
  elapsed?: string;
  /** session.progress: the tool part's own title. */
  toolTitle?: string;
  /** session.progress: the running tool belongs to a sub-agent. */
  viaChild?: boolean;
  /** permission.v2.asked: what is being asked for ("bash", "edit", ...). */
  action?: string;
  /** permission.v2.asked: what it applies to. The v1 event called these patterns. */
  resources?: string[];
}

/**
 * Extract project path from event
 */
export function extractProjectPath(event: NotificationEvent, ctx?: PluginContext): string | null {
  const properties = event.properties as EventProperties;
  const { type } = event;
  switch (type) {
    case "session.updated":
      return properties?.info?.directory || null;
    case "message.updated":
      return (
        properties?.info?.path?.cwd || properties?.info?.path?.root || null
      );
    case "session.idle":
    case "session.error":
    case "session.progress":
    case "permission.updated":
    case "permission.asked":
    case "permission.v2.asked":
      return (
        properties?.directory ||
        properties?.projectPath ||
        event?.directory ||
        ctx?.directory ||
        ctx?.worktree ||
        null
      );
    default:
      return (
        properties?.projectPath ||
        properties?.directory ||
        properties?.info?.directory ||
        properties?.info?.path?.cwd ||
        ctx?.directory ||
        ctx?.worktree ||
        null
      );
  }
}

/**
 * Extract session ID from event
 */
export function extractSessionId(event: NotificationEvent): string | null {
  const properties = event.properties as EventProperties;
  return (
    properties?.sessionId ||
    properties?.sessionID ||
    event?.sessionId ||
    event?.sessionID ||
    properties?.info?.sessionID ||
    properties?.info?.id ||
    null
  );
}

/**
 * Check if event is a child session
 * Checks multiple possible locations for parent session references
 */
export function isChildSession(event: NotificationEvent): boolean {
  const properties = event.properties as EventProperties;
  
  // Check all possible parent ID locations
  const checks = [
    { location: 'properties.parentSessionId', value: properties?.parentSessionId },
    { location: 'properties.parentSessionID', value: properties?.parentSessionID },
    { location: 'properties.parentId', value: properties?.parentId },
    { location: 'properties.parentID', value: properties?.parentID },
    { location: 'event.parentSessionId', value: event?.parentSessionId },
    { location: 'event.parentSessionID', value: event?.parentSessionID },
    { location: 'event.parentId', value: event?.parentId },
    { location: 'event.parentID', value: event?.parentID },
    { location: 'properties.info.parentSessionId', value: properties?.info?.parentSessionId },
    { location: 'properties.info.parentSessionID', value: properties?.info?.parentSessionID },
    { location: 'properties.info.parentId', value: properties?.info?.parentId },
    { location: 'properties.info.parentID', value: properties?.info?.parentID },
  ];
  
  for (const check of checks) {
    const value = check.value;
    if (typeof value === 'string' && value.trim().length > 0) {
      debugLog(`[isChildSession] Found parent ID at ${check.location}: ${value}`);
      return true;
    }
  }
  
  debugLog('[isChildSession] No parent ID found - not a child session');
  return false;
}

function extractSessionTitle(properties: EventProperties): string | null {
  const title = properties?.title || properties?.sessionTitle;
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  return trimmed ? trimmed : null;
}

/**
 * The project a notification came from, as a short label.
 *
 * The title is the only line iOS guarantees is readable at a glance, so it
 * should carry identity ("which of my sessions is this?") rather than a
 * constant. The status goes in the subtitle instead.
 */
export function projectLabel(projectPath: string | null): string | null {
  if (!projectPath) return null;
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/);
  const name = parts[parts.length - 1];
  return name && name.trim() ? name.trim() : null;
}

function hasBracketTag(text: string): boolean {
  // Matches things like "[foo]" anywhere in the title.
  return /\[[^\]]+\]/.test(text);
}

/**
 * Extract last assistant message from event
 */
export function extractLastAssistantMessage(event: NotificationEvent): string {
  const properties = event.properties as EventProperties;

  if (properties?.messages && Array.isArray(properties.messages)) {
    const assistantMessages = properties.messages.filter(
      (m: any) => m.role === "assistant" || m.sender === "assistant",
    );
    if (assistantMessages.length > 0) {
      const lastMessage = assistantMessages[assistantMessages.length - 1];
      return lastMessage.content || lastMessage.text || "";
    }
  }

  if (properties?.lastAssistantMessage) {
    return properties.lastAssistantMessage;
  }

  if (properties?.conversation && Array.isArray(properties.conversation)) {
    const assistantMessages = properties.conversation.filter(
      (m: any) => m.role === "assistant" || m.sender === "assistant",
    );
    if (assistantMessages.length > 0) {
      const lastMessage = assistantMessages[assistantMessages.length - 1];
      return lastMessage.content || lastMessage.text || "";
    }
  }

  return "";
}

/**
 * Format a notification from an event
 */
export function formatNotification(
  event: NotificationEvent,
  serverUrl: string,
  ctx?: PluginContext,
): Notification | null {
  const properties = event.properties as EventProperties;
  const { type } = event;

  const projectPath = extractProjectPath(event, ctx);
  const sessionId = extractSessionId(event);

  const sessionTitleForFiltering = extractSessionTitle(properties);
  // Sub-agent sessions are suppressed because their completions are noise. A
  // permission request is the opposite: it BLOCKS, and the session sits there
  // until a human answers. Suppressing it means the work stalls and nobody is
  // ever told, so permission kinds are exempt.
  const blocking = type === "permission.asked" || type === "permission.v2.asked";
  if (!blocking && isChildSession(event)) {
    debugLog(`[formatNotification] Filtering child session (sessionId: ${sessionId || 'unknown'})`);
    return null;
  }

  if (sessionTitleForFiltering && hasBracketTag(sessionTitleForFiltering)) {
    return null;
  }

  const filterConfig = loadFilterConfig();
  if (shouldFilterSession(sessionTitleForFiltering, filterConfig)) {
    return null;
  }

  const baseData = { type, serverUrl, projectPath, sessionId };
  const project = projectLabel(projectPath);

  // Grouping applies to every notification kind, not just completions: errors
  // and permission prompts belong in the same thread as the session that
  // raised them, which is exactly when grouping matters most.
  const iosThread = {
    threadId: sessionId || undefined,
    summaryArg: project || sessionTitleForFiltering || "Session",
  };

  switch (type) {
    case "session.idle": {
      const lastAssistantMessage = extractLastAssistantMessage(event);
      debugLog(
        "[PushPlugin] Last assistant message:",
        lastAssistantMessage
          ? lastAssistantMessage.substring(0, 100) + "..."
          : "none",
      );

      const sessionTitle = sessionTitleForFiltering || "Session";
      const title = project || "Agent finished the task";
      // The subtitle always carries the session title: with a project in the
      // title it disambiguates which session, and without one it is the only
      // identity the notification has.
      const subtitle = sessionTitle;
      // Collapsed preview is one line; the expanded body keeps the agent's
      // own line structure.
      const bodyText = lastAssistantMessage
        ? truncateMultiline(lastAssistantMessage, 320)
        : sessionTitle;
      const expandedText = lastAssistantMessage || sessionTitle;

      return {
        title,
        subtitle,
        body: bodyText,
        data: {
          ...baseData,
          messageId: properties?.messageId,
          lastAssistantMessage,
        },
        android: {
          notification: {
            channelId: "opencode-sessions",
            style: {
              type: "bigtext" as const,
              text: expandedText,
              title,
            },
          },
        },
        ios: iosThread,
      };
    }
    case "session.error": {
      // An error is the one payload where the tail matters most, so it gets the
      // same body budget and the same expanded style as a completion.
      const errorText = String(
        properties?.error || properties?.message || "An error occurred",
      );
      const sessionTitle = sessionTitleForFiltering || "Session";
      return {
        title: project ? `${project} failed` : "Session Error",
        subtitle: sessionTitle,
        body: truncateMultiline(errorText, 320),
        data: { ...baseData, error: errorText },
        android: {
          notification: {
            channelId: "opencode-sessions",
            style: {
              type: "bigtext" as const,
              text: errorText,
              title: project ? `${project} failed` : "Session Error",
            },
          },
        },
        ios: iosThread,
      };
    }
    case "session.progress": {
      // Deliberately quiet in wording as well as in frequency: this fires only
      // for work that has already outlived the delay, so it is a liveness
      // signal, not an announcement. The tool goes in the body when one was
      // running, because "still working" on its own answers less than it asks.
      const sessionTitle = sessionTitleForFiltering || "Session";
      const elapsedLabel = String(properties?.elapsed || "");
      const tool = String(properties?.tool || "");
      const toolTitle = String(properties?.toolTitle || "");
      const viaChild = properties?.viaChild === true;

      const toolLabel = tool
        ? toolTitle && toolTitle !== tool
          ? `${tool} \u00b7 ${toolTitle}`
          : tool
        : "";
      // A sub-agent's tool is named as one: the user delegated it indirectly
      // and would not otherwise recognise it as this session's work.
      const work = toolLabel ? (viaChild ? `sub-agent \u00b7 ${toolLabel}` : toolLabel) : "";
      const bodyText = work
        ? elapsedLabel
          ? `${work} -- running ${elapsedLabel}`
          : work
        : elapsedLabel
          ? `Still working -- ${elapsedLabel}`
          : "Still working";

      return {
        title: project ? `${project} still working` : "Still working",
        subtitle: sessionTitle,
        body: bodyText,
        data: { ...baseData, tool, elapsed: elapsedLabel },
        android: { notification: { channelId: "opencode-sessions" } },
        // Silent and normal priority. An update on work you already know you
        // started should be there when you look, not demand that you do.
        priority: "normal" as const,
        sound: null,
        ios: iosThread,
      };
    }
    case "permission.updated":
      return {
        title: project ? `${project} needs you` : "Permission Required",
        subtitle: sessionTitleForFiltering || undefined,
        body: `Approve ${properties?.tool || "action"} ${
          properties?.type || "execute"
        }?`,
        data: { ...baseData, permissionId: properties?.permissionId },
        ios: iosThread,
      };
    case "permission.v2.asked": {
      // The current schema. It renamed the fields as well as the event:
      // `permission` -> `action`, `patterns` -> `resources`. Reading the v1
      // names here produced "Approve action?" with no detail even on the rare
      // occasion the event arrived at all.
      const action = String(properties?.action || "action");
      const resources = Array.isArray(properties?.resources) ? properties.resources : [];
      const detail = resources.length > 0 ? ` (${resources.join(", ")})` : "";
      return {
        title: project ? `${project} needs you` : "Permission Required",
        subtitle: sessionTitleForFiltering || undefined,
        body: `Approve ${action}${detail}?`,
        data: {
          ...baseData,
          permissionId: properties?.id,
          permission: action,
          patterns: resources,
        },
        // NOTE: Expo category identifiers cannot include ':' or '-'.
        categoryId: "opencode_permission",
        ios: iosThread,
      };
    }
    case "permission.asked": {
      const patterns = Array.isArray(properties?.patterns) ? properties.patterns : [];
      const patternsLabel = patterns.length > 0 ? ` (${patterns.join(", ")})` : "";
      return {
        title: project ? `${project} needs you` : "Permission Required",
        subtitle: sessionTitleForFiltering || undefined,
        body: `Approve ${properties?.permission || "action"}${patternsLabel}?`,
        data: {
          ...baseData,
          permissionId: properties?.id,
          permission: properties?.permission,
          patterns,
        },
        // NOTE: Expo category identifiers cannot include ':' or '-'.
        categoryId: "opencode_permission",
        ios: iosThread,
      };
    }
    default:
      return null;
  }
}
