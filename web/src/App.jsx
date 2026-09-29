import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, CaptureUpdateAction } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

import { api, setTabId } from "./api.js";
import { createWsClient } from "./ws.js";
import { handleApplyOps, handleGetScene, toSubset } from "./ops.js";
import { handleExportImage } from "./export.js";

import TopBar from "./components/TopBar.jsx";
import OpenDialog from "./components/OpenDialog.jsx";
import SaveAsDialog from "./components/SaveAsDialog.jsx";
import UnsavedDialog from "./components/UnsavedDialog.jsx";
import VersionsDrawer from "./components/VersionsDrawer.jsx";
import Toasts from "./components/Toasts.jsx";
import TakeoverModal from "./components/TakeoverModal.jsx";
import InactiveOverlay from "./components/InactiveOverlay.jsx";

const EMPTY_SCENE = { elements: [], appState: {} };

// Scene identity for echo suppression: `updateScene` may rewrite fractional
// `index` values, so they are excluded from the hash. Everything else must
// match exactly what `onChange` reports after a programmatic update.
function syncHash(elements, appStateSubset) {
  return JSON.stringify({ elements, appState: appStateSubset }, (key, value) =>
    key === "index" ? undefined : value
  );
}

function applySceneToApi(apiObj, target, resetHistory, syncRef) {
  const subset = { ...toSubset(apiObj.getAppState()), ...target.appState };
  const currentHash = syncHash(
    apiObj.getSceneElementsIncludingDeleted(),
    toSubset(apiObj.getAppState())
  );
  if (syncHash(target.elements, subset) === currentHash) {
    syncRef.current = currentHash;
    return;
  }
  apiObj.updateScene({
    elements: target.elements,
    appState: target.appState,
    // `commitToHistory` per contract §3.4 (`captureUpdate` is the 0.18 API).
    commitToHistory: true,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  if (resetHistory) apiObj.history.clear();
  // `updateScene` normalizes elements (fractional indices, restored fields), so
  // hash the READ-BACK scene: the `onChange` echo must match or every programmatic
  // scene switch would mark the freshly opened diagram dirty.
  syncRef.current = syncHash(
    apiObj.getSceneElementsIncludingDeleted(),
    toSubset(apiObj.getAppState())
  );
}

export default function App() {
  const [wsStatus, setWsStatus] = useState("connecting");
  const [tabStatus, setTabStatus] = useState("pending");
  const [invalidated, setInvalidated] = useState(null); // "taken-over" | "declined"
  const [takeoverPending, setTakeoverPending] = useState(false);
  const [diagram, setDiagram] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [initialScene, setInitialScene] = useState(null); // null until first scene
  const [toasts, setToasts] = useState([]);

  const [openDialog, setOpenDialog] = useState(false);
  const [openError, setOpenError] = useState(null);
  const [saveAs, setSaveAs] = useState(null); // { thenRun } | null
  const [saveAsError, setSaveAsError] = useState(null);
  const [unsavedAction, setUnsavedAction] = useState(null); // pending action
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [diagramList, setDiagramList] = useState(null);

  const apiRef = useRef(null);
  const wsRef = useRef(null);
  const handlersRef = useRef({});
  const syncRef = useRef("");
  const syncReadyRef = useRef(false);
  const seedRef = useRef(null);
  const queuedSceneRef = useRef(null);
  const apiWaitersRef = useRef([]);
  const toastSeqRef = useRef(0);

  // ---------------------------------------------------------------- toasts
  const pushToast = useCallback(({ text, kind = "info", ttlMs }) => {
    const id = ++toastSeqRef.current;
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : kind === "agent" ? 8000 : 5000;
    setToasts((prev) => [...prev, { id, text, kind, ttl }].slice(-4));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, ttl);
  }, []);

  const run = useCallback(
    async (fn) => {
      try {
        await fn();
        return true;
      } catch (err) {
        pushToast({ text: (err && err.message) || String(err), kind: "error" });
        return false;
      }
    },
    [pushToast]
  );

  // ------------------------------------------------------------ scene sync
  const deliverScene = useCallback((scene, opts = {}) => {
    const { resetHistory = false, discardPending = false } = opts;
    const target = {
      elements: (scene && scene.elements) || [],
      appState: (scene && scene.appState) || {},
    };
    const ws = wsRef.current;
    if (discardPending) {
      ws?.discardPendingScene();
    } else if (ws && ws.hasPendingScene()) {
      // Unsent local edits are newer than this push — keep them and re-sync.
      ws.flushSceneUpdate();
      return;
    }
    if (syncReadyRef.current && apiRef.current) {
      applySceneToApi(apiRef.current, target, resetHistory, syncRef);
      return;
    }
    // Before the canvas is up the scene only feeds `initialData`.
    setInitialScene((prev) => {
      if (prev == null) seedRef.current = target;
      return prev ?? target;
    });
    queuedSceneRef.current = target;
  }, []);

  const applyDiagramMeta = useCallback((meta) => {
    const hasPending = wsRef.current ? wsRef.current.hasPendingScene() : false;
    setDiagram(meta || null);
    setDirty(Boolean(meta && meta.dirty) || hasPending);
  }, []);

  // ---------------------------------------------------------- WS handlers
  handlersRef.current.onStatus = setWsStatus;

  handlersRef.current.onWelcome = (msg) => {
    setTabId(msg.tabId);
    setTabStatus(msg.status || "pending");
    if (msg.status === "pending") {
      setTakeoverPending(true);
      return;
    }
    if (msg.status === "rejected") {
      setInvalidated("declined");
      return;
    }
    setTakeoverPending(false);
    if (msg.status === "active") {
      applyDiagramMeta(msg.diagram);
      // §6.10: re-render state from welcome (recovers scene changes that
      // happened while this tab was disconnected).
      deliverScene(msg.scene || EMPTY_SCENE);
    }
  };

  handlersRef.current.onSessionActive = (msg) => {
    setTabStatus("active");
    setTakeoverPending(false);
    applyDiagramMeta(msg.diagram);
    deliverScene(msg.scene || EMPTY_SCENE);
  };

  handlersRef.current.onSessionInvalidated = (msg) => {
    setInvalidated(msg.reason === "taken-over" ? "taken-over" : "declined");
    if (msg.reason === "declined") setTabStatus("rejected");
  };

  handlersRef.current.onSceneSet = (msg) => {
    deliverScene({ elements: msg.elements || [], appState: msg.appState || {} });
    setDirty(true);
  };

  handlersRef.current.onDiagramSwitched = (msg) => {
    applyDiagramMeta(msg.diagram);
    const resetHistory = msg.origin === "open" || msg.origin === "new";
    deliverScene(msg.scene || EMPTY_SCENE, { resetHistory, discardPending: true });
  };

  handlersRef.current.onToast = (msg) => {
    pushToast({ text: msg.text, kind: msg.kind, ttlMs: msg.ttlMs });
  };

  handlersRef.current.onRpc = async (msg) => {
    const apiObj = await waitForApi();
    switch (msg.method) {
      case "get-scene":
        return handleGetScene(apiObj);
      case "apply-ops": {
        const result = handleApplyOps(apiObj, msg.params || {});
        // The follow-up `scene-update` echo must hash identically (§3.4).
        syncRef.current = syncHash(result.elements, result.appState);
        setDirty(true);
        return result;
      }
      case "export-image":
        return handleExportImage(apiObj, msg.params || {});
      default:
        throw new Error(`unknown rpc method "${msg.method}"`);
    }
  };

  // -------------------------------------------------------- Excalidraw glue
  const waitForApi = () => {
    if (apiRef.current) return Promise.resolve(apiRef.current);
    return new Promise((resolve, reject) => {
      apiWaitersRef.current.push(resolve);
      setTimeout(() => reject(new Error("Excalidraw is still loading")), 9000);
    });
  };

  const onApiReady = useCallback((apiObj) => {
    apiRef.current = apiObj;
    const current = {
      elements: apiObj.getSceneElementsIncludingDeleted(),
      appState: toSubset(apiObj.getAppState()),
    };
    syncRef.current = syncHash(current.elements, current.appState);
    syncReadyRef.current = true;
    const queued = queuedSceneRef.current;
    queuedSceneRef.current = null;
    const seed = seedRef.current;
    if (
      queued &&
      syncHash(queued.elements, queued.appState) !==
        syncHash((seed && seed.elements) || [], (seed && seed.appState) || {})
    ) {
      applySceneToApi(apiObj, queued, false, syncRef);
    }
    for (const resolve of apiWaitersRef.current.splice(0)) resolve(apiObj);
  }, []);

  const handleChange = useCallback((elements, appState) => {
    if (!syncReadyRef.current) return;
    const subset = toSubset(appState);
    const hash = syncHash(elements, subset);
    if (hash === syncRef.current) return;
    syncRef.current = hash;
    setDirty(true);
    wsRef.current?.queueSceneUpdate(elements, subset);
  }, []);

  // ------------------------------------------------------------- actions
  const refreshDiagrams = useCallback(async () => {
    try {
      setDiagramList(await api.listDiagrams());
    } catch (err) {
      pushToast({ text: (err && err.message) || String(err), kind: "error" });
    }
  }, [pushToast]);

  const doNew = useCallback(async () => {
    await run(async () => {
      const res = await api.newDiagram();
      applyDiagramMeta(res.diagram);
      deliverScene(res.scene || EMPTY_SCENE, { resetHistory: true, discardPending: true });
      pushToast({ text: `New diagram “${res.diagram.name}”`, kind: "info" });
    });
  }, [run, applyDiagramMeta, deliverScene, pushToast]);

  const doOpen = useCallback(
    async (payload) => {
      try {
        const res = await api.openDiagram(payload);
        applyDiagramMeta(res.diagram);
        deliverScene(res.scene || EMPTY_SCENE, { resetHistory: true, discardPending: true });
        setOpenDialog(false);
        setOpenError(null);
        pushToast({ text: `Opened “${res.diagram.name}”`, kind: "info" });
      } catch (err) {
        setOpenError((err && err.message) || String(err));
        pushToast({ text: (err && err.message) || String(err), kind: "error" });
      }
    },
    [applyDiagramMeta, deliverScene, pushToast]
  );

  const doSave = useCallback(async (name) => {
    wsRef.current?.flushSceneUpdate();
    const res = await api.saveDiagram(name);
    setDiagram(res.diagram);
    setDirty(Boolean(res.diagram.dirty));
    pushToast({ text: `Saved “${res.diagram.name}”`, kind: "success" });
    return res;
  }, [pushToast]);

  const runAction = useCallback(
    async (action) => {
      if (!action) return;
      if (action.type === "new") await doNew();
      else if (action.type === "open") await doOpen(action.payload);
    },
    [doNew, doOpen]
  );

  const guardUnsaved = useCallback(
    (action) => {
      if (!dirty) {
        runAction(action);
        return;
      }
      setUnsavedAction(action);
    },
    [dirty, runAction]
  );

  const handleSave = useCallback(
    (thenRun = null) => {
      if (!diagram) return;
      if (!diagram.isSaved) {
        setSaveAsError(null);
        setSaveAs({ thenRun });
        return;
      }
      run(async () => {
        try {
          await doSave();
        } catch (err) {
          if (err && err.code === "NAME_REQUIRED") {
            setSaveAs({ thenRun });
            return;
          }
          throw err;
        }
        if (thenRun) await runAction(thenRun);
      });
    },
    [diagram, run, doSave, runAction]
  );

  const submitSaveAs = useCallback(
    async (name) => {
      try {
        await doSave(name);
        const thenRun = (saveAs && saveAs.thenRun) || null;
        setSaveAs(null);
        setSaveAsError(null);
        if (thenRun) await runAction(thenRun);
      } catch (err) {
        setSaveAsError((err && err.message) || String(err));
      }
    },
    [doSave, saveAs, runAction]
  );

  const doRestore = useCallback(
    async (versionId) => {
      await run(async () => {
        const res = await api.restoreVersion(versionId);
        setDiagram(res.diagram);
        setDirty(Boolean(res.diagram.dirty));
        setVersions(res.versions || []);
        deliverScene(res.scene || EMPTY_SCENE);
        pushToast({ text: `Restored version ${versionId}`, kind: "info" });
      });
    },
    [run, deliverScene, pushToast]
  );

  const openVersions = useCallback(async () => {
    setVersionsOpen(true);
    setVersionsLoading(true);
    try {
      const res = await api.listVersions();
      setVersions(res.versions || []);
    } catch (err) {
      pushToast({ text: (err && err.message) || String(err), kind: "error" });
    } finally {
      setVersionsLoading(false);
    }
  }, [pushToast]);

  const openFromFile = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      guardUnsaved({
        type: "open",
        payload: { content: String(reader.result), fileName: file.name },
      });
    };
    reader.onerror = () => setOpenError("Could not read the selected file.");
    reader.readAsText(file);
  }, [guardUnsaved]);

  // -------------------------------------------------------------- effects
  useEffect(() => {
    const client = createWsClient({
      onStatus: (status) => handlersRef.current.onStatus(status),
      onWelcome: (msg) => handlersRef.current.onWelcome(msg),
      onSessionActive: (msg) => handlersRef.current.onSessionActive(msg),
      onSessionInvalidated: (msg) => handlersRef.current.onSessionInvalidated(msg),
      onSceneSet: (msg) => handlersRef.current.onSceneSet(msg),
      onDiagramSwitched: (msg) => handlersRef.current.onDiagramSwitched(msg),
      onToast: (msg) => handlersRef.current.onToast(msg),
      onRpc: (msg) => handlersRef.current.onRpc(msg),
    });
    wsRef.current = client;
    client.connect();
    return () => client.stop();
  }, []);

  const diagramName = diagram ? diagram.name : null;
  useEffect(() => {
    document.title = diagramName ? `${diagramName} — vis-a-vis` : "vis-a-vis";
  }, [diagramName]);

  const initialData = useMemo(
    () => ({
      elements: (initialScene && initialScene.elements) || [],
      appState: (initialScene && initialScene.appState) || {},
      scrollToContent: true,
    }),
    [initialScene]
  );

  return (
    <div className="vis-app">
      {initialScene ? (
        <div className="vis-canvas">
          <Excalidraw
            initialData={initialData}
            excalidrawAPI={onApiReady}
            onChange={handleChange}
            name={diagramName || "vis-a-vis"}
          />
        </div>
      ) : null}

      <TopBar
        diagram={diagram}
        dirty={dirty}
        wsStatus={wsStatus}
        recent={diagramList}
        onNew={() => guardUnsaved({ type: "new" })}
        onOpenDialog={() => {
          setOpenError(null);
          setOpenDialog(true);
          refreshDiagrams();
        }}
        onSave={() => handleSave()}
        onSaveAs={() => {
          setSaveAsError(null);
          setSaveAs({ thenRun: null });
        }}
        onVersions={openVersions}
        onRecentToggle={(open) => {
          if (open) refreshDiagrams();
        }}
        onPickRecent={(d) => guardUnsaved({ type: "open", payload: { id: d.id } })}
      />

      {openDialog ? (
        <OpenDialog
          diagrams={diagramList}
          loading={!diagramList}
          error={openError}
          onOpen={(d) => guardUnsaved({ type: "open", payload: { id: d.id } })}
          onOpenPath={(path) => guardUnsaved({ type: "open", payload: { path } })}
          onUpload={openFromFile}
          onClose={() => setOpenDialog(false)}
        />
      ) : null}

      {saveAs ? (
        <SaveAsDialog
          currentName={diagram ? diagram.name : ""}
          existingNames={(diagramList?.all || []).map((d) => d.name)}
          serverError={saveAsError}
          onSubmit={submitSaveAs}
          onClose={() => {
            setSaveAs(null);
            setSaveAsError(null);
          }}
        />
      ) : null}

      {unsavedAction ? (
        <UnsavedDialog
          onSave={() => {
            const action = unsavedAction;
            setUnsavedAction(null);
            handleSave(action);
          }}
          onDiscard={() => {
            const action = unsavedAction;
            setUnsavedAction(null);
            runAction(action);
          }}
          onCancel={() => setUnsavedAction(null)}
        />
      ) : null}

      {versionsOpen ? (
        <VersionsDrawer
          versions={versions}
          loading={versionsLoading}
          onRestore={doRestore}
          onClose={() => setVersionsOpen(false)}
        />
      ) : null}

      <Toasts toasts={toasts} />

      {takeoverPending ? (
        <TakeoverModal
          onContinue={() => {
            setTakeoverPending(false);
            wsRef.current?.takeover();
          }}
          onCancel={() => {
            setTakeoverPending(false);
            wsRef.current?.decline();
          }}
        />
      ) : null}

      {invalidated ? <InactiveOverlay reason={invalidated} /> : null}

      {tabStatus === "rejected" && !invalidated ? (
        <InactiveOverlay reason="declined" />
      ) : null}
    </div>
  );
}
