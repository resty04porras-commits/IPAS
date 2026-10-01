import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(toolsDir, "..", "..");
const serviceName = process.argv[2] || "IPAS";

let Service;
try {
  ({ Service } = require("node-windows"));
} catch {
  console.error("node-windows is not installed. Run: npm install --no-save node-windows");
  process.exit(1);
}

const svc = new Service({
  name: serviceName,
  description: "IICTD Process Automation System production service",
  script: path.join(projectRoot, "tools", "start-production.mjs"),
  workingDirectory: projectRoot,
  nodeOptions: [],
  env: [
    { name: "NODE_ENV", value: "production" },
    { name: "APP_RUNTIME_MODE", value: "production" },
  ],
});

const done = new Promise((resolve, reject) => {
  svc.on("install", () => resolve("installed"));
  svc.on("alreadyinstalled", () => resolve("already installed"));
  svc.on("invalidinstallation", () => reject(new Error("The existing service installation is invalid.")));
  svc.on("error", reject);
});

svc.install();

try {
  const result = await done;
  console.log(`${serviceName} service ${result}.`);
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
