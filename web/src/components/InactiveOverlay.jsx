import React from "react";

// Inactive overlay — contract §6.9: full-window grayed-out overlay after
// `session-invalidated`; pointer events blocked, app unusable, no recovery.
export default function InactiveOverlay({ reason }) {
  const message =
    reason === "taken-over"
      ? "This tab was closed because the diagram is now edited in another tab."
      : "This tab is inactive — the diagram is being edited in another tab.";
  return (
    <div className="vis-inactive-overlay" role="alert">
      <p className="vis-inactive-overlay__message">{message}</p>
    </div>
  );
}
