import React from "react";

// Unsaved-changes dialog — contract §6.5: before New / Open when the diagram is
// dirty: Save / Discard / Cancel.
export default function UnsavedDialog({ onSave, onDiscard, onCancel }) {
  return (
    <div className="vis-modal__backdrop">
      <div className="vis-modal" role="dialog" aria-modal="true">
        <p className="vis-modal__text">You have unsaved changes</p>
        <div className="vis-modal__actions">
          <button type="button" className="vis-btn vis-btn--primary" onClick={onSave}>
            Save
          </button>
          <button type="button" className="vis-btn" onClick={onDiscard}>
            Discard
          </button>
          <button type="button" className="vis-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
