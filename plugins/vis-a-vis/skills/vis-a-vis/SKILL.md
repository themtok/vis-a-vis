---
name: vis-a-vis
description: "Teaches an agent to use the vis-a-vis local diagram studio over its MCP interface — inspect the live Excalidraw diagram the user has open, add and edit shapes, arrows and labels, save, export PNG/SVG, and manage version history. Use whenever the user wants to create, read, modify, explain, or export a diagram in vis-a-vis. Covers the eight MCP tools, the check-first session model, edit_diagram op semantics, and error codes."
---

# vis-a-vis — edit the user's live diagram over MCP

vis-a-vis ("Visualise Agent, Visualise!") is a local diagram studio: a full Excalidraw
canvas in the user's browser plus an MCP server (Streamable HTTP, stateless) at
`http://localhost:4832/mcp`. Everything you do through these tools happens on the
**live canvas the user has open** — your edits appear on their screen immediately.

Tool results are a single `text` content block containing pretty-printed JSON — parse
it. (`export_image` returns an `image` block plus a `text` meta block.) Errors come
back with `isError: true` and a text block of `{"error":{"code","message"}}`.

## Session model — check first (mandatory)

Six of the eight tools (`get_diagram_content`, `edit_diagram`, `save_diagram`,
`export_image`, `list_versions`, `restore_version`) **require an open vis-a-vis browser
tab** (an *active session*). `get_app_url` and `check_diagram_active` work always.

Always follow this flow before touching a diagram:

1. Call `check_diagram_active`.
2. `"active": true` → proceed with your work.
3. `"active": false` → call `get_app_url`, tell the user to open the `appUrl` in their
   browser, and wait until they confirm. Then call `check_diagram_active` again and
   continue.
4. If a diagram tool returns `NO_ACTIVE_SESSION`, go back to step 3 — never retry it
   blindly.

Notes:

- There is exactly **one active editor tab** (multi-tab takeover). If the user reports
  a grayed-out tab ("This tab was closed because the diagram is now edited in another
  tab"), that tab is disabled by design — work happens in the tab where they accepted
  the takeover.
- `check_diagram_active` is also cheap insurance before long edit sequences: it
  reports `fileName`, `isSaved`, `dirty`, and `lastActivity` of the open diagram.

## The eight tools

### 1. `get_app_url`

Input: `{}` (no arguments).

```json
{ "appUrl": "http://localhost:4832/", "port": 4832, "mcpUrl": "http://localhost:4832/mcp" }
```

Use `appUrl` when instructing the user to open the UI. If the configured port was busy
at startup the app may be on another port (4832–4852) — this tool always tells the
truth.

### 2. `check_diagram_active`

Input: `{}`.

```json
{
  "active": true,
  "appUrl": "http://localhost:4832/",
  "diagram": {
    "fileName": "clever-otter-4f2a",
    "isSaved": false,
    "dirty": true,
    "lastActivity": "2026-09-28T12:03:00.000Z"
  },
  "message": "Tab open: clever-otter-4f2a (not saved)"
}
```

`diagram` is present only when `active` is true (`null` otherwise). `fileName` is the
current diagram's name; `isSaved` = explicitly saved under a chosen name; `dirty` =
changed since the last explicit save; `lastActivity` is an ISO timestamp of the last
tab activity. `message` is a short human explanation (e.g. `"No tab open"`).

### 3. `get_diagram_content`

Input: `{ "include": "all" | "technical" | "semantic" }` — default `"all"`. The
`diagram` metadata is always present; `technical` and `semantic` sections follow
`include` (both for `"all"`, one for the specific value).

```json
{ "diagram": { "...": "DiagramMeta" }, "technical": { "...": "..." }, "semantic": { "...": "..." } }
```

- `diagram` — metadata of the current diagram:
  `{"id","name","isSaved","dirty","createdAt","updatedAt","lastOpenedAt","lastEditedAt","savedAt","elementCount","file"}`
  (timestamps ISO, `file` like `"files/clever-otter-4f2a.excalidraw"`).
- `technical.elements` — one entry per non-deleted element:
  `{"id","type","x","y","width","height","angle","strokeColor","backgroundColor","fillStyle","strokeWidth","strokeStyle","roughness","opacity","text","fontSize","fontFamily","textAlign","verticalAlign","containerId","labelFor","startBinding","endBinding","points","groupIds","frameId","link","locked","boundElementIds"}`.
  Inapplicable or `null` fields are omitted. `startBinding`/`endBinding` are
  `{"elementId","focus","gap"}`. `points` appears only for `line`/`arrow`/`freedraw`.
  `labelFor` on a bound text element is the id of the shape it labels (the mirror of
  that text's `containerId`).
- `technical.appState` — `{"viewBackgroundColor","gridSize","gridStepEnabled","gridModeEnabled"}`.
- `semantic` — human-oriented digest (see "Semantic output" below).

### 4. `edit_diagram`

Input: `{ "description": "short human description", "ops": [Op, ...] }`.
(`description` is optional but strongly recommended — it is shown to the user in the
Versions drawer and the toast. Without it the version is labelled
`"edit_diagram: add=2 update=1 delete=0"`.)

```json
{
  "ok": true,
  "description": "Add a Server box",
  "results": [ { "op": "add", "ids": ["box-server"] } ],
  "createdIds": ["box-server"],
  "elementCount": 4,
  "version": { "id": "1759060980123-3", "kind": "mcp-edit", "source": "agent", "isAgent": true }
}
```

Each call produces exactly **one** version (`kind: "mcp-edit"`, `source: "agent"`,
`tool: "edit_diagram"`, `label` = your `description`) and pushes the change live: the
open tab updates immediately and shows a toast. One `OpResult` per op.

**Op shapes** (ops run in the order given):

```jsonc
{ "op": "add",    "elements": [SkeletonElement, ...] }   // → { "op":"add", "ids":[...] }
{ "op": "update", "id": "el-id", "changes": { ... } }    // → { "op":"update", "id":"el-id" }
{ "op": "delete", "ids": ["el-id", ...] }                // → { "op":"delete", "ids":[...] }
```

**SkeletonElement** (for `add`; `update.changes` accepts the same fields partially):

- Common geometry/style: `type` (`"rectangle"`, `"ellipse"`, `"diamond"`, `"arrow"`,
  `"line"`, `"text"`, `"freedraw"`, `"image"`, `"frame"`), `x`, `y`, `width`, `height`,
  `angle`, `strokeColor`, `backgroundColor`, `fillStyle` (`"solid"`, `"hachure"`,
  `"cross-hatch"`), `strokeWidth`, `strokeStyle`, `roughness`, `opacity`, `groupIds`,
  `roundness`, `link`, `locked`, `frameId`, `startArrowhead`, `endArrowhead`,
  `points` (for `line`/`freedraw`).
- `id` — optional but **give one when later ops must reference the element** (arrow
  endpoints, follow-up updates): explicit ids survive.
- Shape **label**: `label: { "text": "Server" }` (optional label extras: `fontSize`,
  `fontFamily`, `textAlign`, `verticalAlign`). In `update.changes` the string
  shorthand `label: "New text"` is also accepted. Both create the bound text if
  missing or rewrite the existing one.
- Standalone **text**: `{"type": "text", "text": "hello", "x": 0, "y": 0, "fontSize": 16}`.
- **Arrow connection**: `start: { "id": "target-id" }`, `end: { "id": "target-id" }`
  (`null`/omitted = unbound endpoint placed at `x`,`y`/points). The full-element style
  `startBinding`/`endBinding`: `{"elementId": "...", "focus": 0, "gap": 0}` is equally
  accepted (`start`/`end` win if both are given).
- `delete` removes bound labels together with their shape; arrow bindings to deleted
  shapes detach.
- An op referencing a missing `id` fails the whole call with `APPLY_FAILED` — re-read
  the content and fix ids before retrying.

### 5. `save_diagram`

Input: `{ "name": "architecture" }` (`name` optional).

```json
{
  "ok": true,
  "diagram": { "id": "…", "name": "architecture", "isSaved": true, "dirty": false },
  "version": { "id": "1759060980123-4", "kind": "save", "source": "agent", "tool": "save_diagram" },
  "file": "files/architecture.excalidraw"
}
```

- Without `name`: saves under the current name — only valid once the diagram has been
  explicitly saved once; otherwise `NAME_REQUIRED`.
- `name` is trimmed and restricted to `[a-z0-9._-]`, 1–64 chars (no path separators,
  no `..`). Saving over an existing diagram's name overwrites its file but snapshots
  the overwritten diagram first.
- This is the user-facing "saved" state (status chip `✓ name — saved HH:MM`). Autosaves
  are invisible background snapshots and do not count.

### 6. `export_image`

Input: `{ "format": "png" | "svg", "rect": { "x": 0, "y": 0, "width": 400, "height": 300 }, "scale": 2 }`
— defaults: `"png"`, `scale: 1`, whole diagram (`rect` omitted/`null`).

Returns content blocks:

```jsonc
[
  { "type": "image", "mimeType": "image/png", "data": "<base64>" },
  { "type": "text",  "text": "{\"format\":\"png\",\"width\":400,\"height\":300,\"rect\":{\"x\":0,\"y\":0,\"width\":400,\"height\":300},\"diagramName\":\"architecture\"}" }
]
```

The image is the Excalidraw rendering of the live scene. **`rect` is in scene
coordinates** — the same coordinate space as element `x`/`y` in `get_diagram_content`
(canvas scene units, not screen pixels) — and crops the rendering to that region.
Typical use: read element bounds from `get_diagram_content`, take their union with a
small margin, pass it as `rect` to export just one subsystem.

### 7. `list_versions`

Input: `{ "limit": 50 }` — default 50, max 200.

```json
{ "versions": [ { "id": "1759060980123-3", "diagramId": "…", "createdAt": "2026-09-28T12:03:00.000Z", "source": "agent", "kind": "mcp-edit", "label": "Add a Server box", "tool": "edit_diagram", "elementCount": 4, "isAgent": true } ] }
```

Versions of the **current diagram**, newest first. `id` (`"<millis>-<seq>"`) is
lexicographically sortable. `source`: `"user"` | `"agent"` | `"system"`; `kind`:
`"created"` | `"opened"` | `"autosave"` | `"save"` | `"mcp-edit"` | `"pre-restore"` |
`"restore"`; `isAgent` is true exactly for agent-made versions (`tool` names the MCP
tool, `label` the description passed). Newest 100 versions per diagram are kept.

### 8. `restore_version`

Input: `{ "versionId": "1759060980123-3" }`.

```json
{ "ok": true, "diagram": { "...": "DiagramMeta" }, "version": { "...": "VersionMeta" }, "restoredFrom": "1759060980123-3" }
```

Restores that snapshot to the live canvas (pushed to the open tab immediately). Safe
by construction: the current state is snapshotted first as `kind: "pre-restore"`, then
the restored state is added as `kind: "restore"` — history is never lost and you can
always restore back. Unknown id → `NOT_FOUND` (`list_versions` first).

## Reading ids for follow-up edits

1. Call `get_diagram_content` with `"include": "technical"` (or `"all"`).
2. Every entry in `technical.elements` has the `id` you need for `update`/`delete`,
   and for arrow `start`/`end` references.
3. Elements you add yourself: give explicit `id`s in the skeleton when later ops (same
   or later call) must reference them; otherwise collect the generated ids from
   `createdIds` (and `results`).
4. **Labels are bound text elements.** A shape's label lives in a hidden text element:
   the text's `containerId` is the shape's id, and the text's `labelFor` is the same
   shape id. To relabel, prefer `update` on the **shape** with
   `{"label": {"text": "New"}}`; to change text metrics (`fontSize`, `textAlign`, …),
   `update` the bound text element by its own id with `{"text": "New"}` also works.
5. Connectors: an arrow's `startBinding`/`endBinding` say what it connects; a shape's
   `boundElementIds` lists attached labels/connectors. Shared `groupIds` = grouped.
6. After destructive edits (`delete`, big `update`s), re-read content if you need
   accurate geometry for exports or further edits.

## Semantic output

`"include": "semantic"` returns a digest for understanding and answering questions
about the diagram (no ids of hidden helper elements, no style noise):

```jsonc
{
  "summary": "one paragraph: what the diagram is, main flow, notable texts",
  "components": [
    {
      "id": "box-server",
      "kind": "process",
      "label": "Server",
      "where": "left",
      "position": { "x": 120, "y": 80 },
      "size": { "width": 160, "height": 80 },
      "connectedTo": [ { "id": "box-db", "via": "arrow", "label": "queries" } ]
    }
  ],
  "flows": [ ["box-server", "box-db"] ],
  "texts": [ { "id": "text-1", "text": "notes", "x": 0, "y": 0 } ],
  "stats": { "shapes": 3, "connectors": 2, "texts": 1, "images": 0 }
}
```

- `summary` — what the diagram is, the main flow, notable texts. Usually enough to
  answer "what does the diagram show?".
- `components[].kind` classification: `diamond` → `decision`; `ellipse`/rounded
  `rectangle` → `terminal`; `rectangle` → `process`; `frame` → `container`;
  `text`/bound label → `text`/`note`; `arrow`/`line` → `connector`; `freedraw` →
  `sketch`; `image` → `image`. An empty-label plain rectangle is a `process` with
  `label: ""`.
- `where` — `left|center|right|top|bottom` of the element center within the scene
  bounds (thirds).
- `flows` — chains of connector-bound components followed transitively along arrows
  (start → end), stopping at branches/merges.
- `texts` — visible texts with positions; `stats` — shape/connector/text/image counts.

Pick `include` by task: `"semantic"` to understand or explain, `"technical"` right
before editing (exact ids, geometry, colors), `"all"` when doing both.

## edit_diagram recipes (concrete examples)

**Add a labeled rectangle:**

```json
{
  "description": "Add a Server box",
  "ops": [
    {
      "op": "add",
      "elements": [
        {
          "id": "box-server",
          "type": "rectangle",
          "x": 120,
          "y": 80,
          "width": 160,
          "height": 80,
          "strokeColor": "#1e1e1e",
          "backgroundColor": "#d3f9d8",
          "fillStyle": "solid",
          "label": { "text": "Server", "fontSize": 20, "textAlign": "center" }
        }
      ]
    }
  ]
}
```

**Connect two ids with an arrow** (here `box-server` and `box-db` already exist — find
their ids via `get_diagram_content` or because you created them with explicit ids):

```json
{
  "description": "Connect Server to Database",
  "ops": [
    {
      "op": "add",
      "elements": [
        {
          "id": "arrow-1",
          "type": "arrow",
          "x": 280,
          "y": 120,
          "strokeColor": "#1e1e1e",
          "endArrowhead": "arrow",
          "start": { "id": "box-server" },
          "end": { "id": "box-db" },
          "label": { "text": "queries" }
        }
      ]
    }
  ]
}
```

(Endpoint spellings: `start`/`end` take `{"id": "..."}`; the full-element style
`startBinding`/`endBinding` take `{"elementId": "...", "focus": 0, "gap": 0}` and are
equally accepted — `start`/`end` win if both are given. Omit an endpoint to leave it
free at the arrow's `x`/`y`.)

**Update position, label, and color:**

```json
{
  "description": "Move and restyle the Server box",
  "ops": [
    {
      "op": "update",
      "id": "box-server",
      "changes": {
        "x": 320,
        "y": 60,
        "backgroundColor": "#ffd8a8",
        "strokeColor": "#e8590c",
        "label": { "text": "API Server" }
      }
    }
  ]
}
```

(`"label": "API Server"` string shorthand is equally fine.)

**Delete elements:**

```json
{
  "description": "Remove the draft arrow",
  "ops": [ { "op": "delete", "ids": ["arrow-1"] } ]
}
```

Several ops can be combined in one call (one version, one toast) — e.g. add two boxes
and the arrow between them in single `edit_diagram`, using explicit ids on all three.

## Versioning & restore

- Every event snapshots a version: `created`/`opened` on new/open, `autosave`
  (source `"system"`) on the first change after a snapshot or after 120 s, `save` on
  explicit saves, `mcp-edit` per `edit_diagram` call, and `pre-restore` + `restore`
  around every restore. Agent versions carry `isAgent: true`, `tool`, and your
  `description` as `label`.
- To undo your own edit: `list_versions` → pick the version just **before** the unwanted
  change → `restore_version`. Restoring adds new versions rather than deleting history.
- To answer "what did the agent change?": `list_versions` and read the `mcp-edit`
  entries (labels are the edit descriptions).
- The user can do all of this from the UI too (Versions drawer, *Restore* button).
  Coordinate: before a large visual change, it is fine to say what you are about to do —
  the user sees each edit live as a toast.

## Error codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `NO_ACTIVE_SESSION` | A diagram tool was called with no open vis-a-vis tab | `get_app_url`, ask the user to open it, re-run `check_diagram_active`, then retry |
| `INVALID_ARGUMENT` | Bad input (unknown `include`/`format`, malformed op, `limit` out of range, bad `name`, …) | Fix the arguments per this document and retry |
| `NOT_FOUND` | Unknown `versionId` (or diagram id) | `list_versions` and pick an existing id |
| `APPLY_FAILED` | Ops could not be applied (e.g. referencing a missing element id) | Re-read `get_diagram_content`, fix ids/fields, retry with a fresh `edit_diagram` |
| `EXPORT_FAILED` | Rendering the image failed | Retry; validate `rect`/`scale` (scene coordinates) |
| `NAME_REQUIRED` | `save_diagram` without `name` on a never-explicitly-saved diagram | Pass `name` |

Error payloads are `{"error":{"code","message"}}` inside the tool result text — parse
the `code` and follow the table instead of retrying unchanged.

## Typical flows

1. **"Draw a flowchart of X"** — `check_diagram_active` → build the scene with one or
   more `edit_diagram` calls (explicit ids for anything you connect) → optionally
   `save_diagram` (ask the user for a name, or leave the random name — everything is
   autosaved either way).
2. **"What does my diagram show?"** — `check_diagram_active` → `get_diagram_content`
   `{"include":"semantic"}` → answer from `summary`/`flows`/`components`.
3. **"Move the Server box left / rename it"** — `get_diagram_content`
   `{"include":"technical"}` → find the id → `edit_diagram` with an `update` op.
4. **"Export a picture"** — `export_image` (whole scene or `rect` around the relevant
   part computed from element bounds).
5. **"Roll back the last change"** — `list_versions` → `restore_version` (the current
   state is snapshotted first, so this is never destructive).
