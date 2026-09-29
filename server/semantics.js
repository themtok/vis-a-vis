// Semantic analysis + technical projection of Excalidraw scenes (contract §5, §5.1).
// Pure functions: no I/O, no server state.

/**
 * Keep only the AppStateSubset fields that are persisted/synced (contract §3.3).
 */
export function pickAppState(appState) {
  const out = {};
  if (appState && typeof appState === "object") {
    if (appState.viewBackgroundColor !== undefined && appState.viewBackgroundColor !== null) {
      out.viewBackgroundColor = appState.viewBackgroundColor;
    }
    if (appState.gridSize !== undefined && appState.gridSize !== null) {
      out.gridSize = appState.gridSize;
    }
    if (appState.gridStepEnabled !== undefined && appState.gridStepEnabled !== null) {
      out.gridStepEnabled = appState.gridStepEnabled;
    }
    if (appState.gridModeEnabled !== undefined && appState.gridModeEnabled !== null) {
      out.gridModeEnabled = appState.gridModeEnabled;
    }
  }
  return out;
}

export function liveElements(scene) {
  const elements = scene && Array.isArray(scene.elements) ? scene.elements : [];
  return elements.filter((el) => el && !el.isDeleted);
}

export function countElements(scene) {
  return liveElements(scene).length;
}

const POINT_TYPES = new Set(["line", "arrow", "freedraw"]);

function bindingView(binding) {
  if (!binding || typeof binding !== "object" || binding.elementId === undefined || binding.elementId === null) {
    return undefined;
  }
  const out = { elementId: binding.elementId };
  if (typeof binding.focus === "number") out.focus = binding.focus;
  if (typeof binding.gap === "number") out.gap = binding.gap;
  return out;
}

/**
 * Technical projection of a single element (contract §5, `technical.elements`).
 * Only the listed fields are emitted; null/absent/inapplicable fields are omitted.
 */
function projectElement(el) {
  const out = {
    id: el.id,
    type: el.type,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
  };
  if (typeof el.angle === "number") out.angle = el.angle;
  if (el.strokeColor !== undefined && el.strokeColor !== null) out.strokeColor = el.strokeColor;
  if (el.backgroundColor !== undefined && el.backgroundColor !== null) out.backgroundColor = el.backgroundColor;
  if (el.fillStyle !== undefined && el.fillStyle !== null) out.fillStyle = el.fillStyle;
  if (typeof el.strokeWidth === "number") out.strokeWidth = el.strokeWidth;
  if (el.strokeStyle !== undefined && el.strokeStyle !== null) out.strokeStyle = el.strokeStyle;
  if (typeof el.roughness === "number") out.roughness = el.roughness;
  if (typeof el.opacity === "number") out.opacity = el.opacity;
  if (typeof el.text === "string") out.text = el.text;
  if (typeof el.fontSize === "number") out.fontSize = el.fontSize;
  if (typeof el.fontFamily === "number") out.fontFamily = el.fontFamily;
  if (el.textAlign !== undefined && el.textAlign !== null) out.textAlign = el.textAlign;
  if (el.verticalAlign !== undefined && el.verticalAlign !== null) out.verticalAlign = el.verticalAlign;
  if (typeof el.containerId === "string") {
    out.containerId = el.containerId;
    out.labelFor = el.containerId; // mirror of containerId (contract §5)
  }
  const start = bindingView(el.startBinding);
  if (start) out.startBinding = start;
  const end = bindingView(el.endBinding);
  if (end) out.endBinding = end;
  if (POINT_TYPES.has(el.type) && Array.isArray(el.points)) {
    out.points = el.points.map((p) => (Array.isArray(p) ? [p[0] ?? 0, p[1] ?? 0] : [0, 0]));
  }
  if (Array.isArray(el.groupIds) && el.groupIds.length > 0) out.groupIds = el.groupIds;
  if (el.frameId !== undefined && el.frameId !== null) out.frameId = el.frameId;
  if (el.link !== undefined && el.link !== null) out.link = el.link;
  if (el.locked !== undefined && el.locked !== null) out.locked = el.locked;
  if (Array.isArray(el.boundElementIds) && el.boundElementIds.length > 0) out.boundElementIds = el.boundElementIds;
  return out;
}

/**
 * Technical projection of the whole scene (contract §5, `technical`).
 */
export function projectTechnical(scene) {
  return {
    elements: liveElements(scene).map(projectElement),
    appState: pickAppState(scene ? scene.appState : {}),
  };
}

// ---------------------------------------------------------------------------
// Semantic analysis (contract §5.1)
// ---------------------------------------------------------------------------

function classify(el) {
  switch (el.type) {
    case "diamond":
      return "decision";
    case "ellipse":
      return "terminal";
    case "rectangle":
      return el.roundness ? "terminal" : "process";
    case "frame":
      return "container";
    case "arrow":
    case "line":
      return "connector";
    case "freedraw":
      return "sketch";
    case "image":
      return "image";
    case "text":
      return "text";
    default:
      return "other";
  }
}

function elementBounds(el) {
  const width = el.width ?? 0;
  const height = el.height ?? 0;
  // Linear elements anchor at points[0], which sits outside the bounding box
  // when points run negatively — derive the real box from the points.
  if (Array.isArray(el.points) && el.points.length) {
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const p of el.points) {
      const px = p[0] ?? 0;
      const py = p[1] ?? 0;
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
    return {
      x: (el.x ?? 0) + minX,
      y: (el.y ?? 0) + minY,
      width: maxX - minX || width,
      height: maxY - minY || height,
    };
  }
  return { x: el.x ?? 0, y: el.y ?? 0, width, height };
}

function centerOf(el) {
  const b = elementBounds(el);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function bands(center, bounds) {
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const nx = spanX > 0 ? (center.x - bounds.minX) / spanX : 0.5;
  const ny = spanY > 0 ? (center.y - bounds.minY) / spanY : 0.5;
  const xBand = nx < 1 / 3 ? "left" : nx > 2 / 3 ? "right" : "center";
  const yBand = ny < 1 / 3 ? "top" : ny > 2 / 3 ? "bottom" : "center";
  return { nx, ny, xBand, yBand };
}

function whereOf(center, bounds) {
  const { nx, ny, xBand, yBand } = bands(center, bounds);
  if (xBand === "center" && yBand === "center") return "center";
  if (xBand === "center") return yBand;
  if (yBand === "center") return xBand;
  // corner cell: the stronger deviation from the middle wins
  return Math.abs(nx - 0.5) >= Math.abs(ny - 0.5) ? xBand : yBand;
}

function connectorVia(el) {
  return el.type === "line" ? "line" : "arrow";
}

/**
 * Analyze a scene into the semantic description of contract §5.1.
 */
export function analyzeSemantic(scene) {
  const els = liveElements(scene);
  const texts = els.filter((el) => el.type === "text");
  const connectors = els.filter((el) => el.type === "arrow" || el.type === "line");
  const arrows = els.filter((el) => el.type === "arrow");
  const images = els.filter((el) => el.type === "image");

  const byId = new Map(els.map((el) => [el.id, el]));

  // Bound texts are labels of their container shape; standalone texts are notes.
  const labelByTextId = new Map();
  const labelText = new Map(); // shapeId -> text
  for (const t of texts) {
    labelByTextId.set(t.id, typeof t.text === "string" ? t.text : "");
    if (typeof t.containerId === "string" && byId.has(t.containerId)) {
      labelText.set(t.containerId, typeof t.text === "string" ? t.text : "");
    }
  }

  // Components: everything except bound labels. Connector labels travel with the connector.
  const componentEls = els.filter((el) => !(el.type === "text" && typeof el.containerId === "string" && byId.has(el.containerId)));

  const labelOfEl = (el) => {
    if (labelText.has(el.id)) return labelText.get(el.id);
    if (el.type === "text" && typeof el.text === "string") return el.text;
    return "";
  };

  const boundsOf = (() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of els) {
      const b = elementBounds(el);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX, minY, maxX, maxY };
  })();

  // Connector adjacency (undirected) and arrow flow edges (directed).
  const connectorLabel = new Map(); // connectorId -> label text
  for (const c of connectors) {
    connectorLabel.set(c.id, labelText.get(c.id) ?? labelOfEl(c));
  }

  const connectedTo = new Map(); // componentId -> entry[]
  const addConnection = (fromEl, toEl, viaEl) => {
    if (!fromEl || !toEl || fromEl.id === toEl.id) return;
    if (!connectedTo.has(fromEl.id)) connectedTo.set(fromEl.id, []);
    connectedTo.get(fromEl.id).push({
      id: toEl.id,
      via: connectorVia(viaEl),
      label: connectorLabel.get(viaEl.id) ?? "",
    });
  };
  for (const c of connectors) {
    const start = c.startBinding && byId.get(c.startBinding.elementId);
    const end = c.endBinding && byId.get(c.endBinding.elementId);
    addConnection(start, end, c);
    addConnection(end, start, c);
    // The connector itself lists its anchored endpoints.
    if (!connectedTo.has(c.id)) connectedTo.set(c.id, []);
    for (const bound of [start, end]) {
      if (bound && bound.id !== c.id) {
        connectedTo.get(c.id).push({
          id: bound.id,
          via: connectorVia(c),
          label: connectorLabel.get(c.id) ?? "",
        });
      }
    }
  }

  // Directed flow graph over components, following arrow bindings start -> end.
  const outEdges = new Map(); // id -> [targetId...]
  const inCount = new Map();
  const outCount = new Map();
  const flowEdge = (a, b) => {
    if (!a || !b || a.id === b.id) return;
    if (!outEdges.has(a.id)) outEdges.set(a.id, []);
    outEdges.get(a.id).push(b.id);
    outCount.set(a.id, (outCount.get(a.id) ?? 0) + 1);
    inCount.set(b.id, (inCount.get(b.id) ?? 0) + 1);
  };
  for (const a of arrows) {
    const start = a.startBinding && byId.get(a.startBinding.elementId);
    const end = a.endBinding && byId.get(a.endBinding.elementId);
    flowEdge(start, end);
  }

  const isBreak = (id) => (inCount.get(id) ?? 0) !== 1 || (outCount.get(id) ?? 0) !== 1;
  const usedEdges = new Set();
  const edgeKey = (a, b) => `${a}->${b}`;
  const flows = [];

  const grow = (startId, secondId) => {
    const chain = [startId];
    const seen = new Set([startId]);
    let cur = startId;
    let next = secondId;
    while (next !== undefined) {
      if (seen.has(next)) break; // cycle guard
      const key = edgeKey(cur, next);
      if (usedEdges.has(key)) break;
      usedEdges.add(key);
      chain.push(next);
      seen.add(next);
      cur = next;
      if (isBreak(cur)) break;
      const outs = outEdges.get(cur) ?? [];
      // interior nodes have exactly one out edge
      next = outs.length === 1 ? outs[0] : undefined;
    }
    if (chain.length >= 2) flows.push(chain);
  };

  // Chains start at branch/merge/source nodes ("stopping at branches/merges").
  for (const [id, outs] of outEdges) {
    if (!isBreak(id)) continue;
    for (const target of outs) grow(id, target);
  }
  // Remaining edges belong to pure cycles; start each cycle once.
  for (const [id, outs] of outEdges) {
    for (const target of outs) {
      if (!usedEdges.has(edgeKey(id, target))) grow(id, target);
    }
  }

  // Components projection.
  const components = componentEls.map((el) => {
    const kind = classify(el);
    const comp = {
      id: el.id,
      kind,
      label: labelOfEl(el),
      where: whereOf(centerOf(el), boundsOf),
      position: { x: el.x ?? 0, y: el.y ?? 0 },
      size: { width: el.width ?? 0, height: el.height ?? 0 },
      connectedTo: connectedTo.get(el.id) ?? [],
    };
    return comp;
  });

  // Texts projection (all texts, bound and standalone).
  const textViews = texts.map((t) => ({
    id: t.id,
    text: typeof t.text === "string" ? t.text : "",
    x: t.x ?? 0,
    y: t.y ?? 0,
  }));

  const shapeCount = els.filter(
    (el) => el.type !== "arrow" && el.type !== "line" && el.type !== "text" && el.type !== "image"
  ).length;
  const stats = {
    shapes: shapeCount,
    connectors: connectors.length,
    texts: texts.length,
    images: images.length,
  };

  const summary = buildSummary({ els, components, flows, textViews, stats, byId });

  return { summary, components, flows, texts: textViews, stats };
}

function quoteLabel(label) {
  return label ? `"${label}"` : "";
}

function displayName(component) {
  return component && component.label ? `"${component.label}"` : component.kind;
}

function buildSummary({ els, components, flows, textViews, stats, byId }) {
  if (els.length === 0) return "An empty diagram with no elements.";

  const parts = [];

  const kindCounts = new Map();
  for (const c of components) kindCounts.set(c.kind, (kindCounts.get(c.kind) ?? 0) + 1);
  const PLURALS = { process: "processes", sketch: "sketches" };
  const kindPhrase = [...kindCounts.entries()]
    .map(([kind, n]) => `${n} ${n === 1 ? kind : PLURALS[kind] ?? `${kind}s`}`)
    .join(", ");
  parts.push(`A diagram of ${components.length} component${components.length === 1 ? "" : "s"} (${kindPhrase}) linked by ${stats.connectors} connector${stats.connectors === 1 ? "" : "s"}.`);

  const labeled = components.filter((c) => c.label);
  if (labeled.length > 0) {
    const named = labeled
      .slice(0, 8)
      .map((c) => `${quoteLabel(c.label)} (${c.kind}, ${c.where})`)
      .join(", ");
    parts.push(`Labeled components: ${named}.`);
  }

  // Main flow = longest chain; ties keep the first.
  let main = null;
  for (const flow of flows) {
    if (!main || flow.length > main.length) main = flow;
  }
  if (main) {
    const steps = main.map((id) => {
      const comp = components.find((c) => c.id === id);
      return comp ? displayName(comp) : "component";
    });
    const labeledSteps = main.map((id) => {
      const comp = components.find((c) => c.id === id);
      return comp && comp.label ? comp.label : null;
    });
    const flowDesc = steps.join(" → ");
    parts.push(
      labeledSteps.some(Boolean)
        ? `Main flow: ${flowDesc}.`
        : `Main flow runs ${flowDesc}.`
    );
  }

  const notable = textViews.filter((t) => t.text && t.text.trim()).slice(0, 3);
  if (notable.length > 0) {
    const quotes = notable.map((t) => quoteLabel(t.text.trim().replace(/\s+/g, " ").slice(0, 60))).join(", ");
    parts.push(`Notable text: ${quotes}.`);
  }

  return parts.join(" ");
}
