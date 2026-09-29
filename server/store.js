// File-based store: store.json index, <data>/files/*.excalidraw diagram files,
// <data>/versions/<diagramId>/<versionId>.json snapshots (contract §2).
// No imports of other server modules except pure semantics helpers.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { uniqueNamesGenerator, adjectives, animals } from "unique-names-generator";
import { pickAppState, countElements } from "./semantics.js";

const MAX_VERSIONS_PER_DIAGRAM = 100;
const AUTOSAVE_VERSION_WINDOW_MS = 120_000;
const FILE_AUTOSAVE_DEBOUNCE_MS = 500;

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = statusForCode(code);
  }
}

function statusForCode(code) {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "NAME_REQUIRED":
    case "INVALID_ARGUMENT":
      return 400;
    case "NOT_ACTIVE_SESSION":
      return 409;
    default:
      return 500;
  }
}

export function isoNow() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Name handling (contract §2.3)
// ---------------------------------------------------------------------------

export function sanitizeName(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-");
}

export function isValidName(name) {
  if (typeof name !== "string") return false;
  if (name.length < 1 || name.length > 64) return false;
  if (!/^[a-z0-9._-]+$/.test(name)) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;
  return true;
}

function randomSuffix() {
  return Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
}

export function createStore({ dataRoot }) {
  const filesDir = path.join(dataRoot, "files");
  const versionsDir = path.join(dataRoot, "versions");
  const storePath = path.join(dataRoot, "store.json");

  let store = loadStore();
  /** diagramId -> live scene ({elements, appState}) */
  const scenes = new Map();
  /** diagramId -> { seq, lastVersionAt, firstChangePending } */
  const versionState = new Map();
  /** diagramId -> debounce timer for file autosave */
  const fileTimers = new Map();

  // -------------------------------------------------------------------------
  // Persistence primitives
  // -------------------------------------------------------------------------

  function atomicWrite(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  function loadStore() {
    try {
      const raw = fs.readFileSync(storePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.diagrams && typeof parsed.diagrams === "object") {
        return {
          currentDiagramId: typeof parsed.currentDiagramId === "string" ? parsed.currentDiagramId : null,
          diagrams: parsed.diagrams,
        };
      }
    } catch {
      /* missing or corrupt index: start fresh */
    }
    return { currentDiagramId: null, diagrams: {} };
  }

  function saveStore() {
    if (store.currentDiagramId && !store.diagrams[store.currentDiagramId]) {
      store.currentDiagramId = null;
    }
    atomicWrite(storePath, JSON.stringify(store, null, 2));
  }

  function relFile(name) {
    return `files/${name}.excalidraw`;
  }

  function diagramFilePath(name) {
    return path.join(filesDir, `${name}.excalidraw`);
  }

  function versionDir(diagramId) {
    return path.join(versionsDir, diagramId);
  }

  function writeDiagramFile(meta, scene) {
    const data = {
      type: "vis-a-vis.diagram",
      version: 1,
      diagramId: meta.id,
      name: meta.name,
      isSaved: meta.isSaved,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      scene: {
        elements: Array.isArray(scene.elements) ? scene.elements : [],
        appState: pickAppState(scene.appState),
      },
    };
    atomicWrite(diagramFilePath(meta.name), JSON.stringify(data, null, 2));
  }

  /**
   * Parse a diagram file. Accepts our shape as well as plain Excalidraw files
   * (`{"type":"excalidraw","elements":[...],"appState":{...}}` and bare
   * `{"elements":[...]}`). Returns { scene, diagramId?, name?, isSaved? }.
   */
  function parseDiagramFile(raw, fallbackName) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new StoreError("INVALID_ARGUMENT", "file is not valid JSON");
    }
    if (!obj || typeof obj !== "object") {
      throw new StoreError("INVALID_ARGUMENT", "file is not an Excalidraw diagram");
    }
    const sceneFrom = (elements, appState) => ({
      elements: Array.isArray(elements) ? elements : [],
      appState: pickAppState(appState),
    });
    if (obj.type === "vis-a-vis.diagram" && obj.scene && typeof obj.scene === "object" && typeof obj.diagramId === "string") {
      return {
        scene: sceneFrom(obj.scene.elements, obj.scene.appState),
        diagramId: obj.diagramId,
        name: typeof obj.name === "string" ? obj.name : fallbackName,
        isSaved: obj.isSaved === true,
      };
    }
    if (obj.type === "excalidraw" || Array.isArray(obj.elements)) {
      return {
        scene: sceneFrom(obj.elements, obj.appState),
        diagramId: null,
        name: fallbackName,
        isSaved: false,
      };
    }
    throw new StoreError("INVALID_ARGUMENT", "file is not an Excalidraw diagram");
  }

  // -------------------------------------------------------------------------
  // Names
  // -------------------------------------------------------------------------

  function nameTaken(name, exceptId) {
    return Object.values(store.diagrams).some((d) => d.name === name && d.id !== exceptId);
  }

  function generateName() {
    for (let i = 0; i < 50; i++) {
      const base = uniqueNamesGenerator({
        dictionaries: [adjectives, animals],
        separator: "-",
        length: 2,
        style: "lowerCase",
      });
      const candidate = `${base}-${randomSuffix()}`;
      if (isValidName(candidate) && !nameTaken(candidate, null)) return candidate;
    }
    return `diagram-${Date.now().toString(36)}`;
  }

  /** Derive a safe, unique diagram name from a file name; null if unusable. */
  function deriveName(fileName) {
    if (typeof fileName !== "string" || !fileName.trim()) return null;
    let base = path.basename(fileName.trim());
    base = base.replace(/\.(excalidraw|json)$/i, "");
    base = sanitizeName(base);
    if (!isValidName(base)) return null;
    if (!nameTaken(base, null)) return base;
    for (let i = 0; i < 50; i++) {
      const stem = base.length > 59 ? base.slice(0, 59) : base;
      const candidate = `${stem}-${randomSuffix()}`;
      if (isValidName(candidate) && !nameTaken(candidate, null)) return candidate;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Scenes
  // -------------------------------------------------------------------------

  function currentMeta() {
    return store.currentDiagramId ? store.diagrams[store.currentDiagramId] ?? null : null;
  }

  function loadSceneFor(diagramId) {
    if (scenes.has(diagramId)) return scenes.get(diagramId);
    const meta = store.diagrams[diagramId];
    if (!meta) return null;
    let raw;
    try {
      raw = fs.readFileSync(diagramFilePath(meta.name), "utf8");
    } catch {
      return null;
    }
    const parsed = parseDiagramFile(raw, meta.name);
    const scene = parsed.scene;
    scenes.set(diagramId, scene);
    return scene;
  }

  function currentScene() {
    const meta = currentMeta();
    return meta ? loadSceneFor(meta.id) : null;
  }

  function setScene(diagramId, scene) {
    const normalized = {
      elements: Array.isArray(scene && scene.elements) ? scene.elements : [],
      appState: pickAppState(scene && scene.appState),
    };
    scenes.set(diagramId, normalized);
    const meta = store.diagrams[diagramId];
    if (meta) {
      meta.elementCount = countElements(normalized);
      meta.updatedAt = isoNow();
    }
    return normalized;
  }

  function scheduleFileAutosave(diagramId) {
    clearTimeout(fileTimers.get(diagramId));
    fileTimers.set(
      diagramId,
      setTimeout(() => {
        fileTimers.delete(diagramId);
        flushFile(diagramId);
      }, FILE_AUTOSAVE_DEBOUNCE_MS)
    );
  }

  function flushFile(diagramId) {
    const meta = store.diagrams[diagramId];
    const scene = scenes.get(diagramId);
    if (!meta || !scene) return;
    writeDiagramFile(meta, scene);
  }

  // -------------------------------------------------------------------------
  // Versions (contract §2.4)
  // -------------------------------------------------------------------------

  function versionFileName(diagramId, versionId) {
    return path.join(versionDir(diagramId), `${versionId}.json`);
  }

  function versionParts(versionId) {
    const m = /^(\d+)-(\d+)$/.exec(String(versionId));
    return m ? { millis: Number(m[1]), seq: Number(m[2]) } : { millis: 0, seq: 0 };
  }

  function newestFirst(a, b) {
    const pa = versionParts(a);
    const pb = versionParts(b);
    if (pb.millis !== pa.millis) return pb.millis - pa.millis;
    return pb.seq - pa.seq;
  }

  function vsFor(diagramId) {
    let vs = versionState.get(diagramId);
    if (!vs) {
      let seq = 0;
      let lastVersionAt = 0;
      try {
        const ids = fs.readdirSync(versionDir(diagramId)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
        for (const id of ids) {
          const p = versionParts(id);
          if (p.seq > seq) seq = p.seq;
          if (p.millis > lastVersionAt) lastVersionAt = p.millis;
        }
        if (lastVersionAt === 0) lastVersionAt = Date.now();
      } catch {
        /* no versions yet */
      }
      // Treat pre-existing versions as "a version exists", so the first scene
      // change of this run snapshots once (policy row 3).
      vs = { seq, lastVersionAt: lastVersionAt || Date.now(), firstChangePending: true };
      versionState.set(diagramId, vs);
    }
    return vs;
  }

  function createVersion(diagramId, scene, { source, kind, label, tool }) {
    const vs = vsFor(diagramId);
    const now = Date.now();
    const id = `${now}-${++vs.seq}`;
    const version = {
      id,
      diagramId,
      createdAt: new Date(now).toISOString(),
      source,
      kind,
      label: String(label ?? kind),
      tool: tool ?? null,
      elementCount: countElements(scene),
      isAgent: source === "agent",
    };
    fs.mkdirSync(versionDir(diagramId), { recursive: true });
    atomicWrite(
      versionFileName(diagramId, id),
      JSON.stringify(
        {
          version,
          scene: {
            elements: Array.isArray(scene.elements) ? scene.elements : [],
            appState: pickAppState(scene.appState),
          },
        },
        null,
        2
      )
    );
    vs.lastVersionAt = now;
    if (kind !== "autosave") vs.firstChangePending = true;
    pruneVersions(diagramId);
    return version;
  }

  function pruneVersions(diagramId) {
    let ids;
    try {
      ids = fs.readdirSync(versionDir(diagramId)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch {
      return;
    }
    if (ids.length <= MAX_VERSIONS_PER_DIAGRAM) return;
    ids.sort(newestFirst);
    for (const id of ids.slice(MAX_VERSIONS_PER_DIAGRAM)) {
      try {
        fs.rmSync(versionFileName(diagramId, id), { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  function listVersions(diagramId, limit = 200) {
    const meta = store.diagrams[diagramId];
    if (!meta) return [];
    let ids = [];
    try {
      ids = fs.readdirSync(versionDir(diagramId)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
    ids.sort(newestFirst);
    const out = [];
    for (const id of ids.slice(0, Math.max(1, limit))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(versionFileName(diagramId, id), "utf8"));
        if (parsed && parsed.version) out.push(parsed.version);
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  function readVersion(diagramId, versionId) {
    if (!/^\d+-\d+$/.test(String(versionId))) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(versionFileName(diagramId, versionId), "utf8"));
      if (!parsed || !parsed.version) return null;
      return { version: parsed.version, scene: parsed.scene ?? { elements: [], appState: {} } };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Diagram lifecycle
  // -------------------------------------------------------------------------

  function makeMeta({ id, name, isSaved }) {
    const now = isoNow();
    return {
      id,
      name,
      isSaved,
      dirty: false,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      lastEditedAt: null,
      savedAt: null,
      elementCount: 0,
      file: relFile(name),
    };
  }

  function registerDiagram(meta, scene) {
    store.diagrams[meta.id] = meta;
    store.currentDiagramId = meta.id;
    scenes.set(meta.id, scene);
    meta.elementCount = countElements(scene);
    writeDiagramFile(meta, scene);
    saveStore();
  }

  function newDiagram() {
    const id = crypto.randomUUID();
    const meta = makeMeta({ id, name: generateName(), isSaved: false });
    const scene = { elements: [], appState: {} };
    registerDiagram(meta, scene);
    createVersion(id, scene, { source: "user", kind: "created", label: "created", tool: null });
    return { diagram: meta, scene };
  }

  function openById(id) {
    const meta = store.diagrams[id];
    if (!meta) throw new StoreError("NOT_FOUND", `no diagram with id ${id}`);
    const scene = loadSceneFor(id);
    if (!scene) throw new StoreError("NOT_FOUND", `diagram file for ${meta.name} is missing`);
    store.currentDiagramId = id;
    meta.lastOpenedAt = isoNow();
    createVersion(id, scene, { source: "user", kind: "opened", label: "opened", tool: null });
    saveStore();
    return { diagram: meta, scene };
  }

  function openImported(parsed, fallbackName) {
    // Our own shape with a known diagramId: adopt into that entry when it exists.
    if (parsed.diagramId && store.diagrams[parsed.diagramId]) {
      const meta = store.diagrams[parsed.diagramId];
      const scene = setScene(meta.id, parsed.scene);
      store.currentDiagramId = meta.id;
      meta.lastOpenedAt = isoNow();
      flushFile(meta.id);
      saveStore();
      createVersion(meta.id, scene, { source: "user", kind: "opened", label: "opened", tool: null });
      return { diagram: meta, scene };
    }
    const id = parsed.diagramId || crypto.randomUUID();
    const name = deriveName(parsed.name ?? fallbackName) ?? deriveName(fallbackName) ?? generateName();
    const meta = makeMeta({ id, name, isSaved: parsed.isSaved === true && isValidName(name) });
    registerDiagram(meta, parsed.scene);
    createVersion(id, parsed.scene, { source: "user", kind: "opened", label: "opened", tool: null });
    return { diagram: meta, scene: parsed.scene };
  }

  function openDiagram(spec) {
    if (spec && typeof spec.id === "string" && spec.id) return openById(spec.id);
    if (spec && typeof spec.path === "string" && spec.path) {
      let raw;
      try {
        raw = fs.readFileSync(spec.path, "utf8");
      } catch {
        throw new StoreError("NOT_FOUND", `cannot read file ${spec.path}`);
      }
      return openImported(parseDiagramFile(raw, path.basename(spec.path)), path.basename(spec.path));
    }
    if (spec && typeof spec.content === "string") {
      return openImported(parseDiagramFile(spec.content, spec.fileName), spec.fileName);
    }
    throw new StoreError("INVALID_ARGUMENT", "open requires {id}, {path} or {content}");
  }

  function saveCurrent({ name, source = "user", tool = null, sceneOverride = null }) {
    const meta = currentMeta();
    if (!meta) throw new StoreError("NOT_FOUND", "no current diagram");
    let targetName;
    if (name === undefined || name === null || String(name).trim() === "") {
      if (!meta.isSaved) {
        throw new StoreError("NAME_REQUIRED", "this diagram has no saved name yet — provide a name");
      }
      targetName = meta.name;
    } else {
      targetName = sanitizeName(name);
      if (!isValidName(targetName)) {
        throw new StoreError(
          "INVALID_ARGUMENT",
          "name must be 1-64 chars of [a-z0-9._-] without path separators or '..'"
        );
      }
    }
    if (sceneOverride) setScene(meta.id, sceneOverride);
    const scene = scenes.get(meta.id) ?? loadSceneFor(meta.id) ?? { elements: [], appState: {} };
    const renamed = targetName !== meta.name;
    const oldName = meta.name;
    if (renamed) {
      const other = Object.values(store.diagrams).find((d) => d.name === targetName && d.id !== meta.id);
      if (other) {
        // Snapshot the diagram being overwritten before its file is clobbered
        // (contract §2.3), then retire its index entry.
        const otherScene = scenes.get(other.id) ?? loadSceneFor(other.id);
        if (otherScene) {
          createVersion(other.id, otherScene, {
            source: "user",
            kind: "save",
            label: "snapshot before overwrite",
            tool: null,
          });
        }
        if (fileTimers.has(other.id)) {
          clearTimeout(fileTimers.get(other.id));
          fileTimers.delete(other.id);
        }
        scenes.delete(other.id);
        delete store.diagrams[other.id];
      }
      meta.name = targetName;
      meta.file = relFile(targetName);
    }
    meta.isSaved = true;
    meta.dirty = false;
    meta.updatedAt = isoNow();
    meta.savedAt = meta.updatedAt;
    meta.elementCount = countElements(scene);
    const version = createVersion(meta.id, scene, {
      source,
      kind: "save",
      label: `saved ${meta.name}`,
      tool,
    });
    if (fileTimers.has(meta.id)) {
      clearTimeout(fileTimers.get(meta.id));
      fileTimers.delete(meta.id);
    }
    writeDiagramFile(meta, scene);
    if (renamed) {
      // The diagram moved to a new file; drop the stale one.
      try {
        fs.rmSync(diagramFilePath(oldName), { force: true });
      } catch {
        /* best effort */
      }
    }
    saveStore();
    return { diagram: meta, version, renamed };
  }

  function restoreVersion({ versionId, source = "user", tool = null, sceneOverride = null }) {
    const meta = currentMeta();
    if (!meta) throw new StoreError("NOT_FOUND", "no current diagram");
    const target = readVersion(meta.id, versionId);
    if (!target) throw new StoreError("NOT_FOUND", `no version ${versionId} for the current diagram`);
    const current = sceneOverride ?? scenes.get(meta.id) ?? loadSceneFor(meta.id) ?? { elements: [], appState: {} };
    createVersion(meta.id, current, {
      source: "user",
      kind: "pre-restore",
      label: "state before restore",
      tool: null,
    });
    const restored = setScene(meta.id, target.scene);
    meta.dirty = true;
    meta.lastEditedAt = isoNow();
    const restoreMeta = createVersion(meta.id, restored, {
      source,
      kind: "restore",
      label: `restored version ${versionId}`,
      tool,
    });
    scheduleFileAutosave(meta.id);
    saveStore();
    return {
      diagram: meta,
      scene: restored,
      versions: listVersions(meta.id),
      restoredFrom: String(versionId),
      restoreVersion: restoreMeta,
    };
  }

  /**
   * Scene change from the active tab (contract WS `scene-update`).
   * Handles dirty tracking and the autosave-version policy (§2.4).
   */
  function applySceneUpdate(elements, appState) {
    let meta = currentMeta();
    if (!meta) {
      // Defensive: never drop edits when the UI draws before a diagram exists.
      meta = newDiagram().diagram;
    }
    const scene = setScene(meta.id, { elements, appState });
    meta.dirty = true;
    meta.lastEditedAt = isoNow();
    scheduleFileAutosave(meta.id);
    saveStore();
    const vs = vsFor(meta.id);
    const now = Date.now();
    if (vs.firstChangePending || now - vs.lastVersionAt > AUTOSAVE_VERSION_WINDOW_MS) {
      vs.firstChangePending = false;
      createVersion(meta.id, scene, { source: "system", kind: "autosave", label: "autosave", tool: null });
    }
  }

  /**
   * Scene change applied by an agent edit (MCP `edit_diagram`): exactly one
   * `mcp-edit` version per call.
   */
  function recordAgentEdit(elements, appState, { label, tool }) {
    let meta = currentMeta();
    if (!meta) meta = newDiagram().diagram;
    const scene = setScene(meta.id, { elements, appState });
    meta.dirty = true;
    meta.lastEditedAt = isoNow();
    const version = createVersion(meta.id, scene, {
      source: "agent",
      kind: "mcp-edit",
      label,
      tool,
    });
    scheduleFileAutosave(meta.id);
    saveStore();
    return version;
  }

  function listDiagrams() {
    const all = Object.values(store.diagrams).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const recentOpened = all
      .filter((d) => d.isSaved === true)
      .sort((a, b) => String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)))
      .slice(0, 10);
    const recentUnsaved = all
      .filter((d) => d.dirty === true)
      .sort((a, b) => String(b.lastEditedAt ?? "").localeCompare(String(a.lastEditedAt ?? "")))
      .slice(0, 10);
    return { all, recentOpened, recentUnsaved };
  }

  function currentVersions(limit = 200) {
    const meta = currentMeta();
    return meta ? listVersions(meta.id, limit) : [];
  }

  // Contract §2.3: there is always a current diagram. Activating a session with an
  // empty store starts a fresh random-named one (its versioning starts with it).
  function ensureCurrent() {
    const meta = currentMeta();
    return meta ? { diagram: meta, scene: currentScene() } : newDiagram();
  }

  return {
    dataRoot,
    currentMeta,
    currentScene,
    newDiagram,
    ensureCurrent,
    openDiagram,
    saveCurrent,
    restoreVersion,
    applySceneUpdate,
    recordAgentEdit,
    listDiagrams,
    listVersions: currentVersions,
  };
}
