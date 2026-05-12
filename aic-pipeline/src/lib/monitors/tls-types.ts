export type TlsStatus = "ok" | "warning" | "expired" | "error" | "unknown";

export interface TlsTarget {
    id: string;
    label: string;
    url: string;
    /** Override SNI servername (defaults to hostname from url). */
    servername?: string;
    /** Days before expiry to flag as `warning`. Defaults to 30. */
    warnDays?: number;
    /** Days before expiry to flag as `expired-soon` critical. Defaults to 7. */
    criticalDays?: number;
    enabled?: boolean;
}

export interface TlsMonitorsFile {
    targets: TlsTarget[];
}

export interface TlsCheckResult {
    id: string;
    status: TlsStatus;
    host: string;
    port: number;
    subject?: string;
    issuer?: string;
    /** ISO timestamp when the certificate becomes valid. */
    validFrom?: string;
    /** ISO timestamp when the certificate expires. */
    validTo?: string;
    /** Days until expiration (can be negative if expired). */
    daysRemaining?: number;
    /** Subject alternative names. */
    san?: string[];
    /** Fingerprint (SHA-256). */
    fingerprint256?: string;
    serialNumber?: string;
    message: string;
    error?: string;
    checkedAt: string;
}
