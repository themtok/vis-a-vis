// `export-image` RPC — contract §3.4. Renders the live scene through Excalidraw's
// own exporters (`exportToBlob` for png, `exportToSvg` for svg) and crops to
// `rect` (scene coordinates) when given.
//
// The export region is the bounding box of the exported elements (plus an
// invisible anchor rectangle that pins the region to `rect` when given), so the
// scene→pixel mapping used for cropping is exact.

import { exportToCanvas, exportToSvg, getCommonBounds } from "@excalidraw/excalidraw";
import { repairGeometry } from "./ops.js";

const FALLBACK_RECT = { x: 0, y: 0, width: 400, height: 300 };

function normalizeRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function overlaps(el, rect) {
  const [x1, y1, x2, y2] = getCommonBounds([el]);
  return (
    x1 < rect.x + rect.width && x2 > rect.x && y1 < rect.y + rect.height && y2 > rect.y
  );
}

/** Invisible rectangle that pins the export bounds to `rect`. */
function makeAnchor(rect) {
  return {
    id: "vis-a-vis-export-anchor",
    type: "rectangle",
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 0,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
  };
}

function cropCanvas(source, bounds, target) {
  const sx = source.width / bounds.width;
  const sy = source.height / bounds.height;
  const cx = (target.x - bounds.x) * sx;
  const cy = (target.y - bounds.y) * sy;
  const cw = target.width * sx;
  const ch = target.height * sy;
  const outW = Math.max(1, Math.round(cw));
  const outH = Math.max(1, Math.round(ch));
  if (
    outW === source.width &&
    outH === source.height &&
    Math.abs(cx) < 0.5 &&
    Math.abs(cy) < 0.5
  ) {
    return source;
  }
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  out.getContext("2d").drawImage(source, cx, cy, cw, ch, 0, 0, outW, outH);
  return out;
}

function canvasToPngBase64(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("PNG encoding failed"));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
        reader.onerror = () => reject(reader.error || new Error("file read failed"));
        reader.readAsDataURL(blob);
      },
      "image/png"
    );
  });
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * `export-image` RPC (§3.4):
 *   params  { format?: "png"|"svg", rect?: {x,y,width,height}|null, scale?: number }
 *   result  { dataBase64, mimeType, width, height }
 */
export async function handleExportImage(excalidrawAPI, params) {
  const format = params?.format === "svg" ? "svg" : "png";
  const scale = Number.isFinite(params?.scale) && params.scale > 0 ? params.scale : 1;
  const rect = normalizeRect(params?.rect);
  // Non-finite x/y (e.g. unpositioned arrow labels) make getCommonBounds NaN —
  // repair before measuring or rendering.
  const elements = repairGeometry(excalidrawAPI.getSceneElements().filter((el) => !el.isDeleted));
  const files = excalidrawAPI.getFiles ? excalidrawAPI.getFiles() : null;
  const appState = excalidrawAPI.getAppState() || {};

  const content = rect ? elements.filter((el) => overlaps(el, rect)) : elements;
  let target = rect;
  if (!target) {
    if (content.length) {
      const [x1, y1, x2, y2] = getCommonBounds(content);
      target = {
        x: x1,
        y: y1,
        width: Math.max(x2 - x1, 1),
        height: Math.max(y2 - y1, 1),
      };
    } else {
      target = { ...FALLBACK_RECT };
    }
  }
  const exportElements = [...content, makeAnchor(target)];
  const [minX, minY, maxX, maxY] = getCommonBounds(exportElements);
  const bounds = {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
  const exportAppState = {
    viewBackgroundColor: appState.viewBackgroundColor ?? "#ffffff",
    exportBackground: true,
    exportWithDarkMode: false,
  };

  if (format === "svg") {
    const svg = await exportToSvg({
      elements: exportElements,
      appState: exportAppState,
      files,
      exportPadding: 0,
    });
    const width = Math.max(1, Math.round(target.width * scale));
    const height = Math.max(1, Math.round(target.height * scale));
    svg.setAttribute(
      "viewBox",
      `${target.x - bounds.x} ${target.y - bounds.y} ${target.width} ${target.height}`
    );
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    const serialized = new XMLSerializer().serializeToString(svg);
    return {
      dataBase64: utf8ToBase64(serialized),
      mimeType: "image/svg+xml",
      width,
      height,
    };
  }

  const source = await exportToCanvas({
    elements: exportElements,
    appState: exportAppState,
    files,
    exportPadding: 0,
    getDimensions: (w, h) => ({
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale)),
      scale,
    }),
  });
  const out = cropCanvas(source, bounds, target);
  return {
    dataBase64: await canvasToPngBase64(out),
    mimeType: "image/png",
    width: out.width,
    height: out.height,
  };
}
