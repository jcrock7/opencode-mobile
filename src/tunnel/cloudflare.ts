/**
 * Cloudflare tunnel provider implementation
 * 
 * Refactored for testability:
 * - Optional spawn function for dependency injection
 * - Optional fs.existsSync for testing
 * - Port validation
 * - Clean separation of concerns
 */

import { spawn, ChildProcess, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { TunnelConfig, TunnelInfo } from "./types";

// Export types for external use
export type { TunnelConfig, TunnelInfo };

// Module-level state (for backward compatibility)
let _process: ChildProcess | null = null;
let _url: string | null = null;

// Default paths for cloudflared
const CLOUDFLARED_PATHS = (() => {
  const platform = process.platform;
  if (platform === "win32") {
    return [
      "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      "C:\\Program Files\\cloudflared\\cloudflared.exe",
      `${process.env.USERPROFILE}\\scoop\\shims\\cloudflared.exe`,
    ];
  }
  return [
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    `${process.env.HOME || ""}/.cloudflared/cloudflared`,
    "/home/linuxbrew/.linuxbrew/bin/cloudflared",
    `${process.env.HOME || ""}/.linuxbrew/bin/cloudflared`,
  ];
})();

const CONFIG_FILE = path.join(os.homedir(), ".config", "opencode-mobile", "tunnel-config.json");

interface SavedConfig {
  provider?: string;
  mode?: "free" | "custom";
  domain?: string;
  tunnelName?: string;
  cloudflaredPath?: string;
}

function loadSavedConfig(): SavedConfig | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as SavedConfig;
    }
  } catch {}
  return null;
}

function getSavedCloudflaredPath(): string | null {
  const saved = loadSavedConfig();
  if (saved?.cloudflaredPath && fs.existsSync(saved.cloudflaredPath)) {
    return saved.cloudflaredPath;
  }
  return null;
}

function findTunnelCredential(): string | null {
  const credsDir = path.join(os.homedir(), ".cloudflared");
  if (!fs.existsSync(credsDir)) return null;
  try {
    const entries = fs.readdirSync(credsDir) as string[];
    for (const name of entries) {
      if (name.endsWith(".json")) {
        const full = path.join(credsDir, name);
        if (fs.existsSync(full)) return full;
      }
    }
  } catch {}
  return null;
}

/**
 * Find cloudflared binary (extracted for testability)
 */
export function findCloudflared(
  paths?: string[],
  existsSync?: (path: string) => boolean
): string | null {
  const searchPaths = paths || CLOUDFLARED_PATHS;
  const checkExists = existsSync || ((p: string) => require("fs").existsSync(p));
  
  for (const p of searchPaths) {
    try {
      if (checkExists(p)) return p;
    } catch {}
  }
  return null;
}

/**
 * Provision a named tunnel and route a DNS hostname to it (idempotent).
 * Runs best-effort: failures are logged, not fatal — the tunnel may already
 * exist and be routed.
 */
function ensureNamedTunnel(binary: string, tunnelName: string, domain: string): void {
  try {
    execSync(`"${binary}" tunnel create "${tunnelName}"`, {
      stdio: "ignore",
      timeout: 30000,
    });
  } catch {}
  try {
    execSync(`"${binary}" tunnel route dns --overwrite-dns "${tunnelName}" "${domain}"`, {
      stdio: "ignore",
      timeout: 30000,
    });
  } catch {}
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTunnelReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: { "Connection": "close" },
        });
        if (res.status !== 530 && res.status !== 429) {
          return;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {}
    await sleepMs(2000);
  }
  throw new Error("Timed out waiting for Cloudflare custom tunnel to become ready");
}

/**
 * Create a cloudflare tunnel instance
 * This function is testable - accepts external spawn and existsSync
 */
export function createCloudflareTunnel(
  config: TunnelConfig,
  spawnFn?: typeof spawn,
  existsSyncFn?: (path: string) => boolean,
  onUrl?: (url: string) => void,
  loadConfig?: () => SavedConfig | null
): Promise<TunnelInfo> {
  // Validate port
  if (!config.port || typeof config.port !== "number") {
    return Promise.reject(new Error("Invalid port: must be a number"));
  }

  const spawnModule = spawnFn || spawn;
  const saved = (loadConfig || loadSavedConfig)();
  const binary = saved?.cloudflaredPath && fs.existsSync(saved.cloudflaredPath)
    ? saved.cloudflaredPath
    : getSavedCloudflaredPath() || "cloudflared";

  const checkExists = existsSyncFn || ((p: string) => fs.existsSync(p));
  if (!checkExists(binary)) {
    return Promise.reject(new Error("cloudflared not found"));
  }

  // Custom domain mode: drive a named tunnel bound to a DNS hostname.
  const isCustom = saved?.mode === "custom" && !!saved?.domain && !!saved?.tunnelName;
  if (isCustom) {
    const domain = saved!.domain!;
    const tunnelName = saved!.tunnelName!;
    ensureNamedTunnel(binary, tunnelName, domain);
    const credential = findTunnelCredential();
    const args = credential
      ? ["tunnel", "--no-autoupdate", "run", "--url", `http://127.0.0.1:${config.port}`, "--cred-file", credential, tunnelName]
      : ["tunnel", "--no-autoupdate", "run", "--url", `http://127.0.0.1:${config.port}`, tunnelName];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timeout waiting for cloudflared custom tunnel (60s)")),
        60000
      );
      const process = spawnModule(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      _process = process;
      const urlFull = `https://${domain}`;
      void waitForTunnelReady(urlFull, 55000)
        .then(() => {
          clearTimeout(timeout);
          _url = urlFull;
          if (onUrl) onUrl(urlFull);
          else console.log("[Cloudflared] URL:", urlFull);
          resolve({
            url: urlFull,
            tunnelId: tunnelName,
            port: config.port,
            provider: "cloudflare",
          });
        })
        .catch((err: Error) => {
          clearTimeout(timeout);
          _process = null;
          reject(err);
        });
    });
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timeout waiting for cloudflared URL (60s)")),
      60000
    );

    const process = spawn(binary, [
      "tunnel",
      "--url",
      `http://127.0.0.1:${config.port}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    _process = process;
    _url = null;

    const onData = (data: Buffer) => {
      const line = data.toString().trim();
      
      const urlMatch = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      
      if (urlMatch) {
        const url = urlMatch[0];
        _url = url;
        
        if (onUrl) {
          onUrl(url);
        } else {
          console.log("[Cloudflared] URL:", url);
        }

        clearTimeout(timeout);
        resolve({
          url: _url,
          tunnelId: _url.split("://")[1].split(".")[0],
          port: config.port,
          provider: "cloudflare",
        });
      } else if (line.includes("ERR") || line.includes("error")) {
        console.log("[Cloudflared]", line);
      }
    };

    process.stdout?.on("data", onData);
    process.stderr?.on("data", onData);
    process.on("error", (err: Error) => {
      clearTimeout(timeout);
      _process = null;
      reject(err);
    });
    process.on("exit", (code: number | null) => {
      // If no URL was captured, treat as failure even on clean exit
      if (!_url) {
        clearTimeout(timeout);
        _process = null;
        reject(new Error("cloudflared exited without providing a tunnel URL"));
        return;
      }
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        _process = null;
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });
}

function findCloudflareD(
  paths: string[],
  existsSync?: (path: string) => boolean
): string | null {
  const checkExists = existsSync || ((p: string) => require("fs").existsSync(p));
  
  for (const p of paths) {
    try {
      if (checkExists(p)) return p;
    } catch {}
  }
  return null;
}

/**
 * Start a Cloudflare tunnel (legacy function - uses module state)
 */
export async function startCloudflareTunnel(config: TunnelConfig): Promise<TunnelInfo> {
  return createCloudflareTunnel(config);
}

/**
 * Stop the Cloudflare tunnel
 */
export async function stopCloudflareTunnel(): Promise<void> {
  if (_process) {
    _process.kill("SIGTERM");
    _process = null;
  }
  _url = null;
}

function isCloudflaredInPath(): boolean {
  try {
    execSync("cloudflared --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function isCloudflareInstalled(): Promise<boolean> {
  const foundInPaths = findCloudflared() !== null;
  const foundInPath = isCloudflaredInPath();
  const foundInConfig = getSavedCloudflaredPath() !== null;
  return foundInPaths || foundInPath || foundInConfig;
}

/**
 * Get the current Cloudflare tunnel URL
 */
export function getCloudflareUrl(): string | null {
  return _url;
}

/**
 * Get current process (for testing)
 */
export function getProcess(): ChildProcess | null {
  return _process;
}

/**
 * Set process (for testing)
 */
export function setProcess(process: ChildProcess | null): void {
  _process = process;
}

/**
 * Set URL (for testing)
 */
export function setUrl(url: string | null): void {
  _url = url;
}

/**
 * Clear state (for testing)
 */
export function clearState(): void {
  _process = null;
  _url = null;
}
