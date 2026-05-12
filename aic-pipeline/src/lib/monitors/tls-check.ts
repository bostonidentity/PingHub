import tls from "node:tls";
import type { PeerCertificate, DetailedPeerCertificate } from "node:tls";

import type { TlsCheckResult, TlsStatus, TlsTarget } from "./tls-types";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_WARN_DAYS = 30;
const DEFAULT_CRITICAL_DAYS = 7;

function parseHostPort(url: string): { host: string; port: number } {
    // Accept "host", "host:port", or full URL.
    if (url.includes("://")) {
        const u = new URL(url);
        return {
            host: u.hostname,
            port: u.port ? Number(u.port) : 443,
        };
    }
    const [host, port] = url.split(":");
    return { host, port: port ? Number(port) : 443 };
}

function toIso(d: string | undefined): string | undefined {
    if (!d) return undefined;
    const t = new Date(d);
    if (Number.isNaN(t.getTime())) return undefined;
    return t.toISOString();
}

function extractSan(cert: PeerCertificate): string[] | undefined {
    const raw = (cert as PeerCertificate & { subjectaltname?: string }).subjectaltname;
    if (!raw) return undefined;
    return raw.split(",").map((s) => s.trim());
}

function toStr(v: string | string[] | undefined): string | undefined {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v.join(", ") : v;
}

export async function runTlsCheck(target: TlsTarget): Promise<TlsCheckResult> {
    const checkedAt = new Date().toISOString();
    const { host, port } = parseHostPort(target.url);
    const servername = target.servername || host;
    const warnDays = target.warnDays ?? DEFAULT_WARN_DAYS;
    const criticalDays = target.criticalDays ?? DEFAULT_CRITICAL_DAYS;

    return new Promise<TlsCheckResult>((resolve) => {
        const socket = tls.connect({
            host,
            port,
            servername,
            // We want to inspect even self-signed/expired certs without throwing.
            rejectUnauthorized: false,
            timeout: DEFAULT_TIMEOUT_MS,
        });

        let settled = false;
        const settle = (result: TlsCheckResult) => {
            if (settled) return;
            settled = true;
            try {
                socket.destroy();
            } catch {
                /* ignore */
            }
            resolve(result);
        };

        socket.once("secureConnect", () => {
            const cert = socket.getPeerCertificate(true) as DetailedPeerCertificate;
            if (!cert || Object.keys(cert).length === 0) {
                settle({
                    id: target.id,
                    status: "error",
                    host,
                    port,
                    message: "No peer certificate returned",
                    checkedAt,
                });
                return;
            }
            const validFrom = toIso(cert.valid_from);
            const validTo = toIso(cert.valid_to);
            const now = Date.now();
            const expiryMs = validTo ? new Date(validTo).getTime() : NaN;
            const daysRemaining = Number.isFinite(expiryMs)
                ? Math.floor((expiryMs - now) / (1000 * 60 * 60 * 24))
                : undefined;

            let status: TlsStatus;
            let message: string;
            if (daysRemaining === undefined) {
                status = "error";
                message = "Could not parse certificate expiration";
            } else if (daysRemaining < 0) {
                status = "expired";
                message = `Expired ${Math.abs(daysRemaining)} day(s) ago`;
            } else if (daysRemaining <= criticalDays) {
                status = "expired";
                message = `Expires in ${daysRemaining} day(s) (critical)`;
            } else if (daysRemaining <= warnDays) {
                status = "warning";
                message = `Expires in ${daysRemaining} day(s)`;
            } else {
                status = "ok";
                message = `Valid · ${daysRemaining} day(s) remaining`;
            }

            const subject =
                typeof cert.subject === "object" && cert.subject
                    ? toStr(cert.subject.CN) || JSON.stringify(cert.subject)
                    : undefined;
            const issuer =
                typeof cert.issuer === "object" && cert.issuer
                    ? toStr(cert.issuer.CN) || JSON.stringify(cert.issuer)
                    : undefined;

            settle({
                id: target.id,
                status,
                host,
                port,
                subject,
                issuer,
                validFrom,
                validTo,
                daysRemaining,
                san: extractSan(cert),
                fingerprint256: cert.fingerprint256,
                serialNumber: cert.serialNumber,
                message,
                checkedAt,
            });
        });

        socket.once("timeout", () => {
            settle({
                id: target.id,
                status: "error",
                host,
                port,
                message: `Timed out after ${DEFAULT_TIMEOUT_MS}ms`,
                error: "timeout",
                checkedAt,
            });
        });

        socket.once("error", (err: NodeJS.ErrnoException) => {
            const code = err.code || "";
            let message = err.message || String(err);
            if (code === "ENOTFOUND") message = `DNS lookup failed for ${host}`;
            else if (code === "ECONNREFUSED") message = `Connection refused on ${host}:${port}`;
            else if (code === "ETIMEDOUT") message = `Connection timed out to ${host}:${port}`;
            settle({
                id: target.id,
                status: "error",
                host,
                port,
                message,
                error: code || "error",
                checkedAt,
            });
        });
    });
}
