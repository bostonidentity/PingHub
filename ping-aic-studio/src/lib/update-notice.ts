// Decides which one-time update popup (if any) to show, given the current
// version status and what this browser has already acknowledged.
// Pure so the precedence rules are unit-testable; the component owns the
// localStorage reads/writes (docs/superpowers/specs/2026-06-11-update-notice-popups-design.md).

export interface UpdateNoticeInput {
    installedVersion: string;
    latestVersion: string | null;
    newerAvailable: boolean;
    /** Last latest-version this browser was popped for (pinghub.update.notified). */
    notifiedVersion: string | null;
    /** Last installed version this browser acknowledged (pinghub.version.lastSeen). */
    lastSeenVersion: string | null;
}

export type UpdateNotice = "whats-new" | "new-version" | null;

/**
 * Precedence: what's-new (the install changed under this browser — confirm
 * what changed) before new-version (a newer release exists). A null
 * lastSeenVersion is the fresh-profile case: the component initializes the
 * key silently and never shows what's-new for it.
 */
export function updateNotice(input: UpdateNoticeInput): UpdateNotice {
    const { installedVersion, latestVersion, newerAvailable, notifiedVersion, lastSeenVersion } = input;
    if (lastSeenVersion !== null && installedVersion !== lastSeenVersion) return "whats-new";
    if (newerAvailable && latestVersion !== null && latestVersion !== notifiedVersion) return "new-version";
    return null;
}
