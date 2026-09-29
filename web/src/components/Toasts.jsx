import React from "react";

// Toast stack — contract §6.7: bottom-right, max 4 visible, auto-dismiss 5 s
// (agent toasts 8 s; WS toasts carry their own `ttlMs`).
export default function Toasts({ toasts }) {
  return (
    <div className="vis-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`vis-toast vis-toast--${toast.kind || "info"}`}>
          {toast.kind === "agent" ? <span className="vis-toast__badge">AGENT</span> : null}
          <span className="vis-toast__text">{toast.text}</span>
        </div>
      ))}
    </div>
  );
}
