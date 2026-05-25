import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import getPort from "get-port";

const KNOWN_FLAGS = new Set(["--port", "--data-dir", "--no-open", "--update", "--uninstall", "--version"]);

export function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let v;
    const eq = a.indexOf("=");
    if (eq > 0) {
      v = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (!KNOWN_FLAGS.has(a)) throw new Error(`unknown flag: ${a}`);
    switch (a) {
      case "--port": {
        const raw = v ?? argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid --port: ${raw}`);
        out.port = n;
        break;
      }
      case "--data-dir": out.dataDir = v ?? argv[++i]; break;
      case "--no-open":  out.noOpen = true; break;
      case "--update":   out.update = true; break;
      case "--uninstall":out.uninstall = true; break;
      case "--version":  out.version = true; break;
    }
  }
  return out;
}

export function resolveOpenCommand(platform, url) {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "linux") return { cmd: "xdg-open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  throw new Error(`unsupported platform: ${platform}`);
}

export async function waitForServer(url, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return;
    } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${url} after ${timeoutMs}ms`);
}

const PREFERRED_PORT = 47391;
const INSTALL_DIR = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "PingHub")
  : path.join(os.homedir(), ".pinghub");

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgv(argv); }
  catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  if (opts.version) {
    const vp = path.join(INSTALL_DIR, "version.json");
    if (existsSync(vp)) {
      const v = JSON.parse(readFileSync(vp, "utf-8"));
      console.log(v.version);
    } else {
      console.log("unknown (running from source)");
    }
    return;
  }

  if (opts.update) {
    console.error("--update not implemented in launcher; re-run the install script:");
    console.error("  curl -fsSL https://raw.githubusercontent.com/bostonidentity/PingHub/main/aic-pipeline/launcher/install.sh | bash");
    process.exit(1);
  }

  if (opts.uninstall) {
    console.error("--uninstall not implemented in launcher; run:");
    console.error(process.platform === "win32"
      ? `  Remove-Item -Recurse "${INSTALL_DIR}"`
      : `  rm -rf "${INSTALL_DIR}" && rm -f /usr/local/bin/pinghub`);
    process.exit(1);
  }

  const port = opts.port ?? await getPort({ port: PREFERRED_PORT });
  const dataDir = opts.dataDir ?? path.join(INSTALL_DIR, "data");
  mkdirSync(dataDir, { recursive: true });

  // Resolve standalone server.js location.
  // In tarball install: <INSTALL_DIR>/app/.next/standalone/server.js
  // In source dev:      <repo>/aic-pipeline/.next/standalone/server.js
  const launcherDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(launcherDir, "..", "app", ".next", "standalone", "server.js"),   // tarball
    path.resolve(launcherDir, "..", ".next", "standalone", "server.js")           // source
  ];
  const serverJs = candidates.find((c) => existsSync(c));
  if (!serverJs) {
    console.error("[pinghub] could not locate Next.js standalone server.js");
    console.error("[pinghub] tried:");
    candidates.forEach((c) => console.error(`  ${c}`));
    process.exit(3);
  }

  console.error(`[pinghub] using port ${port}`);
  console.error(`[pinghub] data dir ${dataDir}`);
  console.error(`[pinghub] starting server...`);

  const child = spawn(process.execPath, [serverJs], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      PINGHUB_DATA_DIR: dataDir
    },
    cwd: path.dirname(serverJs)
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(url, { timeoutMs: 30000 });
  } catch (e) {
    console.error(`[pinghub] server failed to start: ${e.message}`);
    child.kill("SIGTERM");
    process.exit(4);
  }
  console.error(`[pinghub] ready at ${url}`);

  if (!opts.noOpen) {
    try {
      const { cmd, args } = resolveOpenCommand(process.platform, url);
      spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
      console.error("[pinghub] opened browser");
    } catch (e) {
      console.error(`[pinghub] could not open browser: ${e.message} (visit ${url} manually)`);
    }
  }

  // Clean shutdown
  const shutdown = () => {
    console.error("[pinghub] shutting down...");
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

// Run main if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
