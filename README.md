# vis-a-vis

**Visualise Agent, Visualise!** — a locally running diagram studio: a full Excalidraw
web UI plus an MCP (Model Context Protocol) server on the same port, so an AI agent can
read and edit the exact diagram the user has open on screen. Everything runs on your
machine; your diagrams never leave it.

One live diagram at a time, autosaved to disk with a full file-based version history
(agent edits tagged and labelled), and eight MCP tools that mirror what the UI can do:
inspect the scene, add/move/restyle/delete elements, save, export PNG/SVG, and restore
any version.

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:4832> — a fresh canvas with a random name (e.g.
`clever-otter-4f2a`) is created automatically. If the page says the web assets are not
built, run `npm run build` once and reload (see Troubleshooting).

## Features

- **Single live diagram** — one Excalidraw canvas at all times; the agent and the user
  always look at the same scene.
- **Multi-tab takeover** — only one browser tab is the active editor. Opening a second
  tab shows a takeover warning ("this tab becomes the active editor"); accepting it
  invalidates the old tab (it grays out and becomes unusable), declining leaves the old
  tab untouched and disables the new one. Reloads of the active tab never prompt.
- **Autosave + file-based versioning** — every change is autosaved to
  `data/files/<name>.excalidraw` (debounced). Explicit *Save* / *Save as…* marks the
  diagram saved under a chosen name. Each event snapshots a version under
  `data/versions/<diagramId>/` with a kind (`created`, `opened`, `autosave`, `save`,
  `mcp-edit`, `pre-restore`, `restore`) and a source (`user`, `agent`, `system`).
  Agent-made versions are tagged (`AGENT` badge) with the edit description and tool
  name. Newest 100 versions per diagram are kept.
- **Restore from UI and MCP** — the *Versions* drawer lists history newest-first with a
  *Restore* button per entry; agents use `list_versions` + `restore_version`. Restoring
  first snapshots the current state (`pre-restore`), so a restore is never destructive.
- **Save status + file name** — a floating status chip always shows where you are:
  `⚠ clever-otter-4f2a — not saved`, `architecture · unsaved changes`, or
  `✓ architecture — saved 14:32`.
- **New / Open with unsaved-changes guard** — *New* and *Open…* ask
  "You have unsaved changes — Save / Discard / Cancel" before touching the canvas.
  *Open…* lists known diagrams and accepts `.excalidraw` / `.json` files from disk
  (plain Excalidraw files included).
- **Random initial names** — new diagrams get memorable names like `clever-otter-4f2a`
  until you save them under a name of your choice.
- **Recent menus** — *Recent ▾* shows two groups: **Recently opened** (saved diagrams)
  and **Recently edited (unsaved)** (dirty diagrams, including the ones still living
  under a random name).
- **MCP toasts** — agent activity appears as toasts in the bottom-right corner
  (`Agent: added 2 elements — "…"`), so you always see what the agent is doing.
- **Live MCP edits** — agent changes are applied to the open canvas immediately, with
  the same rendering as user edits.

## MCP interface

- **Endpoint:** `http://localhost:4832/mcp`
- **Transport:** Streamable HTTP, **stateless** (no sessions; a fresh server handles
  each POST; `GET`/`DELETE` on `/mcp` return HTTP 405; permissive CORS for local use).
- **Session model:** the six diagram tools require an open browser tab (an *active
  session*). `get_app_url` and `check_diagram_active` always work; the rest return
  `{"error":{"code":"NO_ACTIVE_SESSION", ...}}` until a tab is open. Agents should call
  `check_diagram_active` first and ask the user to open `get_app_url`'s URL when needed.

### Tools

| Tool | Input | Output | Needs open tab |
| --- | --- | --- | --- |
| `get_app_url` | `{}` | `{appUrl, port, mcpUrl}` | no |
| `check_diagram_active` | `{}` | `{active, appUrl, diagram: {fileName, isSaved, dirty, lastActivity} \| null, message}` | no |
| `get_diagram_content` | `{include?: "all" \| "technical" \| "semantic"}` | `{diagram, technical, semantic}` (`diagram` always; `technical`/`semantic` per `include`) | yes |
| `edit_diagram` | `{description?: string, ops: Op[]}` | `{ok, description, results, createdIds, elementCount, version}` | yes |
| `save_diagram` | `{name?: string}` | `{ok, diagram, version, file}` | yes |
| `export_image` | `{format?: "png" \| "svg", rect?: {x, y, width, height}, scale?: number}` | image block (base64) + JSON meta `{format, width, height, rect, diagramName}` | yes |
| `list_versions` | `{limit?: number}` (default 50, max 200) | `{versions: VersionMeta[]}` newest first | yes |
| `restore_version` | `{versionId: string}` | `{ok, diagram, version, restoredFrom}` | yes |

`edit_diagram` ops are `{"op":"add","elements":[...]}`,
`{"op":"update","id":"...","changes":{...}}`, `{"op":"delete","ids":[...]}` — see
`plugins/vis-a-vis/skills/vis-a-vis/SKILL.md` for full semantics and examples. Error
codes: `NO_ACTIVE_SESSION`, `INVALID_ARGUMENT`, `NOT_FOUND`, `APPLY_FAILED`,
`EXPORT_FAILED`, `NAME_REQUIRED` (plus `NOT_ACTIVE_SESSION` for REST mutations).

### Example: initialize + call a tool

```bash
# JSON-RPC handshake
curl -s -X POST http://localhost:4832/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'

# tools/call check_diagram_active
curl -s -X POST http://localhost:4832/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_diagram_active","arguments":{}}}'
```

Example result (inside the `text` content block):

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

### Registering with AgentInc or any MCP client

Point any MCP client that supports **Streamable HTTP** at the endpoint:

```json
{
  "mcpServers": {
    "vis-a-vis": {
      "type": "streamable-http",
      "url": "http://localhost:4832/mcp"
    }
  }
}
```

In AgentInc, install the plugin below (it registers this server automatically via
`mcp.json`) or add the server manually with the same URL. In other clients, use their
"add MCP server" flow with transport *Streamable HTTP* and the URL above.

## Agent plugin (Agent Plugins 1.0.0)

`plugins/vis-a-vis/` is a conformant Agent Plugins 1.0.0 package:

```
plugins/vis-a-vis/
  plugin.json                 # manifest (schemas/1.0.0/plugin.schema.json)
  mcp.json                    # MCP registration (streamable-http → :4832/mcp)
  skills/vis-a-vis/SKILL.md   # agent skill: tools, session model, edit semantics
  README.md
```

**Install:** copy the `plugins/vis-a-vis` folder into your client's plugins directory
and restart/reload the client. The bundled skill teaches the agent the eight tools, the
check-first session model, `edit_diagram` op semantics with examples, and error
handling.

> Note: `mcp.json` assumes the default port **4832**. If vis-a-vis had to fall back to
> another port (see below), update the `url` in `mcp.json` / your client config.

## Build & packaging

```bash
npm run build      # vite build (web → web/dist), esbuild (server → dist/server.cjs), copy web assets to dist/web
npm run package    # additionally bundles a standalone executable
```

`npm run package` produces **`release/vis-a-vis.exe`** — fully standalone (embedded
Node runtime + web assets). Copy the exe anywhere and run it; it creates its `data/`
directory next to itself.

## Configuration

All configuration is via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VIS_A_VIS_PORT` | *(unset)* | Preferred port. If unset, the app tries **4832**; on `EADDRINUSE` it increments (+1, +2, …) up to **4852**. |
| `VIS_A_VIS_HOST` | `127.0.0.1` | Bind host. The app URL is always `http://localhost:<port>/`. |
| `VIS_A_VIS_DATA_DIR` | `<appRoot>/data` | Data root (see below). `appRoot` = exe directory for the packaged build, else the working directory. |
| `VIS_A_VIS_WEB_DIR` | *(auto)* | Override the web assets directory (otherwise `dist/web`, then `web/dist`). |

The actual port is printed on boot: `vis-a-vis listening on http://localhost:<port>/`.
If 4832 was busy and the app moved to 4833–4852, update MCP clients configured for
4832 — or pin `VIS_A_VIS_PORT`.

## Data layout

Everything lives under `data/` (override with `VIS_A_VIS_DATA_DIR`):

```
data/
  store.json                            # index: current diagram + metadata of all diagrams
  files/<name>.excalidraw               # current state of each diagram (autosaved on every change)
  versions/<diagramId>/<versionId>.json # snapshots: {version: VersionMeta, scene: {...}}
```

`.excalidraw` files are plain JSON and can be re-opened in vis-a-vis (or imported into
excalidraw.com). Save names are restricted to `[a-z0-9._-]`, 1–64 chars. Saving over an
existing name snapshots the overwritten diagram first.

## Troubleshooting

- **`web assets not built — run \`npm run build\``** on `/` — the server could not find
  the web UI. Run `npm run build` (once), or point `VIS_A_VIS_WEB_DIR` at built web
  assets. `npm run dev` serves already-built assets; after a fresh clone run
  `npm run build` first.
- **MCP tools return `NO_ACTIVE_SESSION`** — the diagram tools need an open browser
  tab. Call `get_app_url`, open that URL in a browser, then retry (the app tells you
  this in its error message too).
- **Client connects to the wrong port / connection refused** — vis-a-vis may have
  fallen back from 4832 because it was in use. Check the boot log line and update the
  URL in `mcp.json` / your MCP client, or set `VIS_A_VIS_PORT` to pin a port.
- **A tab is grayed out / "This tab was closed because…"** — that is the multi-tab
  takeover rule: exactly one active editor tab. Use the tab you accepted the takeover
  in (or reload it).
- **"Where did my unsaved diagram go?"** — every change is autosaved to
  `data/files/`; look under *Recent ▾ → Recently edited (unsaved)* to find it again.
- **Undo an edit (mine or the agent's)** — open *Versions* and restore an earlier
  entry (or use `list_versions` + `restore_version`). Restoring snapshots the current
  state first, so you can always restore back.
- **`NAME_REQUIRED`** — `save_diagram` without `name` only works once the diagram has
  been explicitly saved under a name; pass `name` the first time.
- **`export_image` fails (`EXPORT_FAILED`)** — exporting renders the live scene and
  also needs an open tab; retry once the tab is open and the `rect` values are valid
  scene coordinates.
