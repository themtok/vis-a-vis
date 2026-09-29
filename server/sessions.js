// WebSocket hub and active-session state machine (contract §3).
// One socket per browser tab on path /ws; the active tab is the only editor.

import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const RELOAD_GRACE_MS = 1500;
const RPC_TIMEOUT_MS = 10_000;
const AGENT_TOAST_TTL_MS = 8000;
const INFO_TOAST_TTL_MS = 5000;

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

export function createSessions({ store }) {
  /** ws -> conn { ws, tabId, tabKey, status, lastActivity, pending } */
  const conns = new Map();
  let active = null; // conn | null (survives the 1500 ms reload grace)
  let graceTimer = null;
  let lastAppliedHash = null;
  let wss = null;

  function send(conn, msg) {
    if (conn && conn.ws && conn.ws.readyState === 1) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  function diagramOf() {
    return store.currentMeta();
  }

  function sceneOf() {
    return store.currentScene();
  }

  // Contract §2.3: an activating session always gets a diagram — with an empty
  // store this starts a fresh random-named one. Only called on activation paths,
  // never for pending tabs (which must not steal currentDiagramId).
  function activeDiagram() {
    store.ensureCurrent();
    return diagramOf();
  }

  function rejectPending(conn, error) {
    for (const [, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    conn.pending.clear();
  }

  function sessionActiveMessage() {
    return { type: "session-active", diagram: activeDiagram(), scene: sceneOf() };
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  function onHello(conn, msg) {
    const tabKey = typeof msg.tabKey === "string" && msg.tabKey ? msg.tabKey : crypto.randomUUID();
    conn.tabKey = tabKey;
    conn.tabId = crypto.randomUUID();
    conn.lastActivity = Date.now();

    if (active && active.tabKey === tabKey) {
      // Reload (or reconnect) of the active tab: replace the socket, stay active.
      const old = active;
      clearTimeout(graceTimer);
      graceTimer = null;
      active = conn;
      conn.status = "active";
      if (old !== conn) {
        old.status = "rejected";
        conns.delete(old.ws);
        rejectPending(old, new Error("socket replaced by a reload"));
        try {
          old.ws.close();
        } catch {
          /* already gone */
        }
      }
      send(conn, {
        type: "welcome",
        tabId: conn.tabId,
        status: "active",
        activeTabExists: true,
        diagram: activeDiagram(),
        scene: sceneOf(),
      });
      send(conn, sessionActiveMessage());
      return;
    }

    if (active) {
      // A live active tab exists (including its reload grace window).
      conn.status = "pending";
      send(conn, {
        type: "welcome",
        tabId: conn.tabId,
        status: "pending",
        activeTabExists: true,
        diagram: diagramOf(),
        scene: sceneOf(),
      });
      return;
    }

    // No active tab: this tab becomes the active session immediately.
    active = conn;
    conn.status = "active";
    send(conn, {
      type: "welcome",
      tabId: conn.tabId,
      status: "active",
      activeTabExists: true,
      diagram: activeDiagram(),
      scene: sceneOf(),
    });
    send(conn, sessionActiveMessage());
  }

  function onTakeover(conn) {
    if (conn.status !== "pending" || !active) return;
    for (const other of conns.values()) {
      if (other === conn) continue;
      other.status = "rejected";
      rejectPending(other, new Error("session taken over by another tab"));
      send(other, { type: "session-invalidated", reason: "taken-over" });
    }
    clearTimeout(graceTimer);
    graceTimer = null;
    active = conn;
    conn.status = "active";
    send(conn, sessionActiveMessage());
  }

  function onDecline(conn) {
    if (conn.status !== "pending") return;
    conn.status = "rejected";
    send(conn, { type: "session-invalidated", reason: "declined" });
  }

  function onSceneUpdate(conn, msg) {
    if (conn.status !== "active") return;
    conn.lastActivity = Date.now();
    const elements = Array.isArray(msg.elements) ? msg.elements : [];
    // Echo suppression (contract §3.4): swallow the scene-update that mirrors
    // the result of the last server-driven apply-ops.
    if (lastAppliedHash) {
      const hash = sha1(JSON.stringify(elements));
      if (hash === lastAppliedHash) {
        lastAppliedHash = null;
        return;
      }
    }
    store.applySceneUpdate(elements, msg.appState);
  }

  function onRpcResult(conn, msg) {
    const pending = conn.pending.get(msg.id);
    if (!pending) return;
    conn.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(typeof msg.error === "string" ? msg.error : "rpc failed"));
  }

  function onMessage(ws, raw) {
    const conn = conns.get(ws);
    if (!conn) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (conn.tabKey === undefined) {
      if (msg.type === "hello") onHello(conn, msg);
      return;
    }
    conn.lastActivity = Date.now();
    switch (msg.type) {
      case "hello":
        onHello(conn, msg);
        break;
      case "takeover":
        onTakeover(conn);
        break;
      case "decline":
        onDecline(conn);
        break;
      case "scene-update":
        onSceneUpdate(conn, msg);
        break;
      case "rpc-result":
        onRpcResult(conn, msg);
        break;
      case "ping":
        break;
      default:
        break;
    }
  }

  function onClose(ws) {
    const conn = conns.get(ws);
    if (!conn) return;
    conns.delete(ws);
    rejectPending(conn, new Error("connection closed"));
    if (active === conn) {
      // Reload grace: the active session survives RELOAD_GRACE_MS so the same
      // tabKey can reconnect without losing the session.
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (active === conn && conn.ws.readyState !== 1) active = null;
      }, RELOAD_GRACE_MS);
    }
  }

  // -------------------------------------------------------------------------
  // Server -> client RPC (contract §3.4)
  // -------------------------------------------------------------------------

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const conn = active;
      if (!conn || conn.ws.readyState !== 1) {
        reject(Object.assign(new Error("no active tab"), { code: "NO_ACTIVE_SESSION" }));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(Object.assign(new Error(`rpc ${method} timed out`), { code: "RPC_TIMEOUT" }));
      }, RPC_TIMEOUT_MS);
      conn.pending.set(id, { resolve, reject, timer });
      send(conn, { type: "rpc", id, method, params });
    });
  }

  async function applyOps({ description, ops }) {
    const result = await rpc("apply-ops", { description, ops });
    if (result && Array.isArray(result.elements)) {
      lastAppliedHash = sha1(JSON.stringify(result.elements));
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Push helpers
  // -------------------------------------------------------------------------

  function pushToActive(msg) {
    if (!active || active.ws.readyState !== 1) return false;
    send(active, msg);
    return true;
  }

  function pushToast(text, kind = "agent") {
    return pushToActive({
      type: "toast",
      text,
      kind,
      ttlMs: kind === "agent" ? AGENT_TOAST_TTL_MS : INFO_TOAST_TTL_MS,
    });
  }

  function sessionInfo() {
    if (!active) return null;
    return {
      tabId: active.tabId,
      tabKey: active.tabKey,
      lastActivity: new Date(active.lastActivity).toISOString(),
    };
  }

  function attachTo(httpServer) {
    wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    // `ws` re-emits the http server's "error" on itself; unhandled it throws
    // before the listen loop can react to EADDRINUSE. The listen loop owns
    // these errors (port fallback §1) — this listener only defuses the re-emit.
    wss.on("error", () => {});
    wss.on("connection", (ws) => {
      const conn = {
        ws,
        tabId: undefined,
        tabKey: undefined,
        status: "pending",
        lastActivity: Date.now(),
        pending: new Map(),
      };
      conns.set(ws, conn);
      ws.on("message", (raw) => onMessage(ws, raw));
      ws.on("close", () => onClose(ws));
      ws.on("error", () => onClose(ws));
    });
  }

  return {
    attachTo,
    sessionInfo,
    pushToActive,
    pushToast,
    rpc,
    applyOps,
    getScene: () => rpc("get-scene", {}),
    exportImage: (params) => rpc("export-image", params),
  };
}
