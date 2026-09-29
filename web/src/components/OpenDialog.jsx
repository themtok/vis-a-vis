import React, { useRef, useState } from "react";

// Open dialog — contract §6.3: list of known diagrams (name, saved badge, last
// opened/edited), a path input (§4 `open {path}`) and `<input type="file">`
// upload (§4 `open {content, fileName}` via FileReader).

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function OpenDialog({ diagrams, loading, error, onOpen, onOpenPath, onUpload, onClose }) {
  const [path, setPath] = useState("");
  const fileRef = useRef(null);
  const list = diagrams?.all || [];

  return (
    <div className="vis-modal__backdrop" onClick={onClose}>
      <div
        className="vis-modal vis-modal--wide"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="vis-modal__title">Open…</h2>

        <div className="vis-open__list">
          {loading ? <p className="vis-modal__hint">Loading…</p> : null}
          {!loading && list.length === 0 ? (
            <p className="vis-modal__hint">No diagrams yet.</p>
          ) : null}
          {list.map((d) => (
            <button
              key={d.id}
              type="button"
              className="vis-open__row"
              onClick={() => onOpen(d)}
            >
              <span className="vis-open__name">{d.name}</span>
              <span className={`vis-badge ${d.isSaved ? "vis-badge--saved" : "vis-badge--unsaved"}`}>
                {d.isSaved ? "saved" : "not saved"}
              </span>
              <span className="vis-open__when">
                opened {fmtWhen(d.lastOpenedAt)} · edited {fmtWhen(d.lastEditedAt)}
              </span>
            </button>
          ))}
        </div>

        <div className="vis-open__upload">
          <input
            ref={fileRef}
            type="file"
            accept=".excalidraw,.json,application/json"
            onChange={(event) => {
              const file = event.target.files && event.target.files[0];
              if (file) onUpload(file);
              event.target.value = "";
            }}
          />
        </div>

        <form
          className="vis-open__path"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) onOpenPath(path.trim());
          }}
        >
          <input
            className="vis-input"
            type="text"
            placeholder="…or an absolute file path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <button type="submit" className="vis-btn vis-btn--primary" disabled={!path.trim()}>
            Open path
          </button>
        </form>

        {error ? <p className="vis-modal__hint vis-modal__hint--error">{error}</p> : null}

        <div className="vis-modal__actions">
          <button type="button" className="vis-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
