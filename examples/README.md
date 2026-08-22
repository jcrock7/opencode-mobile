# Example configs

## `opencode.json` / `opencode.jsonc`

The **global** OpenCode config that loads this fork as a plugin. Copy one to:

```
~/.config/opencode/opencode.json
```

Use the `.jsonc` version if you want the explanatory comments kept — OpenCode
reads either, and prefers `opencode.jsonc` when both exist.

> This is not the same file as the `opencode.json` in the repository root. That
> one is this project's own config (bash permissions for working in the repo) and
> is not meant to be copied anywhere.

### Two things to get right

**The path must be absolute, and must match where you cloned the repo.** The
example says `/home/jared/repos/opencode-mobile`; change it if yours differs.

**Do not list both the file path and `"opencode-mobile@latest"`.** The npm spec
is the upstream package, it does not include the mobile overlay, and running both
loads two copies of the plugin that then contend for port 4097.

### Let the repo fill in the path

Rather than editing by hand:

```bash
npm run print-config
```

That prints the config with the `file://` path already resolved to wherever the
checkout actually lives, merged on top of any settings you already have (theme,
model, other plugins) and with a stale `opencode-mobile@latest` entry dropped.

To write it straight to `~/.config/opencode/`:

```bash
npm run print-config -- --merge
```

It backs the old file up to `opencode.json.bak` first, refuses to touch a config
it cannot parse, and is safe to run twice.

### Then

```bash
npm run build          # OpenCode loads dist/index.js, not the TypeScript
opencode serve         # `serve` specifically -- see the main README
```
