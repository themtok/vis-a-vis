// `apply-ops` RPC handler — contract §3.4 (Op shapes shared with MCP
// `edit_diagram`, §5).
//
//   { op: "add",    elements: [SkeletonElement, ...] }
//   { op: "update", id, changes: { ...partial skeleton/element fields } }
//   { op: "delete", ids: [...] }
//
// `add` goes through `convertToExcalidrawElements`. Explicit ids given in a
// skeleton MUST survive: generated ids are remapped to the requested ids and all
// references (`boundElements[].id`, `containerId`, `startBinding.elementId`,
// `endBinding.elementId`) are rewritten accordingly (`groupIds` untouched).
// `update` merges `changes` into the existing element and bumps
// `version`/`versionNonce`/`updated`; it supports re-binding arrows via
// `start`/`end` `{id}` (or `startBinding`/`endBinding` `{elementId,focus,gap}`)
// and updating/creating a shape's `label` text. `delete` removes ids and detaches
// bound texts/bindings that referenced them. Results carry the FULL new element
// list (the server persists it verbatim).

import { convertToExcalidrawElements, CaptureUpdateAction } from "@excalidraw/excalidraw";

// ---------------------------------------------------------------------------
// small helpers

const randomInt = () => Math.floor(Math.random() * 2 ** 31);
const newId = () => crypto.randomUUID();

function touch(el, extra) {
  return {
    ...el,
    ...(extra || {}),
    version: (typeof el.version === "number" ? el.version : 0) + 1,
    versionNonce: randomInt(),
    updated: Date.now(),
  };
}

/** Only these appState fields are persisted/synced (§3.3). */
export function toSubset(appState) {
  const subset = {};
  if (!appState) return subset;
  if (appState.viewBackgroundColor !== undefined) {
    subset.viewBackgroundColor = appState.viewBackgroundColor;
  }
  if (appState.gridSize !== undefined) subset.gridSize = appState.gridSize;
  if (appState.gridStepEnabled !== undefined) {
    subset.gridStepEnabled = appState.gridStepEnabled;
  }
  if (appState.gridModeEnabled !== undefined) {
    subset.gridModeEnabled = appState.gridModeEnabled;
  }
  return subset;
}

/**
 * Rewrite id references (§3.4): `boundElements[].id`, `containerId`,
 * `startBinding.elementId`, `endBinding.elementId`. `groupIds` stay untouched.
 */
function remapReferences(el, idMap) {
  if (!idMap || idMap.size === 0) return el;
  let next = el;
  if (next.containerId && idMap.has(next.containerId)) {
    next = { ...next, containerId: idMap.get(next.containerId) };
  }
  if (Array.isArray(next.boundElements) && next.boundElements.some((be) => idMap.has(be.id))) {
    next = {
      ...next,
      boundElements: next.boundElements.map((be) =>
        idMap.has(be.id) ? { ...be, id: idMap.get(be.id) } : be
      ),
    };
  }
  for (const key of ["startBinding", "endBinding"]) {
    const binding = next[key];
    if (binding && binding.elementId && idMap.has(binding.elementId)) {
      next = { ...next, [key]: { ...binding, elementId: idMap.get(binding.elementId) } };
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// text measurement / bound-text ("label") layout
//
// Labels are laid out by the library itself: a synthetic container (same id and
// geometry, carrying `label`) is run through `convertToExcalidrawElements`, and
// the resulting bound text element (measured, wrapped, positioned — including
// the container auto-grow) is kept.

function labelSpecFrom(raw) {
  if (typeof raw === "string") return { text: raw };
  if (raw && typeof raw === "object") {
    return { ...raw, text: raw.text != null ? String(raw.text) : "" };
  }
  return { text: "" };
}

function measureTextElement(props) {
  const [el] = convertToExcalidrawElements(
    [
      {
        type: "text",
        text: props.text ?? "",
        originalText: props.originalText ?? props.text ?? "",
        x: 0,
        y: 0,
        ...(props.fontSize != null ? { fontSize: props.fontSize } : {}),
        ...(props.fontFamily != null ? { fontFamily: props.fontFamily } : {}),
        ...(props.textAlign != null ? { textAlign: props.textAlign } : {}),
        ...(props.verticalAlign != null ? { verticalAlign: props.verticalAlign } : {}),
      },
    ],
    { regenerateIds: false }
  );
  return el;
}

const LABELABLE_TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow"]);

function labelTextGeometry(container, textProps) {
  const synthetic = {
    type: container.type,
    id: container.id,
    x: container.x,
    y: container.y,
    angle: container.angle ?? 0,
    strokeColor: container.strokeColor,
    label: { ...textProps },
  };
  if (container.type === "arrow" || container.type === "line") {
    if (Array.isArray(container.points) && container.points.length >= 2) {
      synthetic.points = container.points.map((pt) => [...pt]);
    } else {
      synthetic.width = container.width;
      synthetic.height = container.height;
    }
  } else {
    synthetic.width = container.width;
    synthetic.height = container.height;
  }
  if (LABELABLE_TYPES.has(container.type)) {
    const out = convertToExcalidrawElements([synthetic], { regenerateIds: false });
    const text = out.find((e) => e.type === "text");
    const convContainer = out.find((e) => e.id === container.id);
    if (text) {
      return {
        text,
        containerSize: convContainer
          ? { width: convContainer.width, height: convContainer.height }
          : null,
      };
    }
  }
  // Fallback for types the converter cannot label (line, freedraw, …):
  // measure a standalone text and center it on the container.
  const measured = measureTextElement(textProps);
  const width = container.width ?? 0;
  const height = container.height ?? 0;
  return {
    text: {
      ...measured,
      x: container.x + (width - measured.width) / 2,
      y: container.y + (height - measured.height) / 2,
      angle: container.angle ?? 0,
      containerId: container.id,
    },
    containerSize: null,
  };
}

function findBoundTextIndex(list, containerId) {
  return list.findIndex(
    (e) => e.type === "text" && e.containerId === containerId && !e.isDeleted
  );
}

/** Create or rewrite the bound text (`label`) of a shape. */
function upsertBoundText(list, containerId, spec) {
  const cIdx = list.findIndex((e) => e.id === containerId);
  if (cIdx < 0) throw new Error(`apply-ops: no element with id "${containerId}"`);
  const container = list[cIdx];
  const tIdx = findBoundTextIndex(list, containerId);
  const existingText = tIdx >= 0 ? list[tIdx] : null;
  const rawText = spec.text ?? "";
  const inherit = (key) => (spec[key] != null ? spec[key] : existingText ? existingText[key] : undefined);
  const textProps = {
    text: rawText,
    originalText: rawText,
    fontSize: inherit("fontSize"),
    fontFamily: inherit("fontFamily"),
    textAlign: inherit("textAlign"),
    verticalAlign: inherit("verticalAlign"),
  };
  const { text: laidOut, containerSize } = labelTextGeometry(container, textProps);
  const next = [...list];

  let nextContainer = container;
  if (
    containerSize &&
    container.type !== "arrow" &&
    container.type !== "line"
  ) {
    // The library grows containers to fit their label — mirror that.
    const width = Math.max(container.width ?? 0, containerSize.width ?? 0);
    const height = Math.max(container.height ?? 0, containerSize.height ?? 0);
    if (width !== (container.width ?? 0) || height !== (container.height ?? 0)) {
      nextContainer = touch(container, { width, height });
    }
  }

  if (existingText) {
    next[tIdx] = touch(existingText, {
      text: laidOut.text,
      originalText: laidOut.originalText ?? rawText,
      width: laidOut.width,
      height: laidOut.height,
      x: laidOut.x,
      y: laidOut.y,
      angle: laidOut.angle ?? existingText.angle,
      fontSize: laidOut.fontSize,
      fontFamily: laidOut.fontFamily,
      textAlign: laidOut.textAlign,
      verticalAlign: laidOut.verticalAlign,
      lineHeight: laidOut.lineHeight,
    });
  } else {
    const textId = laidOut.id || newId();
    next.push({
      ...laidOut,
      id: textId,
      containerId: containerId,
    });
    nextContainer = touch(nextContainer, {
      boundElements: (nextContainer.boundElements || [])
        .filter((be) => be.type !== "text")
        .concat({ type: "text", id: textId }),
    });
  }
  if (nextContainer !== container) next[cIdx] = nextContainer;
  return next;
}

function removeBoundText(list, containerId) {
  return list
    .filter((el) => !(el.type === "text" && el.containerId === containerId && !el.isDeleted))
    .map((el) => {
      if (
        el.id === containerId &&
        Array.isArray(el.boundElements) &&
        el.boundElements.some((be) => be.type === "text")
      ) {
        return touch(el, {
          boundElements: el.boundElements.filter((be) => be.type !== "text"),
        });
      }
      return el;
    });
}

// ---------------------------------------------------------------------------
// geometry repair
//
// `convertToExcalidrawElements` leaves `x`/`y` unset on arrows bound to other
// elements and can leave a bound label at `x: null`. Explicit finite geometry
// keeps rendering, export bounds and the semantic projection correct.

function centerOfEl(el) {
  return {
    x: (el.x ?? 0) + (el.width ?? 0) / 2,
    y: (el.y ?? 0) + (el.height ?? 0) / 2,
  };
}

/** Absolute midpoint of a linear element (first->last point). */
function midOfLinear(el) {
  const pts = Array.isArray(el.points) && el.points.length ? el.points : [[0, 0], [0, 0]];
  const first = pts[0];
  const last = pts[pts.length - 1];
  return {
    x: (el.x ?? 0) + (first[0] + last[0]) / 2,
    y: (el.y ?? 0) + (first[1] + last[1]) / 2,
  };
}

function anchorOf(el) {
  return Array.isArray(el.points) ? midOfLinear(el) : centerOfEl(el);
}

/**
 * Point where the segment from a shape's center toward `toward` leaves the
 * shape's outline (rectangle / ellipse / diamond slabs).
 */
function outlinePoint(shape, toward) {
  const c = centerOfEl(shape);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return c;
  const halfW = Math.max((shape.width ?? 0) / 2, 0.5);
  const halfH = Math.max((shape.height ?? 0) / 2, 0.5);
  let t;
  if (shape.type === "ellipse") {
    t = 1 / Math.sqrt((dx / halfW) ** 2 + (dy / halfH) ** 2);
  } else if (shape.type === "diamond") {
    t = 1 / (Math.abs(dx) / halfW + Math.abs(dy) / halfH);
  } else {
    t = Math.min(
      dx !== 0 ? halfW / Math.abs(dx) : Infinity,
      dy !== 0 ? halfH / Math.abs(dy) : Infinity
    );
  }
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/**
 * Give a bound arrow explicit geometry spanning its bound shapes edge to edge
 * and move its bound label to the arrow midpoint. Bindings are normalized to
 * `focus: 0, gap: 1`: the converter can emit focus values outside [-1, 1] from
 * an arrow's stub coordinates, and Excalidraw re-resolves bound endpoints from
 * focus/gap on the next re-route — inconsistent values detach arrow ends. No-op
 * for arrows without bindings.
 */
function rerouteArrow(list, arrowId) {
  const aIdx = list.findIndex((e) => e.id === arrowId);
  if (aIdx < 0) return list;
  const arrow = list[aIdx];
  const byId = new Map(list.map((e) => [e.id, e]));
  const startEl = arrow.startBinding ? byId.get(arrow.startBinding.elementId) : null;
  const endEl = arrow.endBinding ? byId.get(arrow.endBinding.elementId) : null;
  if (!startEl && !endEl) return list;

  const hasPos = Number.isFinite(arrow.x) && Number.isFinite(arrow.y);
  const pts = Array.isArray(arrow.points) && arrow.points.length ? arrow.points : [[0, 0], [0, 0]];
  const absFirst = hasPos ? { x: arrow.x + pts[0][0], y: arrow.y + pts[0][1] } : null;
  const absLast = hasPos
    ? { x: arrow.x + pts[pts.length - 1][0], y: arrow.y + pts[pts.length - 1][1] }
    : null;

  const c0 = startEl ? centerOfEl(startEl) : null;
  const c1 = endEl ? centerOfEl(endEl) : null;
  const p0 = startEl ? outlinePoint(startEl, c1 ?? absLast ?? c0) : absFirst ?? c1 ?? { x: 0, y: 0 };
  const p1 = endEl ? outlinePoint(endEl, c0 ?? absFirst ?? c1) : absLast ?? p0;

  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const norm = (el) => ({ elementId: el.id, focus: 0, gap: 1 });
  const out = [...list];
  out[aIdx] = touch(arrow, {
    x: p0.x,
    y: p0.y,
    points: [
      [0, 0],
      [dx, dy],
    ],
    width: Math.abs(dx),
    height: Math.abs(dy),
    ...(startEl ? { startBinding: norm(startEl) } : {}),
    ...(endEl ? { endBinding: norm(endEl) } : {}),
  });

  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  return out.map((el) => {
    if (el.type !== "text" || el.containerId !== arrowId) return el;
    return touch(el, { x: mid.x - (el.width ?? 0) / 2, y: mid.y - (el.height ?? 0) / 2 });
  });
}

/**
 * Final geometry pass (§3.4): every element gets finite `x`/`y`; bound texts
 * without a position are centered on their container. Export bounds and the
 * semantic projection rely on this.
 */
export function repairGeometry(list) {
  let out = list;
  for (const el of list) {
    if (el.type === "arrow" && (!Number.isFinite(el.x) || !Number.isFinite(el.y))) {
      out = rerouteArrow(out, el.id);
    }
  }
  const byId = new Map(out.map((e) => [e.id, e]));
  return out.map((el) => {
    if (Number.isFinite(el.x) && Number.isFinite(el.y)) return el;
    if (el.type === "text" && el.containerId && byId.has(el.containerId)) {
      const anchor = anchorOf(byId.get(el.containerId));
      return touch(el, { x: anchor.x - (el.width ?? 0) / 2, y: anchor.y - (el.height ?? 0) / 2 });
    }
    return touch(el, { x: 0, y: 0 });
  });
}

// ---------------------------------------------------------------------------
// arrow (re)binding

const BINDABLE_TYPES = new Set(["rectangle", "ellipse", "diamond", "image", "text"]);

function rebind(list, arrowId, which, target) {
  const bindingKey = which === "start" ? "startBinding" : "endBinding";
  const aIdx = list.findIndex((e) => e.id === arrowId);
  if (aIdx < 0) throw new Error(`apply-ops: no element with id "${arrowId}"`);
  const arrow = list[aIdx];
  if (arrow.type !== "arrow" && arrow.type !== "line") {
    throw new Error(
      `apply-ops: "${which}"/"end" bindings only apply to arrows and lines (element "${arrowId}" is a ${arrow.type})`
    );
  }
  const next = [...list];
  const previous = arrow[bindingKey];
  if (previous && previous.elementId) {
    const pIdx = next.findIndex((e) => e.id === previous.elementId);
    if (pIdx >= 0) {
      const prev = next[pIdx];
      const boundElements = (prev.boundElements || []).filter(
        (be) => !(be.id === arrowId && be.type === "arrow")
      );
      next[pIdx] = touch(prev, {
        boundElements: boundElements.length ? boundElements : null,
      });
    }
  }
  if (!target || target.id == null) {
    next[aIdx] = touch(arrow, { [bindingKey]: null });
    return next;
  }
  const tIdx = next.findIndex((e) => e.id === target.id);
  if (tIdx < 0) throw new Error(`apply-ops: cannot bind to missing element "${target.id}"`);
  const targetEl = next[tIdx];
  if (!BINDABLE_TYPES.has(targetEl.type)) {
    throw new Error(
      `apply-ops: cannot bind to element "${target.id}" of type "${targetEl.type}"`
    );
  }
  next[aIdx] = touch(arrow, {
    [bindingKey]: {
      elementId: targetEl.id,
      focus: Number.isFinite(target.focus) ? target.focus : previous?.focus ?? 0,
      gap: Number.isFinite(target.gap) ? target.gap : previous?.gap ?? 1,
    },
  });
  const boundElements = targetEl.boundElements || [];
  next[tIdx] = touch(targetEl, {
    boundElements: boundElements.some((be) => be.id === arrowId && be.type === "arrow")
      ? [...boundElements]
      : [...boundElements, { id: arrowId, type: "arrow" }],
  });
  return next;
}

// ---------------------------------------------------------------------------
// ops

function applyAdd(elements, op, results) {
  const inputs = Array.isArray(op.elements) ? op.elements : null;
  if (!inputs || inputs.length === 0) {
    throw new Error('apply-ops: add: "elements" must be a non-empty array');
  }
  const sceneIds = new Set(elements.map((e) => e.id));
  const taken = new Set(sceneIds);

  // Pass 1: decide the final id of every requested element. Explicit ids
  // survive; on collision the new element gets a fresh id and every reference
  // is rewritten below.
  const plan = [];
  for (const skeleton of inputs) {
    if (!skeleton || typeof skeleton !== "object" || typeof skeleton.type !== "string") {
      throw new Error('apply-ops: add: every element needs a string "type"');
    }
    const requestedId =
      typeof skeleton.id === "string" && skeleton.id ? skeleton.id : null;
    let finalId = requestedId || newId();
    let renamedFrom = null;
    if (taken.has(finalId)) {
      renamedFrom = requestedId;
      finalId = newId();
    }
    taken.add(finalId);
    plan.push({ skeleton, requestedId, finalId, renamedFrom });
  }
  const idMap = new Map();
  for (const p of plan) {
    if (p.renamedFrom) idMap.set(p.renamedFrom, p.finalId);
  }
  const batchIds = new Set(plan.map((p) => p.finalId));
  const resolveId = (id) => (id != null && idMap.get(id)) || id;

  // Pass 2: normalize skeletons for the converter. In-batch binding targets are
  // wired by the library during conversion; targets outside the batch (existing
  // scene elements) are deferred to the repair pass below.
  const bindingRepairs = []; // {arrowId, which, targetId, focus, gap, mode}
  const convertSkeletons = [];
  for (const p of plan) {
    const copy = { ...p.skeleton, id: p.finalId };
    if (idMap.size) {
      // Explicit-id remap before conversion (§3.4 reference rewrite).
      if (copy.containerId) copy.containerId = resolveId(copy.containerId);
      if (Array.isArray(copy.boundElements)) {
        copy.boundElements = copy.boundElements.map((be) =>
          idMap.has(be.id) ? { ...be, id: idMap.get(be.id) } : be
        );
      }
    }
    for (const which of ["start", "end"]) {
      const bindingKey = which === "start" ? "startBinding" : "endBinding";
      const raw = copy[which] != null ? copy[which] : copy[bindingKey];
      if (raw == null) continue;
      const rawTargetId = raw.id ?? raw.elementId ?? null;
      const targetId = rawTargetId != null ? resolveId(rawTargetId) : null;
      const focus = raw.focus;
      const gap = raw.gap;
      if (targetId == null) {
        // Inline-created target (`{type, x, y, …}` without an id) — the
        // library creates and binds it during conversion.
        continue;
      }
      const keep = { id: targetId };
      if (raw.type != null) keep.type = raw.type;
      if (raw.x != null) keep.x = raw.x;
      if (raw.y != null) keep.y = raw.y;
      if (raw.width != null) keep.width = raw.width;
      if (raw.height != null) keep.height = raw.height;
      if (batchIds.has(targetId)) {
        // Same batch: the library wires this during conversion (verified later).
        copy[which] = keep;
        delete copy[bindingKey];
        bindingRepairs.push({ arrowId: p.finalId, which, targetId, focus, gap, mode: "verify" });
        continue;
      }
      if (sceneIds.has(targetId)) {
        // Existing scene element — invisible to the converter; bind manually.
        delete copy[which];
        delete copy[bindingKey];
        bindingRepairs.push({ arrowId: p.finalId, which, targetId, focus, gap, mode: "repair" });
        continue;
      }
      // Neither in the batch nor in the scene: an inline-created target that
      // explicitly names its id (the id is remapped onto it after conversion).
      if (raw.type != null) {
        copy[which] = keep;
        delete copy[bindingKey];
        bindingRepairs.push({ arrowId: p.finalId, which, targetId, focus, gap, mode: "inline" });
        continue;
      }
      throw new Error(
        `apply-ops: add: ${which} binding target "${targetId}" does not exist`
      );
    }
    convertSkeletons.push(copy);
  }

  let converted = convertToExcalidrawElements(convertSkeletons, { regenerateIds: false });

  // Remap library-generated ids of inline-created binding targets to the
  // requested ids (§3.4: "remap generated ids to the requested ids").
  const byId = (list) => new Map(list.map((e) => [e.id, e]));
  let convertedById = byId(converted);
  const renameMap = new Map();
  for (const repair of bindingRepairs) {
    if (repair.mode !== "inline") continue;
    const arrow = convertedById.get(repair.arrowId);
    const binding = arrow && (repair.which === "start" ? arrow.startBinding : arrow.endBinding);
    const createdId = binding && binding.elementId;
    if (!createdId) continue;
    if (createdId === repair.targetId) continue;
    const wanted = repair.targetId;
    if (
      convertedById.has(wanted) ||
      sceneIds.has(wanted) ||
      [...renameMap.values()].includes(wanted)
    ) {
      // Requested id is taken — keep the generated one as the binding target.
      repair.targetId = createdId;
      continue;
    }
    renameMap.set(createdId, wanted);
  }
  if (renameMap.size) {
    converted = converted.map((el) =>
      remapReferences(renameMap.has(el.id) ? { ...el, id: renameMap.get(el.id) } : el, renameMap)
    );
    convertedById = byId(converted);
    for (const repair of bindingRepairs) {
      if (repair.mode !== "inline") continue;
      const arrow = convertedById.get(repair.arrowId);
      const binding = arrow && (repair.which === "start" ? arrow.startBinding : arrow.endBinding);
      if (binding && binding.elementId && renameMap.has(binding.elementId)) {
        repair.targetId = renameMap.get(binding.elementId);
      }
    }
  }

  let combined = [...elements, ...converted];

  // Verify (and if needed repair) every binding that was recorded above.
  for (const repair of bindingRepairs) {
    const arrow = combined.find((e) => e.id === repair.arrowId);
    const binding = arrow && (repair.which === "start" ? arrow.startBinding : arrow.endBinding);
    if (binding && binding.elementId === repair.targetId) continue; // library did it
    if (repair.mode === "inline" && !combined.some((e) => e.id === repair.targetId)) {
      continue; // converter did not create the target — nothing to bind to
    }
    combined = rebind(combined, repair.arrowId, repair.which, {
      id: repair.targetId,
      focus: repair.focus,
      gap: repair.gap,
    });
  }

  // Bound arrows need explicit geometry: the converter leaves x/y unset.
  for (const p of plan) {
    if (combined.some((e) => e.id === p.finalId && e.type === "arrow")) {
      combined = rerouteArrow(combined, p.finalId);
    }
  }

  // Labels the converter could not create (unsupported container types, …).
  for (const p of plan) {
    if (p.skeleton.label == null) continue;
    const spec = labelSpecFrom(p.skeleton.label);
    const hasBoundText = findBoundTextIndex(combined, p.finalId) >= 0;
    if (spec.text === "") {
      if (hasBoundText) combined = removeBoundText(combined, p.finalId);
      continue;
    }
    if (!hasBoundText) combined = upsertBoundText(combined, p.finalId, spec);
  }

  results.push({ op: "add", ids: plan.map((p) => p.finalId) });
  return combined;
}

function applyUpdate(elements, op, results, removedIds) {
  const { id, changes } = op;
  if (typeof id !== "string" || !id) {
    throw new Error('apply-ops: update: "id" must be a non-empty string');
  }
  if (!changes || typeof changes !== "object") {
    throw new Error('apply-ops: update: "changes" must be an object');
  }
  if (removedIds.has(id)) {
    throw new Error(`apply-ops: update: element "${id}" was deleted by a previous op`);
  }
  let list = [...elements];
  let idx = list.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error(`apply-ops: update: no element with id "${id}"`);

  // Plain field merge; reserved keys are handled explicitly below.
  const RESERVED = new Set([
    "id",
    "label",
    "text",
    "start",
    "end",
    "startBinding",
    "endBinding",
    "version",
    "versionNonce",
    "updated",
    "index",
    "isDeleted",
  ]);
  const merged = { ...list[idx] };
  for (const [key, value] of Object.entries(changes)) {
    if (RESERVED.has(key)) continue;
    merged[key] = value;
  }
  list[idx] = touch(merged, {});
  const el = list[idx];

  // Text content: `label` on a shape (create/update bound text), `text` on a
  // text element (standalone or bound), `text` on a shape = label shorthand.
  if (el.type === "text") {
    const newText =
      changes.text !== undefined
        ? String(changes.text)
        : changes.label !== undefined
        ? labelSpecFrom(changes.label).text
        : null;
    if (newText !== null) {
      if (el.containerId) {
        list = upsertBoundText(list, el.containerId, {
          text: newText,
          fontSize: el.fontSize,
          fontFamily: el.fontFamily,
          textAlign: el.textAlign,
          verticalAlign: el.verticalAlign,
        });
      } else {
        const measured = measureTextElement({
          text: newText,
          originalText: newText,
          fontSize: el.fontSize,
          fontFamily: el.fontFamily,
          textAlign: el.textAlign,
          verticalAlign: el.verticalAlign,
        });
        idx = list.findIndex((e) => e.id === id);
        list[idx] = touch(list[idx], {
          text: measured.text,
          originalText: measured.originalText ?? newText,
          width: list[idx].autoResize === false ? list[idx].width : measured.width,
          height: measured.height,
        });
      }
    }
  } else {
    const labelSpec =
      changes.label !== undefined
        ? labelSpecFrom(changes.label)
        : changes.text !== undefined
        ? labelSpecFrom(changes.text)
        : null;
    if (labelSpec) {
      list =
        labelSpec.text === ""
          ? removeBoundText(list, id)
          : upsertBoundText(list, id, labelSpec);
    } else {
      // Keep an existing label in place when the container's geometry moved.
      const geometryChanged = ["x", "y", "width", "height", "angle", "points"].some(
        (key) => key in changes
      );
      const tIdx = findBoundTextIndex(list, id);
      if (geometryChanged && tIdx >= 0) {
        const boundText = list[tIdx];
        list = upsertBoundText(list, id, {
          text: boundText.originalText ?? boundText.text,
          fontSize: boundText.fontSize,
          fontFamily: boundText.fontFamily,
          textAlign: boundText.textAlign,
          verticalAlign: boundText.verticalAlign,
        });
      }
    }
  }

  // Arrow re-binding: `start`/`end` `{id}` or `startBinding`/`endBinding`
  // `{elementId, focus, gap}`; `null` unbinds.
  for (const which of ["start", "end"]) {
    const bindingKey = which === "start" ? "startBinding" : "endBinding";
    if (!(which in changes) && !(bindingKey in changes)) continue;
    const raw = changes[which] !== undefined ? changes[which] : changes[bindingKey];
    const target =
      raw == null
        ? null
        : {
            id: raw.id ?? raw.elementId ?? null,
            focus: raw.focus,
            gap: raw.gap,
          };
    list = rebind(list, id, which, target && target.id != null ? target : null);
  }

  // Bound arrows follow their shapes / bindings; updateScene does not re-route
  // them, so do it explicitly.
  const geometryMoved = ["x", "y", "width", "height", "angle"].some((k) => k in changes);
  const rebound = ["start", "end", "startBinding", "endBinding"].some((k) => k in changes);
  const rerouteIds = [];
  if (el.type === "arrow" && rebound) rerouteIds.push(el.id);
  if (geometryMoved) {
    for (const e of list) {
      if (e.type !== "arrow") continue;
      if (
        (e.startBinding && e.startBinding.elementId === id) ||
        (e.endBinding && e.endBinding.elementId === id)
      ) {
        rerouteIds.push(e.id);
      }
    }
  }
  for (const arrowId of rerouteIds) list = rerouteArrow(list, arrowId);

  results.push({ op: "update", id });
  return list;
}

function applyDelete(elements, op, results, removedIds) {
  const ids = Array.isArray(op.ids)
    ? op.ids.filter((x) => typeof x === "string" && x)
    : null;
  if (!ids || ids.length === 0) {
    throw new Error('apply-ops: delete: "ids" must be a non-empty array of strings');
  }
  const idSet = new Set();
  for (const id of ids) {
    if (!removedIds.has(id) && !elements.some((e) => e.id === id)) {
      throw new Error(`apply-ops: delete: no element with id "${id}"`);
    }
    idSet.add(id);
  }
  // Cascade: texts bound to deleted containers go with their container.
  for (const el of elements) {
    if (!idSet.has(el.id) && el.containerId && idSet.has(el.containerId)) {
      idSet.add(el.id);
    }
  }
  for (const id of idSet) removedIds.add(id);

  // Remove the ids and detach bound texts/bindings that referenced them.
  const next = [];
  for (const el of elements) {
    if (idSet.has(el.id)) continue;
    let out = el;
    if (out.frameId && idSet.has(out.frameId)) out = { ...out, frameId: null };
    if (out.containerId && idSet.has(out.containerId)) {
      out = { ...out, containerId: null };
    }
    if (
      Array.isArray(out.boundElements) &&
      out.boundElements.some((be) => idSet.has(be.id))
    ) {
      out = {
        ...out,
        boundElements: out.boundElements.filter((be) => !idSet.has(be.id)),
      };
    }
    for (const key of ["startBinding", "endBinding"]) {
      const binding = out[key];
      if (binding && binding.elementId && idSet.has(binding.elementId)) {
        out = { ...out, [key]: null };
      }
    }
    next.push(out === el ? el : touch(out, {}));
  }
  results.push({ op: "delete", ids });
  return next;
}

// ---------------------------------------------------------------------------
// RPC entry points

/** `get-scene` RPC (§3.4): the live scene, authoritative. */
export function handleGetScene(excalidrawAPI) {
  return {
    elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
    appState: toSubset(excalidrawAPI.getAppState()),
  };
}

/**
 * `apply-ops` RPC (§3.4). Applies the ops in order, pushes the result through
 * `updateScene({ commitToHistory: true })` and returns
 * `{ elements, appState, results }` with the FULL new element list.
 *
 * The returned elements are read back from the scene after `updateScene` (which
 * normalizes fractional indices) so that the follow-up `scene-update` from
 * `onChange` hashes identically and the server's echo suppression (§3.4) works.
 */
export function handleApplyOps(excalidrawAPI, params) {
  const ops = Array.isArray(params?.ops) ? params.ops : null;
  if (!ops || ops.length === 0) {
    throw new Error('apply-ops: "ops" must be a non-empty array');
  }
  let elements = [...excalidrawAPI.getSceneElementsIncludingDeleted()];
  const results = [];
  const removedIds = new Set();
  for (const op of ops) {
    switch (op && op.op) {
      case "add":
        elements = applyAdd(elements, op, results);
        break;
      case "update":
        elements = applyUpdate(elements, op, results, removedIds);
        break;
      case "delete":
        elements = applyDelete(elements, op, results, removedIds);
        break;
      default:
        throw new Error(`apply-ops: unknown op "${op && op.op}"`);
    }
  }
  elements = repairGeometry(elements);
  const appStateSubset = toSubset(excalidrawAPI.getAppState());
  excalidrawAPI.updateScene({
    elements,
    appState: appStateSubset,
    commitToHistory: true,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return {
    elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
    appState: appStateSubset,
    results,
  };
}
