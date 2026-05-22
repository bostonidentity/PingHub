import { describe, it, expect } from "vitest";
import { flattenForIndex, attrMatchesPath, collapseArrayIndices, INDEX_FIELD_MAX_LEN } from "./flatten-fields";

describe("flattenForIndex", () => {
    it("keeps top-level scalars", () => {
        const out = flattenForIndex({ _id: "u1", userName: "alice", count: 3, active: true });
        expect(out).toEqual({ _id: "u1", userName: "alice", count: "3", active: "true" });
    });

    it("flattens nested objects with dotted paths", () => {
        const out = flattenForIndex({
            _id: "u1",
            profile: { givenName: "Alice", address: { city: "Boston" } },
        });
        expect(out).toEqual({
            _id: "u1",
            "profile.givenName": "Alice",
            "profile.address.city": "Boston",
        });
    });

    it("indexes array elements with numeric suffix", () => {
        const out = flattenForIndex({ _id: "u1", mail: ["a@x.co", "a@y.co"] });
        expect(out).toEqual({ _id: "u1", "mail.0": "a@x.co", "mail.1": "a@y.co" });
    });

    it("captures _ref relationship pointers at any depth", () => {
        const out = flattenForIndex({
            _id: "u1",
            manager: { _ref: "managed/user/abc-123", _refProperties: { grantType: "manual" } },
            roles: [{ _ref: "managed/role/r1" }, { _ref: "managed/role/r2" }],
        });
        expect(out).toEqual({
            _id: "u1",
            "manager._ref": "managed/user/abc-123",
            "manager._refProperties.grantType": "manual",
            "roles.0._ref": "managed/role/r1",
            "roles.1._ref": "managed/role/r2",
        });
    });

    it("skips strings longer than INDEX_FIELD_MAX_LEN", () => {
        const long = "x".repeat(INDEX_FIELD_MAX_LEN + 1);
        const out = flattenForIndex({ _id: "u1", short: "ok", long });
        expect(out).toEqual({ _id: "u1", short: "ok" });
    });

    it("keeps realistic multi-hundred-char description fields", () => {
        // Regression: dashboard widget descriptions, translated UI copy, and
        // long instructions used to be silently dropped by the 200-char cap.
        const desc = "Allows case workers to query data — WARNING! BY ACCESSING AND USING THIS GOVERNMENT COMPUTER SYSTEM, YOU ARE CONSENTING TO SYSTEM MONITORING FOR LAW ENFORCEMENT AND OTHER PURPOSES. UNAUTHORIZED USE OF, OR ACCESS TO, THIS COMPUTER SYSTEM MAY SUBJECT YOU TO CRIMINAL PROSECUTION AND PENALTIES.";
        expect(desc.length).toBeGreaterThan(200);
        const out = flattenForIndex({
            _id: "w1",
            content: [{ myAppsDescription: { en: desc, es: "..." } }],
        });
        expect(out["content.0.myAppsDescription.en"]).toBe(desc);
    });

    it("skips null and undefined leaves", () => {
        const out = flattenForIndex({ _id: "u1", a: null, b: undefined, c: "ok" });
        expect(out).toEqual({ _id: "u1", c: "ok" });
    });

    it("handles empty objects and arrays gracefully", () => {
        const out = flattenForIndex({ _id: "u1", empty: {}, none: [] });
        expect(out).toEqual({ _id: "u1" });
    });
});

describe("attrMatchesPath", () => {
    it("matches exact paths case-insensitively", () => {
        expect(attrMatchesPath("profile.givenName", "profile.givenName")).toBe(true);
        expect(attrMatchesPath("PROFILE.givenname", "profile.givenName")).toBe(true);
    });

    it("matches prefix paths so attr='mail' covers all array elements", () => {
        expect(attrMatchesPath("mail", "mail.0")).toBe(true);
        expect(attrMatchesPath("mail", "mail.1")).toBe(true);
        expect(attrMatchesPath("profile", "profile.givenName")).toBe(true);
        expect(attrMatchesPath("profile", "profile.address.city")).toBe(true);
    });

    it("matches by last segment regardless of depth", () => {
        expect(attrMatchesPath("givenName", "profile.givenName")).toBe(true);
        expect(attrMatchesPath("_ref", "manager._ref")).toBe(true);
        expect(attrMatchesPath("_ref", "roles.0._ref")).toBe(true);
    });

    it("matches collapsed-form attrs against array-indexed paths", () => {
        // The dropdown shows collapsed paths (no `.0`). The user picks
        // "addresses.city" but the stored path is "addresses.0.city" — the
        // collapse-then-retry rule covers this.
        expect(attrMatchesPath("addresses.city", "addresses.0.city")).toBe(true);
        expect(attrMatchesPath("roles._ref", "roles.0._ref")).toBe(true);
        expect(attrMatchesPath("addresses", "addresses.0.city")).toBe(true);
    });

    it("does not match unrelated paths", () => {
        expect(attrMatchesPath("mail", "userMail")).toBe(false); // not a prefix segment
        expect(attrMatchesPath("name", "userName")).toBe(false); // last segment must equal, not be a suffix
        expect(attrMatchesPath("profile.givenName", "profile.surname")).toBe(false);
    });
});

describe("collapseArrayIndices", () => {
    it("removes numeric segments", () => {
        expect(collapseArrayIndices("mail.0")).toBe("mail");
        expect(collapseArrayIndices("addresses.0.city")).toBe("addresses.city");
        expect(collapseArrayIndices("roles.12._ref")).toBe("roles._ref");
    });

    it("leaves non-array paths unchanged", () => {
        expect(collapseArrayIndices("profile.givenName")).toBe("profile.givenName");
        expect(collapseArrayIndices("_id")).toBe("_id");
    });
});
