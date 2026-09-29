// WebSocket session client — contract §3.1 (client→server), §3.2 (server→client),
// §3.3 (session state machine) and §6.10 (reconnection).
//
// One socket per browser tab. `hello` (with the tab key) is always the first
// message on a fresh socket. Scene updates are debounced ~400 ms; a 10 s `ping`
// heartbeat keeps the session's lastActivity fresh. Unexpected closes reconnect
// with backoff 1 s, 2 s, 4 s, … capped at 10 s, reusing the same tab key.

const TAB_KEY_STORAGE = "vis-a-vis-tab-key";
const PING_INTERVAL_MS = 10_000;
const SCENE_UPDATE_DEBOUNCE_MS = 400;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

let memoryTabKey = null;

export function getTabKey() {
  try {
    let key = sessionStorage.getItem(TAB_KEY_STORAGE);
    if (!key) {
      key = crypto.randomUUID();
      sessionStorage.setItem(TAB_KEY_STORAGE, key);
    }
    return key;
  } catch {
    // sessionStorage unavailable — fall back to a per-load key.
    if (!memoryTabKey) memoryTabKey = crypto.randomUUID();
    return memoryTabKey;
  }
}

export function createWsClient(handlers) {
  const {
    onWelcome,
    onSessionActive,
    onSessionInvalidated,
    onSceneSet,
    onDiagramSwitched,
    onToast,
    onRpc,
    onStatus,
  } = handlers || {};
  const tabKey = getTabKey();

  let socket = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let sceneTimer = null;
  let pendingScene = null; // { elements, appState } — latest, not yet sent

  const isOpen = () => socket != null && socket.readyState === WebSocket.OPEN;

  function send(msg) {
    if (!isOpen()) return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
  }

  function stopPing() {
    clearInterval(pingTimer);
    pingTimer = null;
  }

  function queueSceneUpdate(elements, appState) {
    pendingScene = { elements, appState };
    clearTimeout(sceneTimer);
    sceneTimer = setTimeout(() => {
      sceneTimer = null;
      flushSceneUpdate();
    }, SCENE_UPDATE_DEBOUNCE_MS);
  }

  function flushSceneUpdate() {
    clearTimeout(sceneTimer);
    sceneTimer = null;
    const payload = pendingScene;
    if (!payload) return;
    if (send({ type: "scene-update", elements: payload.elements, appState: payload.appState })) {
      pendingScene = null;
    }
    // Socket down: the payload stays queued and is retried on reconnect.
  }

  function discardPendingScene() {
    clearTimeout(sceneTimer);
    sceneTimer = null;
    pendingScene = null;
  }

  async function handleRpc(msg) {
    try {
      const result = await onRpc(msg);
      send({ type: "rpc-result", id: msg.id, ok: true, result });
    } catch (err) {
      send({
        type: "rpc-result",
        id: msg.id,
        ok: false,
        error: String((err && err.message) || err),
      });
    }
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        reconnectAttempts = 0;
        onWelcome?.(msg);
        flushSceneUpdate();
        break;
      case "session-active":
        onSessionActive?.(msg);
        break;
      case "session-invalidated":
        onSessionInvalidated?.(msg);
        break;
      case "scene-set":
        onSceneSet?.(msg);
        break;
      case "diagram-switched":
        onDiagramSwitched?.(msg);
        break;
      case "toast":
        onToast?.(msg);
        break;
      case "rpc":
        handleRpc(msg);
        break;
      default:
        break;
    }
  }

  function connect() {
    if (stopped) return;
    onStatus?.("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws`);
    socket.onopen = () => {
      onStatus?.("open");
      startPing();
      // `hello` MUST be the first message on a fresh socket (§3.1).
      send({ type: "hello", tabKey });
    };
    socket.onmessage = (event) => handleMessage(event.data);
    socket.onclose = () => {
      stopPing();
      socket = null;
      onStatus?.("closed");
      if (!stopped) scheduleReconnect();
    };
    socket.onerror = () => {
      // The browser always follows errors with a close event; reconnect there.
    };
  }

  return {
    tabKey,
    connect,
    takeover: () => send({ type: "takeover" }),
    decline: () => send({ type: "decline" }),
    queueSceneUpdate,
    flushSceneUpdate,
    discardPendingScene,
    hasPendingScene: () => pendingScene != null,
    isOpen,
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      discardPendingScene();
      stopPing();
      if (socket) socket.close();
    },
  };
}
