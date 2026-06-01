#!/usr/bin/env node
// Compute a SHA-256 fingerprint of all build-affecting inputs.
// Used by ../../start and ../../start.cmd to decide whether the existing
// .next build is stale (e.g. after a git pull, branch switch, or local edit)
// and needs to be wiped + rebuilt.
//
// Prints a single lowercase hex string to stdout. No other output.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Files and directories whose contents affect the Next.js production build.
// Keep this list in sync with what `npm run build` actually consumes.
const INPUT_PATHS = [
    'src',
    'public',
    'scripts',
    'launcher',
    'next.config.ts',
    'tsconfig.json',
    'postcss.config.mjs',
    'eslint.config.mjs',
    'package.json',
    'package-lock.json',
];

function walk(p, out) {
    let st;
    try {
        st = statSync(p);
    } catch {
        return;
    }
    if (st.isDirectory()) {
        for (const name of readdirSync(p).sort()) walk(join(p, name), out);
    } else if (st.isFile()) {
        out.push(p);
    }
}

const files = [];
for (const rel of INPUT_PATHS) walk(join(APP_DIR, rel), files);
files.sort();

const top = createHash('sha256');
top.update(`node-major=${process.versions.node.split('.')[0]}\n`);
for (const f of files) {
    const h = createHash('sha256').update(readFileSync(f)).digest('hex');
    const rel = relative(APP_DIR, f).replace(/\\/g, '/');
    top.update(`${rel} ${h}\n`);
}

process.stdout.write(top.digest('hex'));
