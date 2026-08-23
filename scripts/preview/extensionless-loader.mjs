/**
 * Let Node import the compiled output directly.
 *
 * `tsc` emits the import specifiers verbatim, and this codebase writes them
 * without a `.js` extension -- which is fine for the runtime that actually
 * loads the plugin (Bun, via opencode) and not resolvable by Node's ESM loader.
 * Rather than change the source to suit a dev script, or copy the module into
 * the script and measure a copy, add the extension at resolve time.
 */
import { fileURLToPath } from "url";
import * as fs from "fs";
import * as path from "path";

export function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL) {
    const base = path.dirname(fileURLToPath(context.parentURL));
    for (const candidate of [`${specifier}.js`, `${specifier}/index.js`]) {
      if (fs.existsSync(path.resolve(base, candidate))) {
        return next(candidate, context);
      }
    }
  }
  return next(specifier, context);
}
