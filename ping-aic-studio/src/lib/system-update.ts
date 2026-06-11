// src/lib/system-update.ts
//
// Self-update support for the packaged PingHub distribution.
//
// Install layout (from scripts/build-release.mjs):
//
//   <distRoot>/
//     app/server.js            ← Next.js standalone server (PINGHUB_APP_DIR points here)
//     launcher/launcher.mjs
//     node/                    ← optional bundled Node runtime
//     start.cmd / start.sh
//     stop.cmd  / stop.sh
//     version.json             ← { version, platform, arch, bundledNode, builtAt }
//
// In source-dev mode (no version.json at the dist root) auto-update is
// disabled and we report `canUpdate: false`.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const GITHUB_OWNER = "bostonidentity";
const GITHUB_REPO = "PingHub";
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

export interface InstalledInfo {
    version: string;
    platform: string;
    arch: string;
    bundledNode: boolean;
    distRoot: string | null;       // null in source-dev mode
    source: "package" | "dev";
}

export interface ReleaseAsset {
    name: string;
    url: string;
    size: number;
}

export interface LatestRelease {
    version: string;
    publishedAt: string;
    htmlUrl: string;
    asset: ReleaseAsset | null;
    sha256Asset: ReleaseAsset | null;
    /** Release notes (GitHub release body, truncated), or null when empty. */
    notes: string | null;
}

// Release notes are shown in the update popups; cap what we ship to the client.
const NOTES_MAX_CHARS = 4000;

function truncateNotes(body: unknown): string | null {
    if (typeof body !== "string" || body.trim() === "") return null;
    const s = body.trim();
    return s.length > NOTES_MAX_CHARS ? `${s.slice(0, NOTES_MAX_CHARS)}…` : s;
}

export interface VersionStatus {
    installed: InstalledInfo;
    latest: LatestRelease | null;
    canUpdate: boolean;
    newerAvailable: boolean;
    reason?: string;
}

// ────────────────────────────────────────────────────────────────
// Installed-version detection
// ────────────────────────────────────────────────────────────────

/** Locate the packaged distribution root, or null in source-dev mode. */
export function resolveDistRoot(): string | null {
    // The launcher sets PINGHUB_APP_DIR to the app directory. In a packaged
    // release that's <distRoot>/app (the dir containing server.js). In source
    // dev it's <repo>/ping-aic-studio (no version.json sibling).
    const appDir = process.env.PINGHUB_APP_DIR;
    if (!appDir) return null;
    const parent = path.resolve(appDir, "..");
    if (fs.existsSync(path.join(parent, "version.json"))) return parent;
    return null;
}

export function readInstalledInfo(): InstalledInfo {
    const distRoot = resolveDistRoot();
    if (!distRoot) {
        // Source-dev: read version from app's package.json.
        let version = "0.0.0";
        try {
            const pkgPath = path.resolve(process.env.PINGHUB_APP_DIR ?? process.cwd(), "package.json");
            version = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
        } catch { /* ignore */ }
        return { version, platform: process.platform, arch: process.arch, bundledNode: false, distRoot: null, source: "dev" };
    }
    const meta = JSON.parse(fs.readFileSync(path.join(distRoot, "version.json"), "utf-8"));
    return {
        version: meta.version,
        platform: meta.platform ?? process.platform,
        arch: meta.arch ?? process.arch,
        bundledNode: Boolean(meta.bundledNode),
        distRoot,
        source: "package",
    };
}

// ────────────────────────────────────────────────────────────────
// GitHub release lookup (cached)
// ────────────────────────────────────────────────────────────────

let cache: { fetchedAt: number; release: LatestRelease | null } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchLatestRelease(force = false): Promise<LatestRelease | null> {
    if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.release;
    try {
        const res = await fetch(RELEASES_API, {
            headers: { Accept: "application/vnd.github+json", "User-Agent": `PingHub-self-update` },
        });
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        const body = await res.json() as {
            tag_name: string;
            published_at: string;
            html_url: string;
            body?: string;
            assets: { name: string; browser_download_url: string; size: number }[];
        };
        const release: LatestRelease = {
            version: body.tag_name.replace(/^v/, ""),
            publishedAt: body.published_at,
            htmlUrl: body.html_url,
            asset: null,
            sha256Asset: null,
            notes: truncateNotes(body.body),
        };
        cache = { fetchedAt: Date.now(), release };
        return release;
    } catch (e) {
        cache = { fetchedAt: Date.now(), release: null };
        console.error("[system-update] fetchLatestRelease failed:", (e as Error).message);
        return null;
    }
}

/**
 * Build the expected asset name for this install and find it in the release.
 *
 * Matches the naming convention from scripts/build-release.mjs:
 *   PingHub-v<version>-<platLabel>-<arch>[-bundled-node].<ext>
 *
 *   platLabel: win | macos | linux
 *   ext:       zip on Windows; tar.gz elsewhere
 */
export function pickAssetForInstall(installed: InstalledInfo, raw: { name: string; browser_download_url: string; size: number }[]): { asset: ReleaseAsset | null; sha256: ReleaseAsset | null } {
    const platLabel = installed.platform === "win32" ? "win"
        : installed.platform === "darwin" ? "macos"
            : "linux";
    const ext = installed.platform === "win32" ? "zip" : "tar.gz";
    const suffix = installed.bundledNode ? "-bundled-node" : "";
    const expected = `-${platLabel}-${installed.arch}${suffix}.${ext}`;
    const asset = raw.find((a) => a.name.endsWith(expected));
    const sha256 = asset ? raw.find((a) => a.name === `${asset.name}.sha256`) : undefined;
    return {
        asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
        sha256: sha256 ? { name: sha256.name, url: sha256.browser_download_url, size: sha256.size } : null,
    };
}

export async function getVersionStatus(force = false): Promise<VersionStatus> {
    const installed = readInstalledInfo();
    if (installed.source === "dev") {
        // Source installs update via git (the start script's pull prompt), so a
        // newer release never makes newerAvailable true here — but the latest
        // release still rides along so the what's-new popup can show its notes
        // inline after a pull (the popup matches latest.version to installed).
        const latest = await fetchLatestRelease(force);
        return { installed, latest, canUpdate: false, newerAvailable: false, reason: "running from source (no packaged install detected)" };
    }
    // Fetch and pick asset.
    try {
        const res = await fetch(RELEASES_API, {
            cache: force ? "no-store" : undefined,
            headers: { Accept: "application/vnd.github+json", "User-Agent": "PingHub-self-update" },
        });
        if (!res.ok) {
            return { installed, latest: null, canUpdate: false, newerAvailable: false, reason: `GitHub returned ${res.status}` };
        }
        const body = await res.json() as {
            tag_name: string; published_at: string; html_url: string; body?: string;
            assets: { name: string; browser_download_url: string; size: number }[];
        };
        const picked = pickAssetForInstall(installed, body.assets);
        const latest: LatestRelease = {
            version: body.tag_name.replace(/^v/, ""),
            publishedAt: body.published_at,
            htmlUrl: body.html_url,
            asset: picked.asset,
            sha256Asset: picked.sha256,
            notes: truncateNotes(body.body),
        };
        const newerAvailable = compareSemver(latest.version, installed.version) > 0;
        return {
            installed,
            latest,
            canUpdate: newerAvailable && !!picked.asset,
            newerAvailable,
            reason: newerAvailable && !picked.asset
                ? `no asset for ${installed.platform}-${installed.arch}${installed.bundledNode ? " (bundled-node)" : ""} in release v${latest.version}`
                : undefined,
        };
    } catch (e) {
        return { installed, latest: null, canUpdate: false, newerAvailable: false, reason: (e as Error).message };
    }
}

// ────────────────────────────────────────────────────────────────
// Semver comparison (just major.minor.patch, ignores pre-release)
// ────────────────────────────────────────────────────────────────

export function compareSemver(a: string, b: string): number {
    const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
    const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
}

// ────────────────────────────────────────────────────────────────
// Download + verify
// ────────────────────────────────────────────────────────────────

export async function downloadAsset(asset: ReleaseAsset, destPath: string): Promise<void> {
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error("download returned no body");
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(destPath));
}

export async function fetchExpectedSha256(asset: ReleaseAsset): Promise<string | null> {
    // sha256 sidecar format: "<hex>  <filename>\n"
    const res = await fetch(asset.url);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    const match = text.match(/^([0-9a-f]{64})\b/i);
    return match ? match[1].toLowerCase() : null;
}

export function sha256File(filePath: string): string {
    const h = createHash("sha256");
    h.update(fs.readFileSync(filePath));
    return h.digest("hex");
}

// ────────────────────────────────────────────────────────────────
// Updater handoff
// ────────────────────────────────────────────────────────────────

/**
 * Copy the bundled updater script to a temp dir (so it isn't deleted/locked
 * mid-upgrade when the install directory is swapped) and return its path.
 *
 * In source-dev the templates live at <repo>/ping-aic-studio/scripts/release/.
 * In a packaged install they live at <distRoot>/scripts/ (bundled by build-release.mjs).
 */
export function stageUpdaterScript(distRoot: string, tmpDir: string): string {
    fs.mkdirSync(tmpDir, { recursive: true });
    const isWin = process.platform === "win32";
    const scriptName = isWin ? "updater.cmd" : "updater.sh";

    // Search order: packaged dist's scripts/ → source repo's scripts/release/
    const candidates = [
        path.join(distRoot, "scripts", scriptName),
        path.resolve(distRoot, "..", "ping-aic-studio", "scripts", "release", scriptName),
        path.resolve(process.cwd(), "scripts", "release", scriptName),
    ];
    const src = candidates.find((c) => fs.existsSync(c));
    if (!src) throw new Error(`updater script not found; tried:\n  ${candidates.join("\n  ")}`);

    const dst = path.join(tmpDir, scriptName);
    fs.copyFileSync(src, dst);
    if (!isWin) fs.chmodSync(dst, 0o755);
    return dst;
}

export function makeUpdateWorkDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pinghub-update-"));
}
