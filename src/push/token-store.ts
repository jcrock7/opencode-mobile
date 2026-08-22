/**
 * Token storage for push notifications
 */

import * as fs from "fs";
import * as path from "path";
import type { PushToken } from "./types";

const CONFIG_DIR = path.join(process.env.HOME || "", ".config/opencode");
const TOKEN_FILE = path.join(CONFIG_DIR, "push-tokens.json");

/**
 * Load stored push tokens from disk
 */
export function loadTokens(): PushToken[] {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("[PushPlugin] Load error:", e);
  }
  return [];
}

/**
 * Save push tokens to disk
 */
export function saveTokens(tokens: PushToken[]): void {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Truncate text to a maximum length, flattening it onto a single line.
 *
 * For the collapsed one-line preview only. Use `truncateMultiline` for the
 * expanded body, where the agent's line structure is what makes it readable.
 */
export function truncate(text: string | undefined, max: number): string {
  if (!text) return "";
  const cleaned = text.replace(/\s*\n+\s*/g, " ").trim();
  return cleaned.length <= max
    ? cleaned
    : cleaned.substring(0, max - 3) + "...";
}

/**
 * Truncate text but keep its line structure.
 *
 * Agent messages are usually a summary line followed by bullets. Flattening
 * that into one run-on sentence is the single biggest hit to readability on a
 * lock screen, so the expanded notification body keeps the newlines and only
 * collapses blank-line runs.
 */
export function truncateMultiline(text: string | undefined, max: number): string {
  if (!text) return "";
  const cleaned = text
    .replace(/\r\n/g, "\n")
    // Collapse runs of blank lines to one, and trim trailing spaces per line.
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length <= max
    ? cleaned
    : cleaned.substring(0, max - 3).trimEnd() + "...";
}
