import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BarcodeScanResult } from "../../types/barcode.js";
import type { OcrSourceFile } from "../../types/ocr.js";

interface BarcodeWorkerDependencies {
  workerScriptPath: string;
  serviceDirectory: string;
  timeoutMs: number;
  describeError: (error: unknown) => string;
  logger?: Pick<Console, "log">;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}

/** One-shot local OpenCV process; HTTP fallback policy remains in httpClient.ts. */
export function createBarcodeWorker<TRecord = unknown>(dependencies: BarcodeWorkerDependencies) {
  const {
    workerScriptPath, serviceDirectory, timeoutMs: requestTimeoutMs,
    describeError, logger = console, spawnProcess = spawn,
  } = dependencies;

  function getLaunchSpec() {
    const configuredPython = process.env.BARCODE_SCAN_PYTHON?.trim() || process.env.PADDLE_OCR_PYTHON?.trim();
    if (configuredPython) {
      return {
        command: configuredPython,
        args: ["-u", workerScriptPath],
      };
    }

    if (process.platform === "win32") {
      const windowsVenvPython = path.join(serviceDirectory, ".venv", "Scripts", "python.exe");
      return {
        command: fs.existsSync(windowsVenvPython) ? windowsVenvPython : "python",
        args: ["-u", workerScriptPath],
      };
    }

    const posixVenvPython = path.join(serviceDirectory, ".venv", "bin", "python");
    return {
      command: fs.existsSync(posixVenvPython) ? posixVenvPython : "python3",
      args: ["-u", workerScriptPath],
    };
  }

  async function scan(file: OcrSourceFile, timeoutMs = requestTimeoutMs): Promise<BarcodeScanResult<TRecord>> {
    if (file.contentType !== "inlineData" || file.kind !== "image") {
      return {
        success: false,
        barcode: null,
        matched: false,
        record: null,
        message: "Barcode scan accepts image files only.",
      };
    }

    const { command, args } = getLaunchSpec();
    const startedAt = Date.now();

    return new Promise<BarcodeScanResult<TRecord>>((resolve, reject) => {
      const child = spawnProcess(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          PYTHONNOUSERSITE: "1",
        },
      });
      let stdout = "";
      let stderr = "";

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Barcode scan timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        const raw = stdout.trim();
        if (!raw) {
          reject(new Error(stderr.trim() || `Barcode worker exited with code ${code ?? "unknown"}.`));
          return;
        }

        try {
          const payload = JSON.parse(raw);
          const barcode = typeof payload?.barcode === "string" && payload.barcode.trim()
            ? payload.barcode.trim()
            : null;
          logger.log(`[Barcode] engine=opencv-worker file="${file.name}" detected=${Boolean(barcode)} elapsed=${Date.now() - startedAt}ms`);
          resolve({
            success: Boolean(payload?.success),
            barcode,
            type: typeof payload?.type === "string" ? payload.type : null,
            matched: false,
            record: null,
            message: typeof payload?.message === "string"
              ? payload.message
              : barcode
                ? "Barcode detected."
                : "No barcode detected. Please capture a clearer image.",
            barcodes: Array.isArray(payload?.barcodes) ? payload.barcodes : [],
          });
        } catch (error) {
          reject(new Error(`Could not parse barcode worker output. ${describeError(error)} ${stderr}`.trim()));
        }
      });

      child.stdin.end(JSON.stringify({
        imageBase64: file.content,
        mimeType: file.mimeType,
      }));
    });
  }

  return { scan };
}
