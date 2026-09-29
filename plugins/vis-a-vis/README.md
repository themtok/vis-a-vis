# vis-a-vis plugin (Agent Plugins 1.0.0)

Agent Plugins package for **vis-a-vis** ("Visualise Agent, Visualise!") — the local
Excalidraw diagram studio with an MCP interface.

## Contents

| File | Purpose |
| --- | --- |
| `plugin.json` | Plugin manifest (Agent Plugins 1.0.0, `plugin.schema.json`) |
| `mcp.json` | Registers the `vis-a-vis` MCP server (Streamable HTTP) |
| `skills/vis-a-vis/SKILL.md` | Agent skill: the 8 tools, session model, `edit_diagram` semantics, errors |

## Install

Copy this `vis-a-vis` folder into your client's plugins directory and restart/reload
the client. It registers the MCP server `vis-a-vis` at `http://localhost:4832/mcp` and
installs the `vis-a-vis` skill for the agent.

The vis-a-vis app itself must be running locally (`npm run dev`, or `release/vis-a-vis.exe`).

## Port caveat

`mcp.json` assumes the **default port 4832**. If that port is taken at startup,
vis-a-vis falls back to the next free port (up to 4852) — see the boot log
(`vis-a-vis listening on http://localhost:<port>/`) or call `get_app_url`. In that case
update the `url` in `mcp.json` (or your client's server config) accordingly, or pin a
port with the `VIS_A_VIS_PORT` environment variable.
