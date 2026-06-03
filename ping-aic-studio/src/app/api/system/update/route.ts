import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import {
    getVersionStatus,
    downloadAsset,
    fetchExpectedSha256,
    sha256File,
    stageUpdaterScript,
    makeUpdateWorkDir,
} from "@/lib/system-update";

export const dynamic = "force-dynamic";

export async function POST() {
    const status = await getVersionStatus(true);
    if (!status.canUpdate || !status.installed.distRoot || !status.latest?.asset) {
        return NextResponse.json(
            { ok: false, error: status.reason ?? "no update available" },
            { status: 400 },
        );
    }

    const workDir = makeUpdateWorkDir();
    const archivePath = path.join(workDir, status.latest.asset.name);

    // 1. Download
    try {
        await downloadAsset(status.latest.asset, archivePath);
    } catch (e) {
        return NextResponse.json({ ok: false, error: `download failed: ${(e as Error).message}` }, { status: 502 });
    }

    // 2. Verify sha256 (warn-only if sidecar missing; mismatch is fatal)
    if (status.latest.sha256Asset) {
        const expected = await fetchExpectedSha256(status.latest.sha256Asset);
        if (expected) {
            const actual = sha256File(archivePath);
            if (actual.toLowerCase() !== expected.toLowerCase()) {
                fs.rmSync(workDir, { recursive: true, force: true });
                return NextResponse.json(
                    { ok: false, error: `sha256 mismatch (got ${actual}, expected ${expected})` },
                    { status: 502 },
                );
            }
        }
    }

    // 3. Stage updater script
    let updaterPath: string;
    try {
        updaterPath = stageUpdaterScript(status.installed.distRoot, workDir);
    } catch (e) {
        fs.rmSync(workDir, { recursive: true, force: true });
        return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }

    // 4. Spawn updater detached. It waits for THIS process to exit before
    //    touching the install dir, then extracts, swaps, and relaunches.
    const port = process.env.PORT ?? "3000";
    const args = [status.installed.distRoot, archivePath, String(process.pid), port];

    try {
        if (process.platform === "win32") {
            spawnDetachedWindows(updaterPath, args, workDir);
        } else {
            spawnDetachedPosix(updaterPath, args, workDir);
        }
    } catch (e) {
        fs.rmSync(workDir, { recursive: true, force: true });
        return NextResponse.json({ ok: false, error: `spawn updater failed: ${(e as Error).message}` }, { status: 500 });
    }

    // 5. Schedule self-exit after responding, so the launcher releases file
    //    handles and the updater can swap the install directory.
    const restartingAt = new Date(Date.now() + 1500).toISOString();
    setTimeout(() => {
        console.log("[system-update] exiting for upgrade to v" + status.latest!.version);
        process.exit(0);
    }, 1500).unref();

    return NextResponse.json({
        ok: true,
        targetVersion: status.latest.version,
        workDir,
        restartingAt,
    }, { status: 202 });
}

function spawnDetachedWindows(script: string, args: string[], cwd: string) {
    // Use cmd.exe /c to run the .cmd file in a detached, hidden process tree.
    // PowerShell's Start-Process is a more robust detach mechanism on Windows.
    const psArgs = [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath '${script}' -ArgumentList ${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(",")} -WindowStyle Hidden -WorkingDirectory '${cwd.replace(/'/g, "''")}'`,
    ];
    const child = spawn("powershell.exe", psArgs, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
    });
    child.unref();
}

function spawnDetachedPosix(script: string, args: string[], cwd: string) {
    const child = spawn("/bin/bash", [script, ...args], {
        stdio: "ignore",
        detached: true,
        cwd,
    });
    child.unref();
}
