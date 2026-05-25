# Journey Push: How Dependencies Work

This documents how `fr-config-manager` (specifically `fr-config-push`) handles journey pushes, based on a review of the [source code](https://github.com/ForgeRock/fr-config-manager/tree/main).

---

## CLI Options

The `journeys` push command accepts:

| Flag | Description |
|---|---|
| `--name` / `-n` | Push a specific journey by name |
| `--realm` / `-r` | Target a specific realm |
| `--push-dependencies` / `-d` | Push scripts and inner journeys referenced by the journey |
| `--check` / `-c` | Check if changed before pushing |

---

## What Gets Pushed

The `--push-dependencies` (`-d`) flag controls two internal booleans:

```javascript
const pushInnerJourneys = !journeyName || argv[OPTION.PUSH_DEPENDENCIES];
const pushScripts = argv[OPTION.PUSH_DEPENDENCIES];
```

### Named journey (`--name X`)

| Component | Without `-d` | With `-d` |
|---|:---:|:---:|
| Journey tree JSON | Yes | Yes |
| Direct nodes (under `nodes/`) | **Yes, always** | Yes |
| Inner journeys (recursive) | No | Yes |
| Referenced scripts | No | Yes |

### All journeys (no `--name`)

| Component | Without `-d` | With `-d` |
|---|:---:|:---:|
| Journey tree JSON | Yes | Yes |
| Direct nodes | Yes | Yes |
| Inner journeys | **Yes, always** | Yes |
| Referenced scripts | No | Yes |

**Key point:** Nodes are always pushed — they are part of the journey itself, not considered "dependencies." The `-d` flag only controls **scripts** and **inner journeys**.

---

## Push Order

Pushes are bottom-up (dependencies first):

1. **Paged nodes** — nodes in subdirectories (`nodes/*/*.json`)
2. **Regular nodes** — direct node files (`nodes/*.json`)
3. For each node:
   - If it's an `InnerTreeEvaluatorNode` and `-d` is set → recursively push that inner journey first
   - If it references a script and `-d` is set → push the script first
4. **Journey tree definition** — the journey JSON itself

A `journeysProcessed` array prevents circular or duplicate processing of inner journeys.

---

## API Calls

All calls use HTTP PUT:

| Resource | URL Pattern | API Version Header |
|---|---|---|
| Node | `PUT /am/json/realms/root/realms/{realm}/realm-config/authentication/authenticationtrees/nodes/{nodeType}/{nodeId}` | `protocol=2.1,resource=1.0` |
| Journey tree | `PUT /am/json/realms/root/realms/{realm}/realm-config/authentication/authenticationtrees/trees/{journeyId}` | `protocol=2.1,resource=1.0` |
| Script | `PUT /am/json/realms/root/realms/{realm}/scripts/{scriptId}` | `protocol=2.0,resource=1.0` |

---

## File Structure

```
realms/{realm}/journeys/
  {journeyName}/
    {journeyName}.json            # Journey tree definition
    nodes/
      {nodeId}.json               # Regular nodes
      {pagedNodeId}/              # Paged nodes (subdirectories)
        {subNodeId}.json

realms/{realm}/scripts/
  scripts-config/
    {scriptId}.json               # Script metadata
  scripts-content/
    {language}/{scriptName}.js    # Actual script source (base64-encoded on push)
```

---

## Implications for Dry Run Comparison

When comparing source vs target for a selected journey:

- **`includeDeps = false`**: Compare the journey JSON + its node files. Exclude scripts and inner journey files.
- **`includeDeps = true`**: Compare the journey JSON + its node files + referenced scripts + inner journeys (recursively).

Node files (`journeys/{name}/nodes/*.json`) are **always** part of the comparison because they are always pushed — they are not dependencies.
