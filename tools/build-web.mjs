import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, "..");
const sourceIndex = path.join(projectRoot, "index.html");
const distIndex = path.join(projectRoot, "dist", "index.html");

if (!fs.existsSync(sourceIndex)) {
  if (fs.existsSync(distIndex)) {
    console.log("No Vite source index.html found; preserving the existing compiled dist/ frontend.");
    process.exit(0);
  }

  console.error("No Vite source index.html or compiled dist/index.html found. Cannot build the frontend.");
  process.exit(1);
}

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["vite", "build"], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: false,
});

process.exit(result.status ?? 1);
