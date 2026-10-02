import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import util from "node:util";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, "..");
process.chdir(projectRoot);

// Load application environment before importing the production server bundle.
const dotenv = await import("dotenv");
dotenv.config({
  path: path.join(projectRoot, ".env"),
  quiet: true,
});
dotenv.config({
  path: path.join(projectRoot, ".env.local"),
  override: true,
  quiet: true,
});

process.env.NODE_ENV = "production";
process.env.APP_RUNTIME_MODE = process.env.APP_RUNTIME_MODE || "production";
process.env.OCR_ENGINE = process.env.OCR_ENGINE || "easyocr";
process.env.BIND_HOST = process.env.BIND_HOST || "0.0.0.0";
process.env.PUBLIC_HOST = process.env.PUBLIC_HOST || "iictdasset.lbfinc.org";
process.env.PORT = process.env.PORT || "3000";

const logsDir = path.join(projectRoot, "logs");
const maxBytes = 5 * 1024 * 1024;
const retain = 5;

function appendRotatingLog(fileName, line) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, fileName);
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > maxBytes) {
      for (let index = retain - 1; index >= 1; index -= 1) {
        const source = `${logPath}.${index}`;
        const target = `${logPath}.${index + 1}`;
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }
      fs.renameSync(logPath, `${logPath}.1`);
    }
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // Keep startup alive even when log rotation cannot write.
  }
}

function patchConsole(method, errorLog = false) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    original(...args);
    const rendered = args
      .map((arg) => typeof arg === "string" ? arg : util.inspect(arg, { depth: 6 }))
      .join(" ");
    const line = `${new Date().toISOString()} ${method.toUpperCase()} ${rendered}\n`;
    appendRotatingLog("ipas.log", line);
    if (errorLog) {
      appendRotatingLog("ipas-error.log", line);
    }
  };
}

patchConsole("log");
patchConsole("info");
patchConsole("warn", true);
patchConsole("error", true);

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exitCode = 1;
});

const serverEntry = path.join(projectRoot, "dist-server", "server.cjs");
if (!fs.existsSync(serverEntry)) {
  console.error("Production server bundle is missing. Run npm run build first.");
  process.exit(1);
}

await import(pathToFileURL(serverEntry).href);
