// MCP Streamable HTTP endpoint (contract §5) at /mcp.
// Stateless mode: a fresh McpServer + StreamableHTTPServerTransport per POST.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { analyzeSemantic, projectTechnical, countElements } from "./semantics.js";

const SERVER_INFO = { name: "vis-a-vis", version: "1.0.0" };

const okText = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});

const errText = (code, message) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }, null, 2) }],
});

// Op shape of contract §3.4 (also used by WS rpc apply-ops).
const opSchema = z.union([
  z.object({ op: z.literal("add"), elements: z.array(z.record(z.any())) }),
  z.object({ op: z.literal("update"), id: z.string(), changes: z.record(z.any()) }),
  z.object({ op: z.literal("delete"), ids: z.array(z.string()) }),
]);

export function createMcpRouter({ store, sessions, ctx }) {
  const noActiveSession = () =>
    errText(
      "NO_ACTIVE_SESSION",
      `Open the vis-a-vis web UI first (${ctx.appUrl}) and keep the tab open — no tab currently holds the editing session.`
    );

  async function liveScene() {
    try {
      const scene = await sessions.getScene();
      if (scene && Array.isArray(scene.elements)) return scene;
    } catch {
      /* fall back to the last persisted scene */
    }
    return store.currentScene();
  }

  function registerTools(server) {
    // 1. get_app_url — always available.
    server.registerTool(
      "get_app_url",
      {
        description:
          "Return the URL and port of the vis-a-vis web UI and this MCP endpoint. Always available, no open tab required.",
      },
      async () =>
        okText({
          appUrl: ctx.appUrl,
          port: ctx.port,
          mcpUrl: `${ctx.appUrl}mcp`,
        })
    );

    // 2. check_diagram_active — always available; the session check an agent should run first.
    server.registerTool(
      "check_diagram_active",
      {
        description:
          "Check whether a vis-a-vis browser tab currently holds the active editing session. Call this before any diagram tool. Returns {active, appUrl, diagram, message}.",
      },
      async () => {
        const session = sessions.sessionInfo();
        const meta = store.currentMeta();
        if (!session) {
          return okText({ active: false, appUrl: ctx.appUrl, diagram: null, message: "No tab open" });
        }
        if (!meta) {
          return okText({ active: true, appUrl: ctx.appUrl, diagram: null, message: "Tab open (no diagram)" });
        }
        const state = meta.isSaved ? (meta.dirty ? "unsaved changes" : "saved") : "not saved";
        return okText({
          active: true,
          appUrl: ctx.appUrl,
          diagram: {
            fileName: meta.name,
            isSaved: meta.isSaved,
            dirty: meta.dirty,
            lastActivity: session.lastActivity,
          },
          message: `Tab open: ${meta.name} (${state})`,
        });
      }
    );

    // 3. get_diagram_content
    server.registerTool(
      "get_diagram_content",
      {
        description:
          'Read the current diagram. The response always includes `diagram` (metadata); include="all" (default) adds both `technical` (element projection) and `semantic` (components, flows, texts, stats, summary); "technical" or "semantic" add only that section.',
        inputSchema: {
          include: z.enum(["all", "technical", "semantic"]).optional(),
        },
      },
      async ({ include }) => {
        if (!sessions.sessionInfo()) return noActiveSession();
        const scene = (await liveScene()) ?? { elements: [], appState: {} };
        const which = include ?? "all";
        const out = { diagram: store.currentMeta() };
        if (which === "all" || which === "technical") out.technical = projectTechnical(scene);
        if (which === "all" || which === "semantic") out.semantic = analyzeSemantic(scene);
        return okText(out);
      }
    );

    // 4. edit_diagram
    server.registerTool(
      "edit_diagram",
      {
        description:
          'Apply edits to the live diagram through the open tab. ops: [{op:"add", elements:[SkeletonElement]}, {op:"update", id, changes:{...partial fields}}, {op:"delete", ids:[id]}]. Skeleton elements use Excalidraw field names (type, x, y, width, height, strokeColor, backgroundColor, text, ...); explicit ids survive. Records one "mcp-edit" version and pushes the change live.',
        inputSchema: {
          description: z.string().optional(),
          ops: z.array(opSchema),
        },
      },
      async ({ description, ops }) => {
        if (!sessions.sessionInfo()) return noActiveSession();
        let add = 0;
        let update = 0;
        let del = 0;
        for (const op of ops) {
          if (op.op === "add") add += op.elements.length;
          else if (op.op === "update") update += 1;
          else del += op.ids.length;
        }
        const label =
          typeof description === "string" && description.trim()
            ? description.trim()
            : `edit_diagram: add=${add} update=${update} delete=${del}`;
        let result;
        try {
          result = await sessions.applyOps({
            description: typeof description === "string" ? description : undefined,
            ops,
          });
        } catch (error) {
          return errText("APPLY_FAILED", `apply-ops failed: ${error.message}`);
        }
        if (!result || !Array.isArray(result.elements) || !Array.isArray(result.results)) {
          return errText("APPLY_FAILED", "apply-ops returned an unexpected result");
        }
        const version = store.recordAgentEdit(result.elements, result.appState, {
          label,
          tool: "edit_diagram",
        });
        const createdIds = result.results
          .filter((r) => r && r.op === "add")
          .flatMap((r) => (Array.isArray(r.ids) ? r.ids : []));
        const parts = [];
        if (add) parts.push(`added ${add} element${add === 1 ? "" : "s"}`);
        if (update) parts.push(`updated ${update} element${update === 1 ? "" : "s"}`);
        if (del) parts.push(`deleted ${del} element${del === 1 ? "" : "s"}`);
        const quote = typeof description === "string" && description.trim() ? ` — "${description.trim()}"` : "";
        sessions.pushToast(`Agent: ${parts.length ? parts.join(", ") : "no changes"}${quote}`, "agent");
        return okText({
          ok: true,
          description: label,
          results: result.results,
          createdIds,
          elementCount: countElements({ elements: result.elements }),
          version,
        });
      }
    );

    // 5. save_diagram
    server.registerTool(
      "save_diagram",
      {
        description:
          "Explicitly save the current diagram, optionally under a new name (save-as). Names are sanitized to [a-z0-9._-], 1-64 chars. Records a save version.",
        inputSchema: {
          name: z.string().optional(),
        },
      },
      async ({ name }) => {
        if (!sessions.sessionInfo()) return noActiveSession();
        try {
          const { diagram, version, renamed } = store.saveCurrent({
            name,
            source: "agent",
            tool: "save_diagram",
            sceneOverride: await liveScene(),
          });
          if (renamed) {
            sessions.pushToActive({
              type: "diagram-switched",
              diagram,
              scene: store.currentScene(),
              origin: "save-as",
            });
          }
          sessions.pushToast(renamed ? `Agent: saved as ${diagram.name}` : `Agent: saved ${diagram.name}`, "agent");
          return okText({ ok: true, diagram, version, file: diagram.file });
        } catch (error) {
          return errText(error.code ?? "INTERNAL", error.message);
        }
      }
    );

    // 6. export_image
    server.registerTool(
      "export_image",
      {
        description:
          'Export the live Excalidraw rendering of the diagram. format "png" (default) or "svg"; optional rect {x,y,width,height} crops in scene coordinates; optional scale (default 1). Returns an image content block plus a JSON meta text block.',
        inputSchema: {
          format: z.enum(["png", "svg"]).optional(),
          rect: z
            .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
            .optional(),
          scale: z.number().optional(),
        },
      },
      async ({ format, rect, scale }) => {
        if (!sessions.sessionInfo()) return noActiveSession();
        const fmt = format ?? "png";
        let result;
        try {
          result = await sessions.exportImage({
            format: fmt,
            rect: rect ?? null,
            scale: scale ?? 1,
          });
        } catch (error) {
          return errText("EXPORT_FAILED", `export-image failed: ${error.message}`);
        }
        if (!result || typeof result.dataBase64 !== "string") {
          return errText("EXPORT_FAILED", "export-image returned an unexpected result");
        }
        const width = result.width ?? 0;
        const height = result.height ?? 0;
        sessions.pushToast(`Agent: exported ${fmt.toUpperCase()} ${width}×${height}`, "agent");
        const meta = store.currentMeta();
        return {
          content: [
            {
              type: "image",
              mimeType: result.mimeType || (fmt === "svg" ? "image/svg+xml" : "image/png"),
              data: result.dataBase64,
            },
            {
              type: "text",
              text: JSON.stringify(
                { format: fmt, width, height, rect: rect ?? null, diagramName: meta ? meta.name : null },
                null,
                2
              ),
            },
          ],
        };
      }
    );

    // 7. list_versions
    server.registerTool(
      "list_versions",
      {
        description: "List saved versions of the current diagram, newest first (default 50, max 200).",
        inputSchema: {
          limit: z.number().optional(),
        },
      },
      async ({ limit }) => {
        if (!sessions.sessionInfo()) return noActiveSession();
        const n = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 50;
        return okText({ versions: store.listVersions(n) });
      }
    );

    // 8. restore_version
    server.registerTool(
      "restore_version",
      {
        description:
          'Restore the current diagram to a version from list_versions. Snapshots the current state first ("pre-restore"), then applies the restored scene live to the open tab.',
        inputSchema: {
          versionId: z.string(),
        },
      },
      async ({ versionId }) => {
        if (!sessions.sessionInfo()) return noActiveSession();
        try {
          const { diagram, restoreVersion } = store.restoreVersion({
            versionId,
            source: "agent",
            tool: "restore_version",
            sceneOverride: await liveScene(),
          });
          const scene = store.currentScene();
          sessions.pushToActive({
            type: "scene-set",
            elements: scene ? scene.elements : [],
            appState: scene ? scene.appState : {},
            origin: "restore",
          });
          sessions.pushToast(`Agent: restored version ${versionId}`, "agent");
          return okText({ ok: true, diagram, version: restoreVersion, restoredFrom: String(versionId) });
        } catch (error) {
          return errText(error.code ?? "INTERNAL", error.message);
        }
      }
    );
  }

  function buildServer() {
    const server = new McpServer(SERVER_INFO);
    registerTools(server);
    return server;
  }

  const router = express.Router();

  // Permissive CORS: local single-user app (contract §5).
  router.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  router.post(
    "/",
    express.json({ limit: "50mb" }),
    async (req, res) => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        res.on("close", () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: String((error && error.message) || "internal error") },
            id: null,
          });
        }
      }
    }
  );

  // GET and DELETE on /mcp -> HTTP 405 (contract §5).
  router.use((req, res) => {
    res.status(405).set("Allow", "POST, OPTIONS");
    res.type("application/json").end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      })
    );
  });

  return router;
}
