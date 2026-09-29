import React, { useState } from "react";

// Status chip + vis-a-vis menu — contract §6.1 (chip copy rules) and §6.2
// (menu buttons, `Recent ▾` with the two labeled groups). Floating top-right,
// non-blocking.

function fmtClock(iso) {
  if (!iso) return "--:--";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function chipText(diagram, dirty) {
  if (!diagram) return "— no diagram —";
  const { name, isSaved, savedAt } = diagram;
  if (!isSaved) {
    return dirty ? `⚠ ${name} — not saved · unsaved changes` : `⚠ ${name} — not saved`;
  }
  if (dirty) return `${name} · unsaved changes`;
  return `✓ ${name} — saved ${fmtClock(savedAt)}`;
}

export default function TopBar({
  diagram,
  dirty,
  wsStatus,
  recent,
  onNew,
  onOpenDialog,
  onSave,
  onSaveAs,
  onVersions,
  onRecentToggle,
  onPickRecent,
}) {
  const [recentOpen, setRecentOpen] = useState(false);
  const toggleRecent = () => {
    const next = !recentOpen;
    setRecentOpen(next);
    onRecentToggle(next);
  };

  return (
    <div className="vis-topbar">
      <div className={`vis-chip ${dirty ? "vis-chip--dirty" : ""}`}>
        {chipText(diagram, dirty)}
      </div>
      {wsStatus !== "open" ? (
        <div className="vis-chip vis-chip--ws">reconnecting…</div>
      ) : null}
      <div className="vis-menu">
        <button type="button" className="vis-btn" onClick={onNew}>
          New
        </button>
        <button type="button" className="vis-btn" onClick={onOpenDialog}>
          Open…
        </button>
        <button type="button" className="vis-btn" onClick={onSave}>
          Save
        </button>
        <button type="button" className="vis-btn" onClick={onSaveAs}>
          Save as…
        </button>
        <button type="button" className="vis-btn" onClick={onVersions}>
          Versions
        </button>
        <div className="vis-menu__recent">
          <button type="button" className="vis-btn" onClick={toggleRecent}>
            Recent ▾
          </button>
          {recentOpen ? (
            <div className="vis-menu__dropdown">
              <div className="vis-menu__group">Recently opened</div>
              {(recent?.recentOpened || []).length === 0 ? (
                <div className="vis-menu__empty">—</div>
              ) : null}
              {(recent?.recentOpened || []).map((d) => (
                <button
                  key={`opened-${d.id}`}
                  type="button"
                  className="vis-menu__item"
                  onClick={() => {
                    setRecentOpen(false);
                    onPickRecent(d);
                  }}
                >
                  {d.name}
                </button>
              ))}
              <div className="vis-menu__group">Recently edited (unsaved)</div>
              {(recent?.recentUnsaved || []).length === 0 ? (
                <div className="vis-menu__empty">—</div>
              ) : null}
              {(recent?.recentUnsaved || []).map((d) => (
                <button
                  key={`unsaved-${d.id}`}
                  type="button"
                  className="vis-menu__item"
                  onClick={() => {
                    setRecentOpen(false);
                    onPickRecent(d);
                  }}
                >
                  {d.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
