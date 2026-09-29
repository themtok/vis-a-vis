import React, { useState } from "react";

// Save-as dialog — contract §6.4: name input + validation message; warns when
// overwriting an existing name. Name rules (§2.3): trimmed, `[a-z0-9._-]`,
// 1–64 chars, no path separators, no `..`.
const NAME_RE = /^[a-z0-9._-]{1,64}$/;

function validateName(raw) {
  const name = (raw || "").trim();
  if (!name) return { name, error: "Enter a name." };
  if (name.includes("..")) return { name, error: "Name must not contain \"..\"." };
  if (!NAME_RE.test(name)) {
    return {
      name,
      error: "Only lowercase letters, digits and . _ - are allowed (1–64 characters).",
    };
  }
  return { name, error: null };
}

export default function SaveAsDialog({ currentName, existingNames, serverError, onSubmit, onClose }) {
  const [value, setValue] = useState(currentName && !currentName.match(/-\w{4}$/) ? currentName : "");
  const { name, error } = validateName(value);
  const overwrites =
    !error && existingNames.includes(name) && name !== currentName;

  return (
    <div className="vis-modal__backdrop">
      <div className="vis-modal" role="dialog" aria-modal="true">
        <h2 className="vis-modal__title">Save as…</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!error) onSubmit(name);
          }}
        >
          <input
            className="vis-input"
            type="text"
            autoFocus
            placeholder="diagram-name"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {error ? (
            <p className="vis-modal__hint vis-modal__hint--error">{error}</p>
          ) : overwrites ? (
            <p className="vis-modal__hint vis-modal__hint--warn">
              ⚠ “{name}” already exists — saving will overwrite it.
            </p>
          ) : (
            <p className="vis-modal__hint">Lowercase letters, digits and . _ - — 1–64 characters.</p>
          )}
          {serverError ? (
            <p className="vis-modal__hint vis-modal__hint--error">{serverError}</p>
          ) : null}
          <div className="vis-modal__actions">
            <button type="submit" className="vis-btn vis-btn--primary" disabled={!!error}>
              Save
            </button>
            <button type="button" className="vis-btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
