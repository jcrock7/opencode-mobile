/**
 * Mobile overlay types
 *
 * The overlay is a stylesheet (and optional script) that the plugin injects
 * into OpenCode's own web UI as it proxies it to the phone. OpenCode serves
 * that UI with a strict CSP; the overlay is designed to fit inside it:
 *
 *   style-src  'self' 'unsafe-inline'  -> the injected <link> is allowed
 *   script-src 'self'                  -> the injected <script src> is allowed
 *                                         because the proxy serves it from
 *                                         the same origin
 */

export interface OverlayConfig {
  /** Master switch. When false the proxy forwards bytes untouched. */
  enabled: boolean;
  /** Render the session switcher strip (needs the injected script). */
  sessionStrip: boolean;
  /**
   * Render the "now running" status bar above the composer.
   *
   * The single thing a phone screen cannot show you otherwise: what the agent
   * is doing at this moment, without scrolling to find the live tool row.
   */
  statusBar: boolean;
  /**
   * Pin the app shell to the visual viewport so the software keyboard does
   * not push the layout off screen.
   *
   * Installed to the Home Screen, OpenCode sets `#root { height: 100vh }` --
   * the LAYOUT viewport, which iOS does not shrink when the keyboard opens.
   * It shrinks only the visual viewport and scrolls the document to reveal the
   * focused field, which drags the shell up under the status bar and leaves
   * the composer adrift above the keyboard. Only script can see that; there is
   * no CSS unit for it on iOS.
   */
  keyboardViewport: boolean;
  /**
   * Give the transcript three visual tiers instead of one wall of text.
   *
   * Upstream renders your prompt, the agent's prose and every tool row in the
   * same weight and colour on the same full-width column, so on a phone a
   * session reads as undifferentiated text. This separates them: your message
   * becomes a right-inset bubble, the response gets a continuous rail, and tool
   * rows are demoted to subdued cards.
   */
  bubbles: boolean;
  /**
   * Replace the Session / Changes tab bar with a button in the titlebar.
   *
   * Upstream switches between the timeline and the diff view with a
   * two-segment tab bar above the timeline. On a phone that is a permanent row
   * of chrome -- 44px once the touch targets are honoured -- spent on a control
   * used occasionally. The button lives in the titlebar, which is already
   * there, and toggles back with the same tap.
   */
  changesButton: boolean;
  /** Widths at or below this (px) get the mobile treatment. */
  maxWidth: number;
  /**
   * Show a fixed badge proving the overlay is applied.
   *
   * "Is the overlay actually on?" is otherwise hard to answer on iOS, where
   * there are no dev tools: most of what the overlay changes is either subtle
   * (a type-scale step) or only visible on tool-call rows.
   */
  debug: boolean;
}

export interface OverlayAsset {
  body: string;
  contentType: string;
  /** Weak ETag derived from the body, for conditional requests. */
  etag: string;
}
