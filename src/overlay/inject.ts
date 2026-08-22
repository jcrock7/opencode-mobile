/**
 * HTML injection
 *
 * Adds the overlay <link> (and optionally <script>) to OpenCode's index.html
 * on its way through the proxy. Pure string work so it can be tested without
 * a server.
 */

export const INJECT_ATTRIBUTE = "data-oc-mobile-overlay";

const HEAD_CLOSE = /<\/head\s*>/i;
const HTML_CLOSE = /<\/html\s*>/i;
const BODY_OPEN = /<body\b[^>]*>/i;

export interface InjectOptions {
  cssPath: string;
  /** Omit to inject the stylesheet only. */
  jsPath?: string;
}

/** True when this HTML already carries the overlay tags. */
export function isInjected(html: string): boolean {
  return html.includes(INJECT_ATTRIBUTE);
}

function buildTags(options: InjectOptions): string {
  const tags = [`<link rel="stylesheet" href="${options.cssPath}" ${INJECT_ATTRIBUTE}>`];
  if (options.jsPath) {
    // defer so the app's own scripts win the race to first paint; the strip
    // mounts itself once the DOM exists.
    tags.push(`<script src="${options.jsPath}" defer ${INJECT_ATTRIBUTE}></script>`);
  }
  return tags.join("\n");
}

/**
 * The whitespace between the start of the line and `index`, when the line
 * holds nothing else. Used to keep the closing tag's indentation intact so the
 * rewritten document reads the same as the original.
 */
function indentBefore(html: string, index: number): string {
  const lineStart = html.lastIndexOf("\n", index - 1) + 1;
  const prefix = html.slice(lineStart, index);
  return /^[ \t]*$/.test(prefix) ? prefix : "";
}

/**
 * Inject the overlay tags, preferring the end of <head>.
 *
 * Idempotent: HTML that already carries the marker is returned unchanged, so a
 * double-proxy or a retried response cannot stack duplicate tags.
 */
export function injectOverlay(html: string, options: InjectOptions): string {
  if (!html) return html;
  if (isInjected(html)) return html;

  const tags = buildTags(options);

  const headMatch = HEAD_CLOSE.exec(html);
  if (headMatch) {
    const indent = indentBefore(html, headMatch.index);
    const separator = indent ? "\n" + indent : "\n";
    return (
      html.slice(0, headMatch.index) +
      tags.split("\n").join(separator) +
      separator +
      html.slice(headMatch.index)
    );
  }

  // No </head>: fall back to just after <body>, which still parses.
  const bodyMatch = BODY_OPEN.exec(html);
  if (bodyMatch) {
    const at = bodyMatch.index + bodyMatch[0].length;
    return html.slice(0, at) + "\n" + tags + html.slice(at);
  }

  const htmlMatch = HTML_CLOSE.exec(html);
  if (htmlMatch) {
    return html.slice(0, htmlMatch.index) + tags + "\n" + html.slice(htmlMatch.index);
  }

  // Not a recognisable document; append rather than lose the overlay.
  return html + "\n" + tags;
}

/** Only text/html responses get rewritten. */
export function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes("text/html");
}
