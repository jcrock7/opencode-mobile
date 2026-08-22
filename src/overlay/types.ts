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
  /** Widths at or below this (px) get the mobile treatment. */
  maxWidth: number;
}

export interface OverlayAsset {
  body: string;
  contentType: string;
  /** Weak ETag derived from the body, for conditional requests. */
  etag: string;
}
