// REST client — contract §4.
//
// Every mutating request carries `X-Vis-A-Vis-Tab: <tabId>` (tabId from the WS
// `welcome` message); the server answers 409 NOT_ACTIVE_SESSION when the tab is
// not the active session. Errors arrive as `{"error":{"code","message"}}` and are
// rethrown as `ApiError` (with `code` and `status` attached).

let tabId = null;

export function setTabId(id) {
  tabId = id;
}

export function getTabId() {
  return tabId;
}

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (method !== "GET") {
    init.headers["X-Vis-A-Vis-Tab"] = tabId ?? "";
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. plain-text 500) — handled below.
  }
  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new ApiError(
      err.code || `HTTP_${res.status}`,
      err.message || `${method} ${path} failed (HTTP ${res.status})`,
      res.status
    );
  }
  return data;
}

export const api = {
  status: () => request("GET", "/api/status"),
  listDiagrams: () => request("GET", "/api/diagrams"),
  newDiagram: () => request("POST", "/api/diagrams/new", {}),
  openDiagram: (body) => request("POST", "/api/diagrams/open", body),
  saveDiagram: (name) => request("POST", "/api/diagrams/save", name != null ? { name } : {}),
  listVersions: () => request("GET", "/api/versions"),
  restoreVersion: (id) =>
    request("POST", `/api/versions/${encodeURIComponent(id)}/restore`, {}),
};
