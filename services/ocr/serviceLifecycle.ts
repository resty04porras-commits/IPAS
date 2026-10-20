import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface OcrServiceLifecycleDependencies {
  serviceUrl: string;
  serviceDirectory: string;
  autoStart: boolean;
  probeTimeoutMs: number;
  startupProbeTimeoutMs: number;
  shouldUseService: () => boolean;
  appendRotatingLog: (fileName: string, message: string) => void;
  describeError: (error: unknown) => string;
  logger?: Pick<Console, "log" | "warn">;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}

/** Owns the Python HTTP service only; recognition, HTTP uploads and legacy workers have separate owners. */
export function createOcrServiceLifecycle(dependencies: OcrServiceLifecycleDependencies) {
  const {
    serviceUrl, serviceDirectory, autoStart, probeTimeoutMs, startupProbeTimeoutMs,
    shouldUseService, appendRotatingLog, describeError, logger = console, spawnProcess = spawn,
  } = dependencies;

  let managedOcrServiceProcess: ChildProcessWithoutNullStreams | null = null;
  let ocrServiceStartupPromise: Promise<void> | null = null;
  let managedOcrServiceCleanupRegistered = false;
  let stoppingManagedOcrService = false;

  function getOcrServiceListenTarget() {
    try {
      const parsed = new URL(serviceUrl);
      return {
        host: parsed.hostname || "127.0.0.1",
        port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      };
    } catch {
      return { host: "127.0.0.1", port: "8001" };
    }
  }

  function resolveOcrServicePython() {
    const configured = (process.env.OCR_SERVICE_PYTHON || "").trim();
    if (configured) {
      return configured;
    }

    const windowsVenvPython = path.join(serviceDirectory, ".venv", "Scripts", "python.exe");
    if (fs.existsSync(windowsVenvPython)) {
      return windowsVenvPython;
    }

    const posixVenvPython = path.join(serviceDirectory, ".venv", "bin", "python");
    if (fs.existsSync(posixVenvPython)) {
      return posixVenvPython;
    }

    return process.platform === "win32" ? "python" : "python3";
  }

  async function isHealthy(timeoutMs = probeTimeoutMs): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${serviceUrl}/health`, { signal: controller.signal });
      if (!response.ok) {
        return false;
      }
      const payload = await response.json().catch(() => null);
      return payload?.status === "ok" && payload?.modelLoaded !== false;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function logManagedOcrServiceOutput(prefix: string, chunk: Buffer) {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) {
        appendRotatingLog("ocr.log", `${new Date().toISOString()} ${prefix}: ${line}\n`);
        logger.log(`[OCR service] ${prefix}: ${line}`);
      }
    }
  }

  function startManagedService() {
    if (managedOcrServiceProcess || !autoStart) {
      return;
    }

    const { host, port } = getOcrServiceListenTarget();
    const pythonExecutable = resolveOcrServicePython();
    const args = ["-m", "uvicorn", "ocr_api:app", "--host", host, "--port", port];

    logger.log(`[OCR] Starting Python EasyOCR service: ${pythonExecutable} ${args.join(" ")}`);
    stoppingManagedOcrService = false;
    managedOcrServiceProcess = spawnProcess(pythonExecutable, args, {
      cwd: serviceDirectory,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
      },
      windowsHide: true,
    });

    managedOcrServiceProcess.stdout.on("data", (chunk: Buffer) => logManagedOcrServiceOutput("stdout", chunk));
    managedOcrServiceProcess.stderr.on("data", (chunk: Buffer) => logManagedOcrServiceOutput("stderr", chunk));
    managedOcrServiceProcess.on("error", (error) => {
      logger.warn(`[OCR] Python EasyOCR service failed to start: ${error.message}`);
      managedOcrServiceProcess = null;
    });
    managedOcrServiceProcess.on("exit", (code, signal) => {
      logger.warn(`[OCR] Python EasyOCR service exited code=${code ?? "unknown"} signal=${signal ?? "none"}`);
      managedOcrServiceProcess = null;
      ocrServiceStartupPromise = null;
      if (!stoppingManagedOcrService && autoStart && shouldUseService()) {
        setTimeout(() => {
          ensureReady().catch((error) => {
            logger.warn(`[OCR] Python EasyOCR service recovery failed: ${describeError(error)}`);
          });
        }, 2000);
      }
    });

    registerManagedOcrServiceCleanup();
  }

  function stop() {
    if (managedOcrServiceProcess && !managedOcrServiceProcess.killed) {
      stoppingManagedOcrService = true;
      managedOcrServiceProcess.kill();
    }
  }

  function registerManagedOcrServiceCleanup() {
    if (managedOcrServiceCleanupRegistered) {
      return;
    }

    managedOcrServiceCleanupRegistered = true;
    process.once("exit", stop);
    process.once("SIGINT", () => {
      stop();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      stop();
      process.exit(143);
    });
  }

  async function ensureReady() {
    if (!shouldUseService()) {
      return;
    }

    if (await isHealthy()) {
      return;
    }

    if (!autoStart) {
      throw new Error(`Python EasyOCR service is not available at ${serviceUrl}.`);
    }

    if (!ocrServiceStartupPromise) {
      ocrServiceStartupPromise = (async () => {
        startManagedService();

        const deadline = Date.now() + startupProbeTimeoutMs;
        while (Date.now() < deadline) {
          if (await isHealthy()) {
            logger.log(`[OCR] Python EasyOCR service is ready at ${serviceUrl}.`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        throw new Error(
          `Python EasyOCR service did not become ready within ${Math.round(startupProbeTimeoutMs / 1000)} seconds.`
        );
      })();
    }

    await ocrServiceStartupPromise;
  }

  return { isHealthy, ensureReady, stop };
}
