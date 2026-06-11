import { describe, it, expect } from "vitest";
import { updateNotice, type UpdateNoticeInput } from "./update-notice";

const base: UpdateNoticeInput = {
    installedVersion: "0.3.9",
    latestVersion: "0.3.9",
    newerAvailable: false,
    notifiedVersion: null,
    lastSeenVersion: "0.3.9",
};

describe("updateNotice", () => {
    it("shows nothing when up to date and already seen", () => {
        expect(updateNotice(base)).toBeNull();
    });

    it("shows nothing on a fresh profile (lastSeen null) even with no notified version", () => {
        expect(updateNotice({ ...base, lastSeenVersion: null })).toBeNull();
    });

    it("shows new-version once when a newer release is published", () => {
        expect(updateNotice({ ...base, latestVersion: "0.4.0", newerAvailable: true })).toBe("new-version");
    });

    it("does not re-show new-version after it was notified", () => {
        expect(updateNotice({ ...base, latestVersion: "0.4.0", newerAvailable: true, notifiedVersion: "0.4.0" })).toBeNull();
    });

    it("re-shows new-version for a NEWER publish than the notified one", () => {
        expect(updateNotice({ ...base, latestVersion: "0.4.1", newerAvailable: true, notifiedVersion: "0.4.0" })).toBe("new-version");
    });

    it("shows what's-new after the installed version changes", () => {
        expect(updateNotice({ ...base, installedVersion: "0.4.0", latestVersion: "0.4.0", lastSeenVersion: "0.3.9" })).toBe("whats-new");
    });

    it("prefers what's-new over new-version when both are eligible", () => {
        expect(updateNotice({
            installedVersion: "0.4.0", latestVersion: "0.4.1", newerAvailable: true,
            notifiedVersion: null, lastSeenVersion: "0.3.9",
        })).toBe("whats-new");
    });

    it("ignores newerAvailable when latestVersion is null", () => {
        expect(updateNotice({ ...base, latestVersion: null, newerAvailable: true })).toBeNull();
    });
});
