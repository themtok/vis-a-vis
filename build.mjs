#!/usr/bin/env node
// vis-a-vis build script.
//   node build.mjs                 -> web bundle (vite), server bundle (esbuild), assets staged
//   node build.mjs --standalone    -> everything above + self-contained binary (pkg, embedded Node)
//   node build.mjs --standalone --target node20-linux-x64
import { build as esbuild } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const standalone = args.includes("--standalone");
const targetIdx = args.indexOf("--target");
const defaultTarget =
  process.platform === "win32"
    ? "node24-win-x64"
    : process.platform === "darwin"
      ? "node24-mac-x64"
      : "node24-linux-x64";
const target = targetIdx >= 0 ? args[targetIdx + 1] : defaultTarget;

const dist = path.join(root, "dist");
const step = (name) => console.log(`\n[build] ${name}`);

// 1. Web client -> web/dist
step("web client (vite)");
execFileSync(
  process.execPath,
  [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "web"],
  { stdio: "inherit", cwd: root },
);

// 2. Server -> dist/server.cjs (single CJS bundle; the packaged binary runs this)
step("server bundle (esbuild)");
await esbuild({
  entryPoints: [path.join(root, "server", "index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.join(dist, "server.cjs"),
  // optional native peer deps of ws; ws falls back to pure JS when missing
  external: ["bufferutil", "utf-8-validate"],
  legalComments: "none",
  logLevel: "info",
});

// 3. Stage web assets next to the server bundle (dist/web) for pkg asset embedding
step("stage web assets (dist/web)");
fs.rmSync(path.join(dist, "web"), { recursive: true, force: true });
fs.cpSync(path.join(root, "web", "dist"), path.join(dist, "web"), { recursive: true });

if (!standalone) {
  console.log("\n[build] done. Run `npm run package` for a standalone binary.");
  process.exit(0);
}

// 4. Standalone binary: embedded Node runtime + embedded web assets
step(`standalone binary (${target})`);
const pkgRoot = path.join(root, "node_modules", "@yao-pkg", "pkg");
const pkgMeta = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
const pkgBin = path.join(pkgRoot, typeof pkgMeta.bin === "string" ? pkgMeta.bin : pkgMeta.bin.pkg);
const exeName = target.includes("win") ? "vis-a-vis.exe" : "vis-a-vis";
const outPath = path.join(root, "release", exeName);
fs.mkdirSync(path.join(root, "release"), { recursive: true });
fs.rmSync(outPath, { force: true });

// pkg reads assets from a config file (pkg.config.json at the repo root); globs are
// resolved from cwd so that they land at <snapshot>/dist/web next to dist/server.cjs.
execFileSync(
  process.execPath,
  [pkgBin, "--config", path.join(root, "pkg.config.json"), "--target", target, "--output", outPath, path.join(dist, "server.cjs")],
  { stdio: "inherit", cwd: root },
);

const size = fs.statSync(outPath).size;
console.log(`\n[build] standalone ready: ${outPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log("[build] it creates its data/ directory next to the executable on first run.");
