#!/usr/bin/env node
// build-release.mjs
//
// Assemble a self-contained PingHub distribution from a completed
// `next build` (output: "standalone"). Produces:
//
//   dist/PingHub-<version>-<platform>[-<arch>][-bundled-node]/
//     app/                ← contents of .next/standalone/ (server.js + bundled deps + .next/static + public)
//     launcher/
//       launcher.mjs
//       node_modules/     ← just the launcher's tiny dep tree (get-port + its deps)
//       package.json      ← minimal, so node resolves the deps above
//     node/               ← (optional) bundled Node 20 runtime
//     start.cmd / start.sh
//     stop.cmd  / stop.sh
//     status.cmd/ status.sh
//     version.json
//     README.md, CHANGELOG.md, LICENSE
//
// Then zips it into dist/<name>.zip (Windows) or .tar.gz (POSIX).
//
// Usage:
//   node scripts/build-release.mjs               # current platform, no bundled Node
//   node scripts/build-release.mjs --bundle-node # download + include Node 20
//   node scripts/build-release.mjs --platform win32 --arch x64 --bundle-node
//
// Assumes `npm run build` has been run.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");
const STANDALONE = path.join(APP_ROOT, ".next", "standalone");
const PKG = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf-8"));
const VERSION = PKG.version;
const NODE_PIN = "20.18.0";

function parseArgs(argv) {
    const out = { bundleNode: false, platform: process.platform, arch: process.arch, outDir: path.join(APP_ROOT, "dist") };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--bundle-node") out.bundleNode = true;
        else if (a === "--platform") out.platform = argv[++i];
        else if (a === "--arch") out.arch = argv[++i];
        else if (a === "--out") out.outDir = path.resolve(argv[++i]);
        else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
        else { console.error(`unknown arg: ${a}`); process.exit(2); }
    }
    return out;
}
function printHelp() {
    console.log("Usage: node scripts/build-release.mjs [--bundle-node] [--platform <p>] [--arch <a>] [--out <dir>]");
}

function sh(cmd, args, opts = {}) {
    // shell: true on Windows so .cmd shims (npm.cmd, etc.) resolve via PATH.
    const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed with status ${r.status}`);
}

function copyDir(src, dst) {
    fs.cpSync(src, dst, { recursive: true });
}

function platformLabel(p) {
    if (p === "win32") return "win";
    if (p === "darwin") return "macos";
    return p;
}
function archLabel(a) { return a === "x64" ? "x64" : a; }

function nodeAssetName(platform, arch) {
    const a = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;
    if (platform === "win32") return { name: `node-v${NODE_PIN}-win-${a}.zip`, ext: "zip" };
    if (platform === "darwin") return { name: `node-v${NODE_PIN}-darwin-${a}.tar.gz`, ext: "tar.gz" };
    return { name: `node-v${NODE_PIN}-linux-${a}.tar.gz`, ext: "tar.gz" };
}

async function downloadNode(platform, arch, destDir) {
    const { name, ext } = nodeAssetName(platform, arch);
    const url = `https://nodejs.org/dist/v${NODE_PIN}/${name}`;
    const tmp = path.join(os.tmpdir(), `pinghub-node-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const archive = path.join(tmp, name);
    console.log(`[build-release] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(archive, buf);
    console.log(`[build-release] extracting ${name}`);
    if (ext === "zip") {
        // Use PowerShell on Windows, unzip elsewhere
        if (process.platform === "win32") {
            sh("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}' -Force`]);
        } else {
            sh("unzip", ["-q", archive, "-d", tmp]);
        }
    } else {
        sh("tar", ["-xzf", archive, "-C", tmp]);
    }
    const extracted = path.join(tmp, name.replace(/\.(zip|tar\.gz)$/, ""));
    if (!fs.existsSync(extracted)) throw new Error(`extracted dir not found: ${extracted}`);
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.renameSync(extracted, destDir);
    fs.rmSync(tmp, { recursive: true, force: true });
}

async function main() {
    const { bundleNode, platform, arch, outDir } = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(STANDALONE)) {
        console.error("[build-release] .next/standalone/ not found. Run `npm run build` first.");
        process.exit(1);
    }

    const labelParts = ["PingHub", `v${VERSION}`, platformLabel(platform), archLabel(arch)];
    if (bundleNode) labelParts.push("bundled-node");
    const distName = labelParts.join("-");
    const distRoot = path.join(outDir, distName);

    console.log(`[build-release] assembling ${distName}`);
    fs.rmSync(distRoot, { recursive: true, force: true });
    fs.mkdirSync(distRoot, { recursive: true });

    // 1. App (standalone) → dist/app
    const distApp = path.join(distRoot, "app");
    copyDir(STANDALONE, distApp);
    // Sanity: postbuild should have copied static + public into standalone.
    if (!fs.existsSync(path.join(distApp, ".next", "static"))) {
        console.warn("[build-release] WARNING: .next/static missing under standalone; CSS/JS will 404.");
        console.warn("[build-release]          Did postbuild (copy-standalone-assets.mjs) run?");
    }

    // 2. Launcher → dist/launcher
    const distLauncher = path.join(distRoot, "launcher");
    fs.mkdirSync(distLauncher, { recursive: true });
    fs.copyFileSync(path.join(APP_ROOT, "launcher", "launcher.mjs"), path.join(distLauncher, "launcher.mjs"));
    // Install ONLY get-port (the launcher's runtime dep) into launcher/node_modules.
    // We write a minimal package.json so npm has somewhere to root the install.
    const getPortVersion = PKG.dependencies["get-port"] ?? "^7.0.0";
    fs.writeFileSync(
        path.join(distLauncher, "package.json"),
        JSON.stringify({
            name: "pinghub-launcher",
            private: true,
            version: VERSION,
            type: "module",
            dependencies: { "get-port": getPortVersion }
        }, null, 2)
    );
    console.log("[build-release] installing launcher deps");
    sh(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], { cwd: distLauncher });
    // Strip lockfile noise from the dist.
    fs.rmSync(path.join(distLauncher, "package-lock.json"), { force: true });

    // 3. Top-level scripts (slim, no git/install/build)
    const scriptSrc = path.join(APP_ROOT, "scripts", "release");
    if (platform === "win32") {
        for (const f of ["start.cmd", "stop.cmd", "status.cmd"]) {
            fs.copyFileSync(path.join(scriptSrc, f), path.join(distRoot, f));
        }
    } else {
        for (const f of ["start.sh", "stop.sh", "status.sh"]) {
            const dst = path.join(distRoot, f);
            fs.copyFileSync(path.join(scriptSrc, f), dst);
            fs.chmodSync(dst, 0o755);
        }
    }

    // 4. version.json (consumed by launcher --version)
    fs.writeFileSync(
        path.join(distRoot, "version.json"),
        JSON.stringify({ version: VERSION, platform, arch, bundledNode: bundleNode, builtAt: new Date().toISOString() }, null, 2)
    );

    // 5. Docs
    for (const f of ["README.md", "CHANGELOG.md", "LICENSE"]) {
        const candidates = [path.join(APP_ROOT, f), path.join(REPO_ROOT, f)];
        const src = candidates.find((c) => fs.existsSync(c));
        if (src) fs.copyFileSync(src, path.join(distRoot, f));
    }

    // 6. Optional: bundle Node runtime
    if (bundleNode) {
        const nodeDir = path.join(distRoot, "node");
        await downloadNode(platform, arch, nodeDir);
        // Trim docs/sources from the Node tree (~30% saving on POSIX builds)
        for (const sub of ["share/doc", "share/man", "share/systemtap", "include", "CHANGELOG.md", "README.md"]) {
            fs.rmSync(path.join(nodeDir, sub), { recursive: true, force: true });
        }
    }

    // 7. Archive
    const archivePath = await archive(distRoot, platform, distName, outDir);
    const sha256 = sha256File(archivePath);
    fs.writeFileSync(`${archivePath}.sha256`, `${sha256}  ${path.basename(archivePath)}\n`);
    const sizeMB = (fs.statSync(archivePath).size / (1024 * 1024)).toFixed(1);
    console.log(`[build-release] OK: ${archivePath} (${sizeMB} MB)`);
    console.log(`[build-release] sha256: ${sha256}`);
}

async function archive(distRoot, platform, distName, outDir) {
    if (platform === "win32") {
        const zip = path.join(outDir, `${distName}.zip`);
        fs.rmSync(zip, { force: true });
        console.log(`[build-release] zipping → ${zip}`);
        sh("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${distRoot}\\*' -DestinationPath '${zip}' -Force`]);
        return zip;
    }
    const tgz = path.join(outDir, `${distName}.tar.gz`);
    fs.rmSync(tgz, { force: true });
    console.log(`[build-release] tarring → ${tgz}`);
    sh("tar", ["-czf", tgz, "-C", outDir, distName]);
    return tgz;
}

function sha256File(p) {
    const h = createHash("sha256");
    h.update(fs.readFileSync(p));
    return h.digest("hex");
}

main().catch((e) => { console.error(e); process.exit(1); });
