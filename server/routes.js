// REST API (contract §4). All responses JSON; errors are {"error":{"code","message"}}.

import express from "express";

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function createApiRouter({ store, sessions, ctx }) {
  const r = express.Router();
  r.use(express.json({ limit: "50mb" }));

  // Mutation guard (contract §4): the caller must be the active session's tab.
  function requireActiveTab(req, res, next) {
    const tabId = req.get("x-vis-a-vis-tab");
    const session = sessions.sessionInfo();
    if (!session || !tabId || tabId !== session.tabId) {
      res.status(409).json({
        error: {
          code: "NOT_ACTIVE_SESSION",
          message: "this request must come from the tab that holds the active editing session",
        },
      });
      return;
    }
    next();
  }

  async function liveScene() {
    try {
      const scene = await sessions.getScene();
      if (scene && Array.isArray(scene.elements)) return scene;
    } catch {
      /* fall back to the last persisted scene */
    }
    return null;
  }

  r.get("/status", (req, res) => {
    const session = sessions.sessionInfo();
    res.json({
      appUrl: ctx.appUrl,
      port: ctx.port,
      activeTab: session ? { tabId: session.tabId, lastActivity: session.lastActivity } : null,
      diagram: store.currentMeta(),
    });
  });

  r.get("/diagrams", (req, res) => {
    res.json(store.listDiagrams());
  });

  r.post("/diagrams/new", requireActiveTab, (req, res) => {
    const { diagram, scene } = store.newDiagram();
    sessions.pushToActive({ type: "diagram-switched", diagram, scene, origin: "new" });
    res.json({ diagram, scene });
  });

  r.post("/diagrams/open", requireActiveTab, (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { diagram, scene } = store.openDiagram(body);
    sessions.pushToActive({ type: "diagram-switched", diagram, scene, origin: "open" });
    res.json({ diagram, scene });
  });

  r.post(
    "/diagrams/save",
    requireActiveTab,
    asyncRoute(async (req, res) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const { diagram, version, renamed } = store.saveCurrent({
        name: body.name,
        source: "user",
        tool: null,
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
      res.json({ diagram, version });
    })
  );

  r.get("/versions", (req, res) => {
    res.json({ versions: store.listVersions(200) });
  });

  r.post(
    "/versions/:id/restore",
    requireActiveTab,
    asyncRoute(async (req, res) => {
      const { diagram, scene, versions } = store.restoreVersion({
        versionId: req.params.id,
        source: "user",
        tool: null,
        sceneOverride: await liveScene(),
      });
      sessions.pushToActive({
        type: "scene-set",
        elements: scene.elements,
        appState: scene.appState,
        origin: "restore",
      });
      res.json({ diagram, scene, versions });
    })
  );

  r.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `no route ${req.method} ${req.path}` } });
  });

  // Express error handler (4-arg signature identifies it).
  r.use((err, req, res, next) => {
    const code = err && err.code && err.status ? err.code : "INTERNAL";
    const status = err && err.status ? err.status : 500;
    if (res.headersSent) return;
    res.status(status).json({
      error: {
        code,
        message: String((err && err.message) || "internal error"),
      },
    });
  });

  return r;
}
