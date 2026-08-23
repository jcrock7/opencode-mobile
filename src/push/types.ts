/**
 * Push notification types
 */

export interface PushToken {
  token: string;
  platform: "ios" | "android";
  deviceId: string;
  registeredAt: string;
  serverUrl?: string;
}

export interface Notification {
  title: string;
  subtitle?: string; // iOS subtitle, shows below title
  body: string;
  data: Record<string, unknown>;
  categoryId?: string;
  android?: AndroidNotificationConfig;
  ios?: iOSNotificationConfig;
  /**
   * Expo delivery priority. Defaults to "high", which is right for the events
   * that want you to act -- a completion, an error, a permission prompt. A
   * progress update is not one of those, so it can ask for "normal".
   */
  priority?: "default" | "normal" | "high";
  /**
   * Notification sound, defaulting to "default". `null` delivers silently,
   * which is what an update on work you already know you started should do.
   */
  sound?: "default" | null;
}

export interface AndroidNotificationConfig {
  notification?: {
    channelId?: string;
    style?: {
      type: "bigtext" | "inbox";
      text?: string;
      title?: string;
      lines?: string[];
    };
  };
}

export interface iOSNotificationConfig {
  attachments?: Array<{
    url: string;
    hideThumbnail?: boolean;
  }>;
  summaryArg?: string;
  threadId?: string;
}

export interface NotificationEvent {
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
  sessionId?: string;
  sessionID?: string;
  parentSessionId?: string;
  parentSessionID?: string;
  parentId?: string;
  parentID?: string;
}

export interface PluginContext {
  directory?: string;
  worktree?: string;
  serverUrl?: {
    port?: string | number;
  };
}
