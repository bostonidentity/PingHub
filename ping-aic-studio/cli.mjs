#!/usr/bin/env node
/**
 * Thin CLI wrapper around Next.js that supports a --data-dir flag.
 *
 * Usage:
 *   node cli.mjs dev --data-dir /path/to/environments
 *   node cli.mjs build
 *   node cli.mjs start --data-dir D:\data\environments
 *
 * The --data-dir value is forwarded as PINGHUB_DATA_DIR.
 * All other arguments are passed through to `next` unchanged.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const nextArgs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--data-dir" && i + 1 < args.length) {
    process.env.PINGHUB_DATA_DIR = resolve(args[++i]);
  } else {
    nextArgs.push(args[i]);
  }
}

try {
  execFileSync("npx", ["next", ...nextArgs], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
