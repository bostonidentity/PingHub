# AIC Tenant Log Retrieval

Plan for adding comprehensive log retrieval by querying Ping AIC monitoring logs via the `/monitoring/logs` API. Auth is Basic with an API key and secret stored in `log-api.json` per environment (already managed via the Log API credentials tab in the environment editor).

---

## Priority 1 — Log Source Browser (foundation)

New page at `/logs`. This is the entry point for all log retrieval.

- Environment selector showing only environments that have Log API credentials configured
- Source selector populated dynamically from `GET {tenant}/monitoring/logs/sources`
- Time range controls:
  - Preset buttons: Last 15 min / 1h / 6h / 24h
  - Custom from/to inputs accepting ISO 8601 datetime strings
- Fetch button triggers `GET {tenant}/monitoring/logs?source=...&beginTime=...&endTime=...&_pageSize=50`
- Results are paginated using `_pagedResultsCookie` cursor — "Load more" button appends next page

---

## Priority 2 — Structured Entry Viewer

Render results as a table rather than raw JSON.

- Columns: timestamp, level/type, component, message summary
- Expandable row opens a raw JSON payload drawer for the full entry
- Client-side search and filter — reuse the existing `LogViewer` search infrastructure:
  - Filter by level (ERROR / WARN)
  - Filter by component or userId
  - Free-text search across the payload
- Highlight search matches inside the expanded payload drawer

---

## Priority 3 — Live Tail

Auto-poll for new entries while the user is viewing a source.

- Toggle to start/stop tailing
- Poll interval configurable: 5s / 10s / 30s
- Uses the latest `_pagedResultsCookie` from the previous response to fetch only new entries (no re-fetching the full window)
- Pulsing dot indicator in the UI when tail is active
- New entries auto-scroll into view

---

## Priority 4 — Transaction ID Drill-down

Cross-source trace for a single transaction.

- Every log entry's `transactionId` is rendered as a clickable link
- Clicking opens a drill-down view that re-queries multiple sources filtered to that transaction ID
- Results from all sources are merged and interleaved by timestamp
- Presents an end-to-end flow trace across AM and IDM sources in a single unified timeline

---

## Priority 5 — Multi-source Fan-out + Export

Query and combine multiple sources in one operation.

- Multi-select source picker (checkbox list or tag input)
- Results from all selected sources merged and interleaved by timestamp
- Source badge on each row so entries can be distinguished at a glance
- Export button: download the current page as JSON or CSV
- Saved queries: named presets storing source selection, time range, and filters — persisted per environment in local JSON (alongside `log-api.json`)

---

## Priority 6 — Cross-environment Comparison

Run the same query against two environments simultaneously.

- Side-by-side layout: left env / right env, same source + time range
- Useful post-promote to verify that behaviour changed as expected
- Diff-style highlighting optional (errors in one but not the other)

---

## API Notes

- **Logs endpoint:** `GET {TENANT_BASE_URL}/monitoring/logs`
- **Sources endpoint:** `GET {TENANT_BASE_URL}/monitoring/logs/sources`
- **Auth:** `Authorization: Basic base64(apiKey:apiSecret)` — credentials from `log-api.json`
- **Key query params:**

  | Param | Description |
  |---|---|
  | `source` | Log source name (e.g. `am-everything`, `idm-everything`) |
  | `beginTime` | ISO 8601 start of window |
  | `endTime` | ISO 8601 end of window |
  | `_pageSize` | Entries per page (default 50) |
  | `_pagedResultsCookie` | Cursor returned by previous response; omit for first page |

- **Response shape:**
  ```json
  {
    "result": [...],
    "pagedResultsCookie": "...",
    "resultCount": 50
  }
  ```
- **Entry shape:** `{ timestamp, type, payload: { ... } }` — `payload` varies by source and entry type

---

## Implementation Status

- [ ] Priority 1: Log Source Browser
- [ ] Priority 2: Structured Entry Viewer
- [ ] Priority 3: Live Tail
- [ ] Priority 4: Transaction ID Drill-down
- [ ] Priority 5: Multi-source Fan-out + Export
- [ ] Priority 6: Cross-environment Comparison
