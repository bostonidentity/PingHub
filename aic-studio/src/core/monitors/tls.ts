// src/core/monitors/tls.ts
import { connect } from "node:tls";

export interface TlsCheckResult {
  ok: boolean;
  daysRemaining: number;
  subject: string;
  issuer: string;
  validTo: Date;
  error?: string;
}

export function checkTls(host: string, port = 443, timeoutMs = 5000): Promise<TlsCheckResult> {
  return new Promise((resolve) => {
    const socket = connect(
      { host, port, servername: host, rejectUnauthorized: true },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        const validTo = new Date(cert.valid_to);
        const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86400000);
        resolve({
          ok: true,
          daysRemaining,
          subject: cert.subject?.CN ?? "",
          issuer: cert.issuer?.CN ?? "",
          validTo
        });
      }
    );
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve({
        ok: false,
        daysRemaining: 0,
        subject: "",
        issuer: "",
        validTo: new Date(0),
        error: "timeout"
      });
    });
    socket.on("error", (err) =>
      resolve({
        ok: false,
        daysRemaining: 0,
        subject: "",
        issuer: "",
        validTo: new Date(0),
        error: err.message
      })
    );
  });
}
