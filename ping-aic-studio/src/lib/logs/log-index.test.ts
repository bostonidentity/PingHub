import { describe, it, expect } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { openDayDb, insertRows, countEntries, queryDay, LOG_SCHEMA_VERSION } from "./log-index";
import type { LogIndexRow } from "./log-types";

function tmpDb(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "log-idx-")), "2026-06-02.sqlite");
}

function row(over: Partial<LogIndexRow> = {}): LogIndexRow {
    return {
        id: "id-1", timestamp: "2026-06-02T00:00:00Z", transactionId: "txn-1",
        eventName: "AM-TREE-LOGIN-COMPLETED", level: "INFO", realm: "/alpha", userId: "user-1",
        offset: 0, length: 10, payloadJson: '{"_id":"id-1"}', searchable: "am-tree-login-completed txn-1 user-1 /alpha",
        ...over,
    };
}

describe("log-index", () => {
    it("creates schema and stamps the version on first open", () => {
        const db = openDayDb(tmpDb());
        const meta = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string };
        expect(meta.value).toBe(String(LOG_SCHEMA_VERSION));
        db.close();
    });

    it("inserts rows and counts them", () => {
        const db = openDayDb(tmpDb());
        const inserted = insertRows(db, [row({ id: "a" }), row({ id: "b" })]);
        expect(inserted).toBe(2);
        expect(countEntries(db)).toBe(2);
        db.close();
    });

    it("dedupes by id via INSERT OR IGNORE (returns only newly inserted count)", () => {
        const db = openDayDb(tmpDb());
        expect(insertRows(db, [row({ id: "a" }), row({ id: "b" })])).toBe(2);
        expect(insertRows(db, [row({ id: "b" }), row({ id: "c" })])).toBe(1); // only c is new
        expect(countEntries(db)).toBe(3);
        db.close();
    });

    it("queryDay filters by eventName and free text", () => {
        const db = openDayDb(tmpDb());
        insertRows(db, [
            row({ id: "a", eventName: "AM-NODE-LOGIN-COMPLETED", searchable: "am-node-login-completed txn-1 alice /alpha", payloadJson: '{"u":"alice"}' }),
            row({ id: "b", eventName: "AM-TREE-LOGIN-COMPLETED", searchable: "am-tree-login-completed txn-2 bob /alpha", payloadJson: '{"u":"bob"}' }),
        ]);
        const byEvent = queryDay(db, { eventName: "AM-TREE-LOGIN-COMPLETED" });
        expect(byEvent.map((r) => r.payloadJson)).toEqual(['{"u":"bob"}']);
        const byText = queryDay(db, { text: "alice" });
        expect(byText.map((r) => r.payloadJson)).toEqual(['{"u":"alice"}']);
        db.close();
    });

    it("drops entries on a stale schemaVersion and re-opens clean", () => {
        const p = tmpDb();
        const db1 = openDayDb(p);
        insertRows(db1, [row({ id: "a" })]);
        db1.prepare("UPDATE meta SET value='0' WHERE key='schemaVersion'").run();
        db1.close();
        const db2 = openDayDb(p);
        expect(countEntries(db2)).toBe(0);
        db2.close();
    });

    it("queryDay filters by transactionId", () => {
        const db = openDayDb(tmpDb());
        insertRows(db, [
            row({ id: "a", transactionId: "txn-1" }),
            row({ id: "b", transactionId: "txn-2" }),
        ]);
        expect(queryDay(db, { transactionId: "txn-2" }).map((r) => r.id)).toEqual(["b"]);
        db.close();
    });

    it("queryDay respects limit", () => {
        const db = openDayDb(tmpDb());
        insertRows(db, [
            row({ id: "a", timestamp: "2026-06-02T00:00:00Z" }),
            row({ id: "b", timestamp: "2026-06-02T01:00:00Z" }),
            row({ id: "c", timestamp: "2026-06-02T02:00:00Z" }),
        ]);
        expect(queryDay(db, { limit: 2 })).toHaveLength(2);
        db.close();
    });
});
