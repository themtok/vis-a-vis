import React from "react";

// Takeover modal — contract §6.8: shown when `welcome.status === "pending"`.
export default function TakeoverModal({ onContinue, onCancel }) {
  return (
    <div className="vis-modal__backdrop">
      <div className="vis-modal" role="dialog" aria-modal="true">
        <p className="vis-modal__text">
          Opening this tab will make the previous tab (session) invalid and this tab
          becomes the active editor.
        </p>
        <div className="vis-modal__actions">
          <button type="button" className="vis-btn vis-btn--primary" onClick={onContinue}>
            Continue
          </button>
          <button type="button" className="vis-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
