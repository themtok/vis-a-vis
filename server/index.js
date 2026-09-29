// vis-a-vis server bootstrap (contract §1, §2.1, §2.2).
// NOTE: bundled to CJS by esbuild — no import.meta, no require, and only the
// single `typeof __dirname !== "undefined"` probe allowed by §2.2.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { createStore } from "./store.js";
import { createSessions } from "./sessions.js";
import { createApiRouter } from "./routes.js";
import { createMcpRouter } from "./mcp.js";

const DEFAULT_PORT = 4832;
const MAX_PORT = 4852;
const WEB_FALLBACK_MESSAGE = "web assets not built — run `npm run build`";

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// Contract §2.2: first existing directory wins.
function resolveWebDir(appRoot) {
  const candidates = [
    process.env.VIS_A_VIS_WEB_DIR,
    path.join(appRoot, "dist", "web"),
    typeof __dirname !== "undefined" ? path.join(__dirname, "web") : null,
    path.join(appRoot, "web", "dist"),
  ];
  for (const candidate of candidates) {
    if (candidate && isDirectory(candidate)) return candidate;
  }
  return null;
}

function main() {
  // Contract §2.1: data root.
  const appRoot = process.pkg ? path.dirname(process.execPath) : process.cwd();
  const dataRoot = process.env.VIS_A_VIS_DATA_DIR || path.join(appRoot, "data");
  fs.mkdirSync(path.join(dataRoot, "files"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "versions"), { recursive: true });

  const ctx = {
    appRoot,
    dataRoot,
    host: process.env.VIS_A_VIS_HOST || "127.0.0.1",
    port: null,
    appUrl: null,
  };

  const store = createStore({ dataRoot });
  const sessions = createSessions({ store, ctx });

  const app = express();
  app.use("/mcp", createMcpRouter({ store, sessions, ctx }));
  app.use("/api", createApiRouter({ store, sessions, ctx }));

  const webDir = resolveWebDir(appRoot);
  if (webDir) {
    app.use(express.static(webDir));
    app.get("*", (req, res, next) => {
      if (path.extname(req.path)) {
        next();
        return;
      }
      res.sendFile(path.join(webDir, "index.html"), (err) => {
        if (err) next();
      });
    });
  } else {
    app.use((req, res) => {
      res.status(500).type("text/plain").send(WEB_FALLBACK_MESSAGE);
    });
  }

  const server = http.createServer(app);
  sessions.attachTo(server);

  function tryListen(port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, ctx.host);
    });
  }

  async function start() {
    const envPort = process.env.VIS_A_VIS_PORT ? Number(process.env.VIS_A_VIS_PORT) : null;
    if (envPort) {
      await tryListen(envPort);
      ctx.port = envPort;
    } else {
      let port = DEFAULT_PORT;
      for (;;) {
        try {
          await tryListen(port);
          ctx.port = port;
          break;
        } catch (err) {
          if (err.code !== "EADDRINUSE" || port >= MAX_PORT) throw err;
          port += 1;
        }
      }
    }
    ctx.appUrl = `http://localhost:${ctx.port}/`;
    console.log(`vis-a-vis listening on ${ctx.appUrl}`);
  }

  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

main();
