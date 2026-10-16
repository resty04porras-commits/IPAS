import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, "..");
const sourceIndex = path.join(projectRoot, "index.html");
const prebuiltDir = path.join(projectRoot, "frontend-prebuilt");
const distDir = path.join(projectRoot, "dist");
const distIndex = path.join(projectRoot, "dist", "index.html");

function validateFrontend(directory) {
  const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
  const assetTags = html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi);
  for (const [, reference] of assetTags) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue;
    const assetPath = path.resolve(directory, decodeURIComponent(reference.split(/[?#]/)[0]).replace(/^\/+/, ""));
    const relative = path.relative(directory, assetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
      throw new Error(`Frontend asset is missing or outside the frontend directory: ${reference}`);
    }
  }
}

if (!fs.existsSync(sourceIndex)) {
  if (fs.existsSync(path.join(prebuiltDir, "index.html"))) {
    validateFrontend(prebuiltDir);
    fs.mkdirSync(distDir, { recursive: true });
    fs.cpSync(prebuiltDir, distDir, { recursive: true });
    console.log("Restored compiled frontend from frontend-prebuilt/ to dist/. Vite source is not included.");
    process.exit(0);
  }

  if (fs.existsSync(distIndex)) {
    validateFrontend(distDir);
    console.log("No Vite source index.html found; preserving the existing compiled dist/ frontend.");
    process.exit(0);
  }

  console.error("Frontend missing. Restore frontend-prebuilt/, supply the Vite source index.html, or provide a complete dist/ directory.");
  process.exit(1);
}

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["vite", "build"], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: false,
});

process.exit(result.status ?? 1);
