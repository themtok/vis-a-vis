# vis-a-vis — Internal Contract (binding)

This document defines the exact interfaces between the three implementation slices.
Any deviation breaks integration. If something here is impossible, note it in your
report instead of silently reinterpreting it.

**Product**: "Visualise Agent, Visualise!" (short: *vis-a-vis*) — a locally running
diagram studio (Excalidraw) with an MCP interface so an agent can read/edit the live
diagram the user has open.

## 0. File ownership

| Path | Owner |
| --- | --- |
| `package.json`, `docs/CONTRACT.md`, `build.mjs` | integrator (already exists / will be written) |
| `server/**` | slice "server" |
| `web/**` | slice "web" |
| `plugins/**`, `README.md` | slice "plugin" |

Do NOT edit files outside your ownership. `npm install` has already been run by the
integrator; do not modify `package.json` or `package-lock.json`.

## 1. Runtime & ports

- Node >= 20. Source is ESM (`"type": "module"`), run directly with `node server/index.js`.
- The packaged build bundles `server/index.js` to **CJS** (`dist/server.cjs`) with esbuild.
  Therefore `server/**` MUST NOT use `import.meta.*`, `__dirname`, or `require`.
  (Runtime file resolution rules in §2.1 make this unnecessary.)
- One HTTP server hosts everything on one port:
  - `/` and static files → web app
  - `/ws` → WebSocket (ws library)
  - `/mcp` → MCP Streamable HTTP (`@modelcontextprotocol/sdk`)
  - `/api/*` → REST JSON
- Port selection: `VIS_A_VIS_PORT` env if set; else try **4832**, on `EADDRINUSE`
  increment (+1, +2, ... up to 4852). Host: `VIS_A_VIS_HOST` env, default `127.0.0.1`.
- On boot the server logs `vis-a-vis listening on http://localhost:<port>/`.
- `appUrl` = `http://localhost:<port>/` (always `localhost`, regardless of bind host).

## 2. Data layout

### 2.1 Data root

```
VIS_A_VIS_DATA_DIR env  →  that dir
else                    →  <appRoot>/data
```

where `appRoot` = `path.dirname(process.execPath)` when `process.pkg` is truthy
(pkg packaged binary), else `process.cwd()`.

Create on boot: `<data>/files/`, `<data>/versions/`.

### 2.2 Static web dir resolution (server must implement exactly)

First existing directory wins:

1. `process.env.VIS_A_VIS_WEB_DIR`
2. `path.join(appRoot, "dist", "web")`   (`appRoot` per §2.1)
3. `typeof __dirname !== "undefined" ? path.join(__dirname, "web") : null` (pkg snapshot;
   `dist/server.cjs` + `dist/web/**` are embedded side by side)
4. `path.join(appRoot, "web", "dist")`   (dev: source tree)

If none exists: HTTP 500 on `/` with plain text "web assets not built — run `npm run build`".
Note `typeof __dirname !== "undefined"` is legal in ESM (undeclared identifier) and is
true in the CJS bundle. This is the ONLY allowed mention of `__dirname`.

### 2.3 Files

```
<data>/store.json                                  index (atomic write: tmp + rename)
<data>/files/<name>.excalidraw                     current state of every diagram (autosaved)
<data>/versions/<diagramId>/<versionId>.json       snapshots
```

**Diagram file** (`<name>.excalidraw`):

```jsonc
{
  "type": "vis-a-vis.diagram",
  "version": 1,
  "diagramId": "<id>",
  "name": "quick-brown-fox",
  "isSaved": false,
  "createdAt": "2026-09-28T12:00:00.000Z",
  "updatedAt": "2026-09-28T12:03:00.000Z",
  "scene": { "elements": [ /* ExcalidrawElement[] */ ], "appState": { /* §3.3 */ } }
}
```

Opening MUST also accept plain Excalidraw files: top-level `{ "type": "excalidraw",
"elements": [...], "appState": {...} }` (and bare `{ "elements": [...] }`). On open they
are wrapped into our shape with a fresh `diagramId` and `name` derived from the file name.

**store.json**:

```jsonc
{
  "currentDiagramId": "uuid-or-null",
  "diagrams": { "<id>": { /* DiagramMeta */ } }
}
```

**DiagramMeta** (also used in REST/MCP payloads):

```ts
{
  id: string,
  name: string,             // file name without extension
  isSaved: boolean,         // true = user has explicitly saved under a chosen name
  dirty: boolean,           // true = changed since last explicit save/open
  createdAt: string,        // ISO
  updatedAt: string,        // ISO (any change)
  lastOpenedAt: string,     // ISO
  lastEditedAt: string|null,// ISO
  savedAt: string|null,     // ISO of last explicit save
  elementCount: number,
  file: string              // "files/<name>.excalidraw"
}
```

**Name generation** (new diagrams): `unique-names-generator`, dictionaries
`[adjectives, animals]`, separator `"-"`, length 2, style lowercase, plus a 4-char
base36 suffix appended after the separator (uniqueness): e.g. `clever-otter-4f2a`.
User-chosen save names are trimmed and sanitized to `[a-z0-9._-]`, 1–64 chars, must
not contain path separators or `..`. If the name already belongs to a different
diagram, saving overwrites that file but MUST first snapshot a version of the diagram
being overwritten.

### 2.4 Versions

**VersionMeta**:

```ts
{
  id: string,               // "<millis>-<seq>" per diagram, lexicographically sortable
  diagramId: string,
  createdAt: string,        // ISO
  source: "user" | "agent" | "system",
  kind: "created" | "opened" | "autosave" | "save" | "mcp-edit" | "pre-restore" | "restore",
  label: string,            // human readable; for agent ops: the edit description
  tool: string|null,        // MCP tool name when source === "agent"
  elementCount: number,
  isAgent: boolean          // source === "agent"
}
```

Snapshot file `<data>/versions/<diagramId>/<id>.json`:
`{ "version": VersionMeta, "scene": { "elements": [...], "appState": {...} } }`.

Creation policy (server-side, exactly):

| Event | Version |
| --- | --- |
| diagram created (new) | `created`, source `user` |
| diagram opened (file/other) | `opened`, source `user` |
| first scene change after any version, or >120 s since last version | `autosave`, source `system`, label `"autosave"` |
| user save / save-as | `save`, source `user` |
| MCP `edit_diagram` (one per call) | `mcp-edit`, source `agent`, `tool:"edit_diagram"`, label = the `description` argument or `"edit_diagram: add=2 update=1 delete=0"` |
| MCP `save_diagram` | `save`, source `agent`, `tool:"save_diagram"` |
| any restore | first `pre-restore` (current state, source `user`), then `restore` (restored state, source = who restored) |

Prune to the newest **100** versions per diagram. Autosave of the current state to
`<data>/files/<name>.excalidraw` happens on every scene change (debounced 500 ms) —
autosaving state is NOT "saving" in the user-facing sense (see `isSaved`/`dirty`).

## 3. WebSocket protocol (`/ws`)

One socket per browser tab. All messages are JSON objects with a `type` field.
The tab that holds the **active session** is the only one that may edit.

### 3.1 Client → server

| type | payload | meaning |
| --- | --- | --- |
| `hello` | `{ type:"hello", tabKey:string }` | first message after connect. `tabKey` = `sessionStorage["vis-a-vis-tab-key"]` (a `crypto.randomUUID()` created on first load; survives reload in the same tab) |
| `takeover` | `{ type:"takeover" }` | user accepted the takeover warning |
| `decline` | `{ type:"decline" }` | user declined the takeover warning |
| `scene-update` | `{ type:"scene-update", elements:ExcalidrawElement[], appState:AppStateSubset }` | debounced (~400 ms) after Excalidraw `onChange` |
| `rpc-result` | `{ type:"rpc-result", id:string, ok:boolean, result?:any, error?:string }` | answer to server `rpc` |
| `ping` | `{ type:"ping" }` | heartbeat every 10 s (updates lastActivity) |

### 3.2 Server → client

| type | payload | meaning |
| --- | --- | --- |
| `welcome` | `{ type:"welcome", tabId:string, status:"pending"\|"active"\|"rejected", activeTabExists:boolean, diagram:DiagramMeta\|null, scene:{elements,appState}\|null }` | sent once right after `hello` |
| `session-active` | `{ type:"session-active", diagram, scene }` | this tab is now the active session (also sent on reload of the active tab) |
| `session-invalidated` | `{ type:"session-invalidated", reason:"taken-over"\|"declined" }` | tab must gray out and become unusable |
| `scene-set` | `{ type:"scene-set", elements, appState, origin:"mcp"\|"restore"\|"open"\|"new" }` | replace the canvas content |
| `diagram-switched` | `{ type:"diagram-switched", diagram:DiagramMeta, scene, origin:"open"\|"new"\|"save-as" }` | different diagram is now current |
| `toast` | `{ type:"toast", text:string, kind:"info"\|"success"\|"agent"\|"error", ttlMs:number }` | show small toast, bottom-right |
| `rpc` | `{ type:"rpc", id:string, method:string, params:any }` | server request; client answers with `rpc-result` (timeout 10 s server-side) |

### 3.3 Session state machine

- `hello` where `tabKey` equals the active tab's `tabKey` → this socket replaces the old
  socket for that tab; status stays `active`; no takeover prompt (reload case). The old
  socket is closed by the server.
- Else if a live active tab exists → `welcome { status:"pending", activeTabExists:true }`.
  The client MUST show the takeover modal (§6.3).
- `takeover` → server sends `session-invalidated {reason:"taken-over"}` to every other
  connected tab, then `session-active` to this one.
- `decline` → server sends `session-invalidated {reason:"declined"}` to this tab only and
  marks it `rejected`; the previously active tab is untouched.
- `hello` when no active tab exists → this tab becomes active immediately
  (`welcome {status:"active"}` + `session-active` semantics; scene included).
- Active socket closes → server waits **1500 ms** (reload grace); if the same `tabKey`
  did not reconnect, the active session ends (`activeTabExists:false` from then on).
- `check_diagram_active` (MCP) reflects exactly this: `active` = there is a live active tab.

`AppStateSubset` (the only appState fields persisted/synced):
`{ viewBackgroundColor?, gridSize?, gridStepEnabled?, gridModeEnabled? }`.

### 3.4 Server → client RPC methods

| method | params | result |
| --- | --- | --- |
| `get-scene` | `{}` | `{ elements, appState }` (live scene, authoritative) |
| `apply-ops` | `{ description?:string, ops:Op[] }` | `{ elements, appState, results:OpResult[] }` |
| `export-image` | `{ format:"png"\|"svg", rect?:{x,y,width,height}\|null, scale?:number }` | `{ dataBase64:string, mimeType:string, width:number, height:number }` |

**Op** (see §5 `edit_diagram`, same shape):

```jsonc
{ "op": "add", "elements": [ SkeletonElement, ... ] }
{ "op": "update", "id": "el-id", "changes": { ...partial SkeletonElement fields... } }
{ "op": "delete", "ids": ["el-id", ...] }
```

**OpResult**: `{"op":"add","ids":["..."]}` / `{"op":"update","id":"..."}` / `{"op":"delete","ids":[...]}`.

`apply-ops` MUST be applied through `convertToExcalidrawElements` for `add` (import from
`@excalidraw/excalidraw`) followed by `excalidrawAPI.updateScene({elements, appState, commitToHistory:true})`.
Explicit ids given in a skeleton MUST survive: after conversion, remap generated ids to
the requested ids and rewrite all references (`boundElements[].id`, `containerId`,
`startBinding.elementId`, `endBinding.elementId`, `groupIds` stay untouched).
The result `elements` are the FULL new element list (server persists them verbatim).

**Echo suppression**: after `rpc apply-ops`, the server stores `sha1(JSON.stringify(elements))`
and ignores the next `scene-update` with an identical hash (no version, no dirty flip).
The client MAY send `scene-update` after every `updateScene` including MCP ones.

## 4. REST API

All responses are JSON. Errors: HTTP status + `{"error": {"code", "message"}}`.

**Mutation guard**: every mutating endpoint REQUIRES header `X-Vis-A-Vis-Tab: <tabId>`
(`tabId` from `welcome`) and it MUST equal the active session's tab id, otherwise
HTTP 409 `{"error":{"code":"NOT_ACTIVE_SESSION","message":"..."}}`.

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/status` | — | `{ appUrl, port, activeTab: {tabId,lastActivity}\|null, diagram: DiagramMeta\|null }` |
| `GET /api/diagrams` | — | `{ all: DiagramMeta[], recentOpened: DiagramMeta[], recentUnsaved: DiagramMeta[] }` |
| `POST /api/diagrams/new` | `{}` | `{ diagram, scene }` (also WS `diagram-switched` `origin:"new"` to active tab) |
| `POST /api/diagrams/open` | `{ id }` or `{ path }` or `{ content: string, fileName?: string }` | `{ diagram, scene }` (WS `diagram-switched` `origin:"open"`) |
| `POST /api/diagrams/save` | `{ name?: string }` | `{ diagram, version: VersionMeta }` (WS `diagram-switched` `origin:"save-as"` if name changed) |
| `GET /api/versions` | — | `{ versions: VersionMeta[] }` (current diagram, newest first) |
| `POST /api/versions/:id/restore` | `{}` | `{ diagram, scene, versions: VersionMeta[] }` (WS `scene-set` `origin:"restore"`) |

- `recentOpened`: diagrams with `isSaved === true`, sorted by `lastOpenedAt` desc, max 10.
- `recentUnsaved`: diagrams with `dirty === true`, sorted by `lastEditedAt` desc, max 10.
  (These are the "recently edited files that were not saved and still reside under a
  random name" — plus named diagrams with pending edits.)
- `POST /api/diagrams/open` with `path` reads an absolute filesystem path (user typed it
  in the UI). `content` variant uploads a file the user picked in the browser
  (`FileReader` text) — the server MUST NOT trust `fileName` beyond §2.3 sanitizing.
- `save` without `name`: only valid when `isSaved` already (save under current name);
  otherwise 400 `{"error":{"code":"NAME_REQUIRED"}}`.

## 5. MCP server (`/mcp`)

`@modelcontextprotocol/sdk`: `McpServer` + `StreamableHTTPServerTransport` in
**stateless mode** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`),
a fresh server+transport per POST. GET and DELETE on `/mcp` → HTTP 405.
Permissive CORS on `/mcp` (local single-user app). Server info:
`{ name: "vis-a-vis", version: "1.0.0" }`.

Tools (exact names). Non-session tools work always; the rest REQUIRE an active session
and otherwise return `isError: true` with text content = JSON
`{"error":{"code":"NO_ACTIVE_SESSION","message":"Open the vis-a-vis web UI first (...)"}}`.
Success text content is a single `text` block with pretty-printed JSON.

1. **`get_app_url`** — input `{}` → `{"appUrl":"http://localhost:4832/","port":4832,"mcpUrl":"http://localhost:4832/mcp"}`
2. **`check_diagram_active`** — input `{}` →
   `{"active":bool,"appUrl":string,"diagram":{ "fileName","isSaved","dirty","lastActivity" }|null,"message":string}`
   (`diagram` present only when `active`; `lastActivity` = ISO of last WS activity;
   `message` short human explanation, e.g. `"No tab open"` / `"Tab open: clever-otter-4f2a (not saved)"`.)
3. **`get_diagram_content`** — input `{ include?: "all"|"technical"|"semantic" }` (default `"all"`) →
   `{"diagram":{...},"technical":{...},"semantic":{...}}` (`diagram` is always present;
   `technical`/`semantic` are included per `include`).
   - `technical.elements`: one entry per non-deleted element:
     `{id,type,x,y,width,height,angle,strokeColor,backgroundColor,fillStyle,strokeWidth,strokeStyle,roughness,opacity,text,fontSize,fontFamily,textAlign,verticalAlign,containerId,labelFor,startBinding,endBinding,points,groupIds,frameId,link,locked,boundElementIds}` —
     `null`/absixed fields omitted when not applicable; `startBinding`/`endBinding` are
     `{elementId,focus,gap}`; `points` only for `line`/`arrow`/`freedraw`; `labelFor` =
     id of the shape a bound text belongs to (mirror of `containerId`).
   - `technical.appState`: the AppStateSubset.
   - `semantic`: see §5.1.
4. **`edit_diagram`** — input `{ description?: string, ops: Op[] }` (§3.4 Op shape) →
   `{"ok":true,"description":string,"results":OpResult[],"createdIds":string[],
      "elementCount":number,"version":VersionMeta}`
   Creates exactly one `mcp-edit` version (§2.4) and pushes the change live
   (toast + scene update) via WS RPC `apply-ops`.
5. **`save_diagram`** — input `{ name?: string }` → `{"ok":true,"diagram":DiagramMeta,"version":VersionMeta,"file":string}`
6. **`export_image`** — input `{ format?: "png"|"svg", rect?: {x,y,width,height}, scale?: number }`
   (default `format:"png"`, `scale:1`, whole diagram) → content blocks:
   `[{type:"image", mimeType:"image/png"|"image/svg+xml", data:<base64>}, {type:"text", text:<JSON meta>}]`
   where meta = `{"format","width","height","rect":{...}|null,"diagramName"}`.
   The image MUST be the Excalidraw rendering of the live scene, cropped to `rect`
   when given (rect in scene coordinates).
7. **`list_versions`** — input `{ limit?: number }` (default 50, max 200) →
   `{"versions": VersionMeta[]}` newest first (current diagram).
8. **`restore_version`** — input `{ versionId: string }` →
   `{"ok":true,"diagram":DiagramMeta,"version":VersionMeta,"restoredFrom":string}`.
   Live push via WS `scene-set origin:"restore"`. Unknown id → `isError` with
   `{"error":{"code":"NOT_FOUND",...}}`.

Other error codes: `INVALID_ARGUMENT`, `APPLY_FAILED`, `EXPORT_FAILED`, `NAME_REQUIRED`.

### 5.1 Semantic description shape

```jsonc
{
  "summary": "one paragraph: what the diagram is, main flow, notable texts",
  "components": [
    {
      "id": "...",                       // element id of the shape (or text)
      "kind": "process|decision|terminal|container|note|text|connector|sketch|image|other",
      "label": "Server",                 // bound/standalone text, "" if none
      "where": "left|center|right|top|bottom",   // relative position in layout
      "position": {"x":0,"y":0},
      "size": {"width":120,"height":60},
      "connectedTo": [ {"id":"...","via":"arrow|line","label":"sends"} ]
    }
  ],
  "flows": [ ["idA","idB","idC"] ],      // chains of connector-bound components, labels in order
  "texts": [ {"id":"...","text":"...","x":0,"y":0} ],
  "stats": {"shapes":3,"connectors":2,"texts":1,"images":0}
}
```

Classification: `diamond`→decision, `ellipse`/rounded `rectangle`→terminal,
`rectangle`→process, `frame`→container, `text`/bound label→text/note,
`arrow`/`line`→connector, `freedraw`→sketch, `image`→image. Empty label + plain
rectangle → `process` with `label:""`. `flows` follow arrow bindings transitively
(start→end), stopping at branches/merges; include component labels in `summary`.
`where` is computed from element center vs. scene bounds thirds.

## 6. Web UI requirements (`web/**`)

Single diagram in the Excalidraw canvas at all times. Standard Excalidraw UI plus:

1. **Status bar chip** (floating top-right, non-blocking):
   - `!isSaved`: `⚠ <name> — not saved` (and `· unsaved changes` if `dirty`)
   - `isSaved && dirty`: `<name> · unsaved changes`
   - `isSaved && !dirty`: `✓ <name> — saved <HH:MM>`
2. **Menu buttons** (same cluster or a small "vis-a-vis" menu): `New`, `Open…`,
   `Save`, `Save as…`, `Versions`, `Recent ▾` (two labeled groups: *Recently opened*,
   *Recently edited (unsaved)* — the latter shows temp/random names).
3. **Open dialog**: list of known diagrams (name, saved badge, last opened/edited),
   plus `<input type="file">` to open a `.excalidraw`/`.json` file from disk
   (read in browser, POST `/api/diagrams/open` with `content`).
4. **Save-as dialog**: name input + validation message; warns when overwriting an
   existing name.
5. **Unsaved-changes dialog** before `New` / `Open`: "You have unsaved changes —
   Save / Discard / Cancel".
6. **Versions drawer** (right side panel): newest first; each entry shows time,
   kind badge, `source` badge — **agent entries highlighted** (e.g. violet "AGENT"
   badge + left border) with their `label`, element count, and a `Restore` button.
7. **Toasts**: bottom-right stack (max 4, auto-dismiss 5 s; agent toasts 8 s).
   Toasts for MCP activity come from WS `toast` (e.g. `Agent: added 2 elements — "…"`).
8. **Takeover modal** (when `welcome.status==="pending"`): "Opening this tab will make
   the previous tab (session) invalid and this tab becomes the active editor." with
   `Continue` and `Cancel` buttons → WS `takeover` / `decline`.
9. **Grayed-out overlay** on `session-invalidated` or `decline`: full-window gray
   overlay (`rgba(235,235,235,0.92)`), centered message:
   - taken-over: "This tab was closed because the diagram is now edited in another tab."
   - declined: "This tab is inactive — the diagram is being edited in another tab."
   Pointer events blocked; app unusable. No recovery path needed.
10. Reconnection: on WS close (unexpected), reconnect with backoff (1 s, 2 s, 4 s, max
    10 s) reusing the same `tabKey`; re-render state from `welcome`.
11. `document.title` = `<name> — vis-a-vis`.

Client-side requirements for Excalidraw: import `@excalidraw/excalidraw` and its CSS
(`@excalidraw/excalidraw/index.css`), React 18 `createRoot`, `initialData` from the
`welcome`/`session-active` scene, `onChange` → debounced `scene-update`, `excalidrawAPI`
captured via the `excalidrawAPI` prop for `updateScene`. `name` prop = diagram name.

## 7. Build (`build.mjs`, written by integrator)

- `npm run build` → `npx vite build web` (output `web/dist`), esbuild
  `server/index.js → dist/server.cjs` (platform node, format cjs, bundle), copy
  `web/dist` → `dist/web`.
- `npm run package` (`node build.mjs --standalone`) → additionally runs
  `@yao-pkg/pkg` on `dist/server.cjs` with `--assets "dist/web/**/*"`, target
  `node20-win-x64` on Windows, output `release/vis-a-vis.exe`. The exe is standalone
  (embedded Node runtime + web assets); it creates `data/` next to itself.
- Vite config MUST set `base: "./"` and output to `web/dist`.

## 8. Plugin (`plugins/vis-a-vis/`) — Agent Plugins spec 1.0.0

Layout:

```
plugins/vis-a-vis/
  plugin.json     # $schema https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
  mcp.json        # $schema https://agent-plugins.org/schemas/1.0.0/mcp.schema.json
  skills/vis-a-vis/SKILL.md
  README.md
```

- `plugin.json` name `vis-a-vis` (valid: lowercase a-z, digits, `-`, `.`), version
  `1.0.0`, description, author, license MIT, keywords; `extensions` MAY carry
  `"com.agentinc"` metadata. Schema-closed: ONLY `$schema, name, version, description,
  author, homepage, repository, license, keywords, extensions`.
- `mcp.json`: `{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers":{"vis-a-vis":{"type":"streamable-http","url":"http://localhost:4832/mcp"}}}`
  (default port assumed; note the fallback-port caveat in the plugin README).
- `skills/vis-a-vis/SKILL.md` per Agent Skills spec (frontmatter `name`, `description`)
  teaching an agent the 8 tools, the session model ("check first"), and typical flows.
