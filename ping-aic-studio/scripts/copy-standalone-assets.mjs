#!/usr/bin/env node
// copy-standalone-assets.mjs
//
// Next.js's `output: "standalone"` build produces a self-contained server
// at .next/standalone/server.js — but it does NOT copy the static asset
// trees (.next/static/ and public/) into the standalone dir. Without
// them, the server runs but every CSS/JS chunk request 404s, and the
// app renders as unstyled HTML.
//
// This script is wired as `postbuild` in package.json so every `next
// build` is followed by a sync of .next/static/ -> .next/standalone/.next/static/
// and public/ -> .next/standalone/public/.
//
// Idempotent: each run wipes the destination first, so stale chunks
// from a previous build don't linger.

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const STANDALONE_DIR = path.join(ROOT, ".next", "standalone");

if (!fs.existsSync(STANDALONE_DIR)) {
  console.error("[copy-standalone-assets] .next/standalone/ not found");
  console.error("[copy-standalone-assets] (next.config must have output: 'standalone' for this script to apply)");
  process.exit(0);
}

const PAIRS = [
  { src: path.join(ROOT, ".next", "static"), dst: path.join(STANDALONE_DIR, ".next", "static") },
  { src: path.join(ROOT, "public"),          dst: path.join(STANDALONE_DIR, "public") }
];

for (const { src, dst } of PAIRS) {
  if (!fs.existsSync(src)) {
    console.log(`[copy-standalone-assets] skip (source missing): ${path.relative(ROOT, src)}`);
    continue;
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`[copy-standalone-assets] ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dst)}`);
}
