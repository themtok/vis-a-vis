import React from "react";

// Versions drawer — contract §6.6: right side panel, newest first. Each entry
// shows time, kind badge and source badge; agent entries are highlighted
// (violet "AGENT" badge + left border) with their `label`, the element count and
// a Restore button.

function fmtWhen(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function VersionsDrawer({ versions, loading, onRestore, onClose }) {
  return (
    <div className="vis-drawer" role="dialog" aria-label="Versions">
      <div className="vis-drawer__head">
        <h2 className="vis-modal__title">Versions</h2>
        <button type="button" className="vis-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="vis-drawer__list">
        {loading ? <p className="vis-modal__hint">Loading…</p> : null}
        {!loading && (!versions || versions.length === 0) ? (
          <p className="vis-modal__hint">No versions yet.</p>
        ) : null}
        {(versions || []).map((v) => (
          <div
            key={v.id}
            className={`vis-version ${v.isAgent ? "vis-version--agent" : ""}`}
          >
            <div className="vis-version__badges">
              {v.isAgent ? <span className="vis-badge vis-badge--agent">AGENT</span> : null}
              <span className="vis-badge">{v.kind}</span>
              <span className="vis-badge vis-badge--source">{v.source}</span>
            </div>
            <div className="vis-version__meta">
              {fmtWhen(v.createdAt)} · {v.elementCount} element
              {v.elementCount === 1 ? "" : "s"}
            </div>
            <div className="vis-version__label">{v.label}</div>
            <button
              type="button"
              className="vis-btn vis-btn--primary vis-version__restore"
              onClick={() => onRestore(v.id)}
            >
              Restore
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
