# Journey View Ideas

Alternative ways to present a journey tree so users can explore it from different perspectives.

---

## 1. Folder / Tree Outline View ✅ (implementing first)

Like a file explorer — collapsible tree where each node is a row, indented by depth from the entry node. Outcomes appear as branches. Good for **scanning the full structure quickly** without panning.

```
▾ START
  ▾ Check Session [ScriptedDecision]
    ▸ hasSession → Fetch User Info [ScriptedDecision]
    ▾ noSession
      ▾ Login Page [PageNode]
          Platform Username
          Platform Password
        ▸ outcome → MFA Select [InnerTree] →
```

- InnerTree nodes show a "→" link to drill in (navigate to sub-journey)
- Collapsed by default beyond depth 2
- Clicking a node highlights it in the graph view (if open side-by-side)
- Cycle detection: if a node has already appeared in the current path, show it as a back-reference label instead of re-expanding

---

## 2. Path / Flow List View

Shows every possible **end-to-end path** from Start → Success/Failure as a flat numbered list. Each row is one complete flow.

```
Path 1 (→ Success):  Check Session → hasSession → Fetch User → success
Path 2 (→ Success):  Check Session → noSession → Login Page → MFA → TOTP → success
Path 3 (→ Failure):  Check Session → noSession → Login Page → Retry Limit → Reject → failure
```

- Filter by outcome (success-only, failure-only)
- Path count limit to handle combinatorial explosion on complex journeys
- Useful for QA and coverage analysis

---

## 3. Node List / Table View

A flat searchable/filterable table of all nodes with columns: Name, Type, Outcomes, Connected To.

| Name | Type | Outcomes | Connects To |
|---|---|---|---|
| Check Session | ScriptedDecision | hasSession, noSession, byPass | 3 nodes |
| Login Page | PageNode | outcome | MFA Select |
| MFA Select | InnerTree | true, false | 2 journeys |

- Filter by node type
- Sort by name, type, outcome count
- Click row to highlight node in graph view
- Good for auditing ("show me all ScriptedDecisionNodes")

---

## 4. Swimlane / Phase View

Groups nodes into horizontal lanes by their depth/phase in the flow (e.g. Authentication → MFA → Registration → Post-login). Each lane is a column, nodes sit inside their lane.

- Less about implementation detail, more about user experience stages
- Good for business-level presentations and flow reviews

---

## 5. Dependency / Impact View

Inverts the graph: given a selected node, shows **what leads to it** (ancestors) and **what it leads to** (descendants) — like a blame/impact tree.

- Useful for debugging: "if this node fails, what paths are affected?"
- Could be rendered as a mini focused graph or a two-column ancestor/descendant list
