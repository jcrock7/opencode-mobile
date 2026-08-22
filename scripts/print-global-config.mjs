#!/usr/bin/env node
/**
 * Print the global OpenCode config needed to load this checkout as a plugin,
 * with the file:// path already resolved to wherever the repo actually lives.
 *
 * Copying examples/opencode.json by hand works too, but the path in it has to
 * be corrected by hand; this cannot get that wrong.
 *
 *   npm run print-config              # print it
 *   npm run print-config -- --merge   # merge into the real config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// pathToFileURL handles spaces and non-ASCII correctly; hand-built "file://" +
// path does not.
const spec = pathToFileURL(repoRoot).href;

const configDir = join(homedir(), ".config", "opencode");
const jsoncPath = join(configDir, "opencode.jsonc");
const jsonPath = join(configDir, "opencode.json");
// OpenCode prefers .jsonc when both exist.
const target = existsSync(jsoncPath) ? jsoncPath : jsonPath;

const merge = process.argv.includes("--merge");

function readExisting() {
  if (!existsSync(target)) return null;
  const raw = readFileSync(target, "utf-8");
  const errors = [];
  // jsonc-parser handles comments and trailing commas, which a plain
  // JSON.parse would choke on -- and this config is commonly a .jsonc.
  const value = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || value === undefined) return undefined;
  return value;
}

function warnIfBuildMissing() {
  if (existsSync(join(repoRoot, "dist", "index.js"))) return;
  console.error("warning: dist/index.js is missing -- run `npm run build` first.");
  console.error("         OpenCode loads the built output, not the TypeScript source.\n");
}

warnIfBuildMissing();

if (!merge) {
  const existing = readExisting();
  const plugins = Array.isArray(existing?.plugin) ? existing.plugin : [];
  const others = plugins.filter((p) => p !== spec && !String(p).startsWith("opencode-mobile@"));

  console.log(JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      ...(existing && typeof existing === "object" ? stripKeys(existing, ["$schema", "plugin"]) : {}),
      plugin: [...others, spec],
    },
    null,
    2,
  ));

  console.error(`\n# Copy the above to: ${target}`);
  if (existing === undefined) {
    console.error(`# NOTE: ${target} exists but could not be parsed -- merge by hand.`);
  } else if (existing) {
    console.error(`# Your existing settings are preserved above.`);
    const npm = plugins.filter((p) => String(p).startsWith("opencode-mobile@"));
    if (npm.length) {
      console.error(`# Dropped ${JSON.stringify(npm)} -- that is the upstream npm package,`);
      console.error(`# and running it alongside this checkout loads the plugin twice.`);
    }
  }
  console.error(`# Or apply it directly:  npm run print-config -- --merge`);
  process.exit(0);
}

// --merge
const existing = readExisting();
if (existing === undefined) {
  console.error(`error: ${target} exists but is not valid JSON. Fix or move it, then retry.`);
  process.exit(1);
}

const base = existing ?? {};
const plugins = Array.isArray(base.plugin) ? base.plugin : [];
const dropped = plugins.filter((p) => String(p).startsWith("opencode-mobile@"));
const kept = plugins.filter((p) => p !== spec && !String(p).startsWith("opencode-mobile@"));

const nextPlugins = [...kept, spec];

mkdirSync(configDir, { recursive: true });
if (existsSync(target)) {
  const backup = `${target}.bak`;
  writeFileSync(backup, readFileSync(target));
  console.log(`backed up existing config to ${backup}`);
}

if (existsSync(target)) {
  // Surgical edit: rewrite only the "plugin" key, so comments, key order and
  // formatting in the rest of the file survive. Matters because this config is
  // usually hand-maintained.
  const raw = readFileSync(target, "utf-8");
  const edits = modify(raw, ["plugin"], nextPlugins, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  let updated = applyEdits(raw, edits);
  if (!updated.endsWith("\n")) updated += "\n";
  writeFileSync(target, updated);
} else {
  writeFileSync(
    target,
    JSON.stringify(
      { $schema: "https://opencode.ai/config.json", plugin: nextPlugins },
      null,
      2,
    ) + "\n",
  );
}

console.log(`registered plugin ${spec}`);
if (dropped.length) console.log(`removed ${JSON.stringify(dropped)} (upstream npm package)`);
console.log(`wrote ${target}`);
console.log(`\nNow run:  opencode serve`);

function stripKeys(obj, keys) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}
