import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OcrRecognizeOptions, OcrBatchProbe, OcrSnapshot, OcrWorkerResult as PaddleOcrWorkerResult } from "../../types/ocr.js";
import { toOcrSnapshot } from "./snapshots.js";

interface OcrWorkerPoolDependencies {
  projectRoot: string;
  workerScriptPath: string;
  serviceDirectory: string;
  poolSize: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  retryCount: number;
  describeError: (error: unknown) => string;
  logger?: Pick<Console, "log" | "warn">;
  spawnProcess?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}

type PaddleOcrRequest = {
  id: string;
  imageBase64: string;
  rectangle?: OcrRecognizeOptions["rectangle"];
  rectangles?: OcrBatchProbe[];
  mode?: OcrRecognizeOptions["mode"];
};

type PaddleOcrResponse = {
  type?: "ready" | "startup_error";
  id?: string;
  ok?: boolean;
  snapshot?: OcrSnapshot;
  snapshots?: Record<string, OcrSnapshot>;
  error?: string;
  traceback?: string;
};

type PaddleOcrPendingRequest = {
  resolve: (result: PaddleOcrWorkerResult) => void;
  reject: (error: Error) => void;
};

type PaddleOcrWorkerHandle = {
  slot: number;
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, PaddleOcrPendingRequest>;
  stderrTail: string[];
  activeRequests: number;
  inferencePrimed: boolean;
  closed: boolean;
};

/** JSON-lines legacy worker transport. HTTP OCR service startup belongs to serviceLifecycle.ts. */
export function createOcrWorkerPool(dependencies: OcrWorkerPoolDependencies) {
  const {
    projectRoot, workerScriptPath, serviceDirectory, poolSize, startupTimeoutMs,
    requestTimeoutMs, retryCount, describeError, logger = console, spawnProcess = spawn,
  } = dependencies;

  function getPaddleOcrLaunchSpec() {
    const configuredPython = process.env.PADDLE_OCR_PYTHON?.trim();
    if (configuredPython) {
      return {
        command: configuredPython,
        args: ["-u", workerScriptPath],
      };
    }

    if (process.platform === "win32") {
      const windowsVenvPython = path.join(serviceDirectory, ".venv", "Scripts", "python.exe");
      if (fs.existsSync(windowsVenvPython)) {
        return {
          command: windowsVenvPython,
          args: ["-u", workerScriptPath],
        };
      }

      return {
        command: "python",
        args: ["-u", workerScriptPath],
      };
    }

    const posixVenvPython = path.join(serviceDirectory, ".venv", "bin", "python");
    if (fs.existsSync(posixVenvPython)) {
      return {
        command: posixVenvPython,
        args: ["-u", workerScriptPath],
      };
    }

    return {
      command: "python3",
      args: ["-u", workerScriptPath],
    };
  }

  const paddleOcrWorkerPool: Array<Promise<PaddleOcrWorkerHandle> | null> = Array.from(
    { length: poolSize },
    () => null
  );
  let paddleOcrWarmupPromise: Promise<void> | null = null;
  const paddleOcrWarmupImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3ZC5kAAAAASUVORK5CYII=";

  function rejectPendingPaddleRequests(worker: PaddleOcrWorkerHandle, reason: string) {
    for (const pending of worker.pending.values()) {
      pending.reject(new Error(reason));
    }
    worker.pending.clear();
  }

  function resetPaddleOcrWorker(reason: string, slot?: number) {
    const slots = typeof slot === "number"
      ? [slot]
      : paddleOcrWorkerPool.map((_, index) => index);

    for (const workerSlot of slots) {
      const currentWorkerPromise = paddleOcrWorkerPool[workerSlot];
      paddleOcrWorkerPool[workerSlot] = null;
      paddleOcrWarmupPromise = null;

      void currentWorkerPromise?.then((worker) => {
        if (worker.closed) {
          return;
        }

        logger.warn(`Resetting PaddleOCR worker ${worker.slot + 1}/${poolSize}: ${reason}`);
        rejectPendingPaddleRequests(worker, reason);
        worker.child.kill();

        const forcedKillTimer = setTimeout(() => {
          if (!worker.closed) {
            worker.child.kill("SIGKILL");
          }
        }, 1500);
        forcedKillTimer.unref?.();
      }).catch(() => undefined);
    }
  }

  async function getPaddleOcrWorker(slot: number) {
    if (!paddleOcrWorkerPool[slot]) {
      const workerPromise = new Promise<PaddleOcrWorkerHandle>((resolve, reject) => {
        const { command, args } = getPaddleOcrLaunchSpec();
        const child = spawnProcess(command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
            PADDLE_PDX_CACHE_HOME: process.env.PADDLE_PDX_CACHE_HOME || path.join(projectRoot, ".paddlex"),
            PYTHONIOENCODING: "utf-8",
            PYTHONUTF8: "1",
            // Skip user site-packages so the old user-installed paddle 2.x does not
            // shadow the system-level paddle 3.x required by PaddleX 3.x.
            PYTHONNOUSERSITE: "1",
          },
        });

        const worker: PaddleOcrWorkerHandle = {
          slot,
          child,
          pending: new Map<string, PaddleOcrPendingRequest>(),
          stderrTail: [],
          activeRequests: 0,
          inferencePrimed: false,
          closed: false,
        };

        let stdoutBuffer = "";
        let settled = false;

        const startupTimer = setTimeout(() => {
          child.kill();
          const stderr = worker.stderrTail.join("\n").trim();
          reject(new Error(`PaddleOCR worker startup timed out.${stderr ? ` ${stderr}` : ""}`));
          if (paddleOcrWorkerPool[slot] === workerPromise) {
            paddleOcrWorkerPool[slot] = null;
          }
        }, startupTimeoutMs);

        const settleResolve = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(startupTimer);
          resolve(worker);
        };

        const settleReject = (error: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(startupTimer);
          reject(error);
          if (paddleOcrWorkerPool[slot] === workerPromise) {
            paddleOcrWorkerPool[slot] = null;
          }
        };

        child.stdout.on("data", (chunk) => {
          stdoutBuffer += chunk.toString();

          let lineBreakIndex = stdoutBuffer.indexOf("\n");
          while (lineBreakIndex >= 0) {
            const rawLine = stdoutBuffer.slice(0, lineBreakIndex).trim();
            stdoutBuffer = stdoutBuffer.slice(lineBreakIndex + 1);

            if (rawLine) {
              try {
                const message = JSON.parse(rawLine) as PaddleOcrResponse;

                if (message.type === "ready") {
                  settleResolve();
                } else if (message.type === "startup_error") {
                  const startupError = new Error(message.error || "PaddleOCR worker failed to initialize.");
                  settleReject(startupError);
                } else if (message.id) {
                  const pending = worker.pending.get(message.id);
                  if (pending) {
                    worker.pending.delete(message.id);
                    if (message.ok && (message.snapshot || message.snapshots)) {
                      pending.resolve({
                        snapshot: message.snapshot ? toOcrSnapshot(message.snapshot) : undefined,
                        snapshots: message.snapshots
                          ? Object.fromEntries(
                              Object.entries(message.snapshots).map(([key, snapshot]) => [key, toOcrSnapshot(snapshot)])
                            )
                          : undefined,
                      });
                    } else {
                      pending.reject(new Error(message.error || "PaddleOCR recognition failed."));
                    }
                  }
                }
              } catch (error) {
                logger.warn("Unexpected PaddleOCR worker output:", rawLine, error);
              }
            }

            lineBreakIndex = stdoutBuffer.indexOf("\n");
          }
        });

        child.stderr.on("data", (chunk) => {
          const lines = chunk
            .toString()
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

          for (const line of lines) {
            worker.stderrTail.push(line);
            if (worker.stderrTail.length > 20) {
              worker.stderrTail.shift();
            }
            logger.warn(`[PaddleOCR ${slot + 1}] ${line}`);
          }
        });

        child.stdin.on("error", (error) => {
          if (!worker.closed && (error as NodeJS.ErrnoException).code !== "EOF") {
            logger.warn(`PaddleOCR stdin error: ${error.message}`);
          }
        });

        child.on("error", (error) => {
          const stderr = worker.stderrTail.join("\n").trim();
          settleReject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
        });

        child.on("close", (code) => {
          worker.closed = true;
          worker.inferencePrimed = false;
          const stderr = worker.stderrTail.join("\n").trim();
          const exitReason = `PaddleOCR worker exited with code ${code ?? "unknown"}${stderr ? `\n${stderr}` : ""}`;
          rejectPendingPaddleRequests(worker, exitReason);
          if (paddleOcrWorkerPool[slot] === workerPromise) {
            paddleOcrWorkerPool[slot] = null;
          }

          if (!settled) {
            settleReject(new Error(exitReason));
          }
        });
      });

      paddleOcrWorkerPool[slot] = workerPromise;
    }

    return paddleOcrWorkerPool[slot]!;
  }

  function prewarmPaddleOcrWorker() {
    if (process.env.DISABLE_PADDLE_OCR === "true") {
      return;
    }

    if (!paddleOcrWarmupPromise) {
      paddleOcrWarmupPromise = (async () => {
        await Promise.all(
          Array.from({ length: poolSize }, async (_, slot) => {
            try {
              const worker = await getPaddleOcrWorker(slot);
              logger.log(`PaddleOCR worker ${slot + 1}/${poolSize} is ready.`);

              if (!worker.inferencePrimed) {
                await submitPaddleOcrRequest({
                  imageBase64: paddleOcrWarmupImageBase64,
                  mode: "full",
                }, {
                  timeoutMs: 180 * 1000,
                  retries: 0,
                  workerSlot: slot,
                });
                worker.inferencePrimed = true;
                logger.log(`PaddleOCR worker ${slot + 1}/${poolSize} inference warm-up completed.`);
              }
            } catch (error) {
              logger.warn(`PaddleOCR warm-up failed for worker ${slot + 1}: ${describeError(error)}`);
            }
          })
        );
      })()
        .finally(() => {
          paddleOcrWarmupPromise = null;
        });
    }
  }

  async function selectPaddleOcrWorker(preferredSlot?: number): Promise<PaddleOcrWorkerHandle> {
    if (typeof preferredSlot === "number") {
      return getPaddleOcrWorker(preferredSlot);
    }

    const existingWorkers = await Promise.all(
      paddleOcrWorkerPool.map(async (promise) => {
        if (!promise) {
          return null;
        }

        try {
          const worker = await promise;
          return worker.closed ? null : worker;
        } catch {
          return null;
        }
      })
    );

    const leastBusyWorker = existingWorkers
      .filter((worker): worker is PaddleOcrWorkerHandle => Boolean(worker))
      .sort((left, right) => left.activeRequests - right.activeRequests)[0];
    const unopenedSlot = paddleOcrWorkerPool.findIndex((promise) => promise === null);

    if (unopenedSlot >= 0 && (!leastBusyWorker || leastBusyWorker.activeRequests > 0)) {
      return getPaddleOcrWorker(unopenedSlot);
    }

    if (leastBusyWorker) {
      return leastBusyWorker;
    }

    return getPaddleOcrWorker(0);
  }

  async function dispatchPaddleOcrRequest(
    worker: PaddleOcrWorkerHandle,
    request: Omit<PaddleOcrRequest, "id">,
    options: { timeoutMs: number; resetOnTimeout: boolean }
  ): Promise<PaddleOcrWorkerResult> {
    const { timeoutMs, resetOnTimeout } = options;

    return new Promise<PaddleOcrWorkerResult>((resolve, reject) => {
      const id = crypto.randomUUID();
      let finished = false;

      const finalize = () => {
        if (finished) {
          return;
        }
        finished = true;
        worker.activeRequests = Math.max(0, worker.activeRequests - 1);
      };

      const requestTimer = setTimeout(() => {
        worker.pending.delete(id);
        const timeoutError = new Error(`PaddleOCR request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
        finalize();
        if (resetOnTimeout) {
          resetPaddleOcrWorker(timeoutError.message, worker.slot);
        }
        reject(timeoutError);
      }, timeoutMs);

      worker.activeRequests += 1;
      worker.pending.set(id, {
        resolve: (value) => {
          clearTimeout(requestTimer);
          finalize();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(requestTimer);
          finalize();
          reject(error);
        },
      });

      if (worker.child.stdin.destroyed || worker.child.stdin.writableEnded) {
        clearTimeout(requestTimer);
        worker.pending.delete(id);
        finalize();
        reject(new Error("PaddleOCR worker input stream is not writable."));
        return;
      }

      try {
        worker.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, "utf8", (error) => {
          if (error) {
            clearTimeout(requestTimer);
            worker.pending.delete(id);
            finalize();
            reject(error);
          }
        });
      } catch (error) {
        clearTimeout(requestTimer);
        worker.pending.delete(id);
        finalize();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async function submitPaddleOcrRequest(
    request: Omit<PaddleOcrRequest, "id">,
    options: { timeoutMs?: number; retries?: number; resetOnTimeout?: boolean; workerSlot?: number } = {}
  ): Promise<PaddleOcrWorkerResult> {
    const timeoutMs = options.timeoutMs ?? requestTimeoutMs;
    const retries = options.retries ?? retryCount;
    const resetOnTimeout = options.resetOnTimeout ?? true;
    let attempt = 0;

    while (true) {
      attempt += 1;
      const worker = await selectPaddleOcrWorker(options.workerSlot);

      try {
        return await dispatchPaddleOcrRequest(worker, request, {
          timeoutMs,
          resetOnTimeout,
        });
      } catch (error: any) {
        const isTimeout = typeof error?.message === "string" && error.message.includes("timed out");
        if (!isTimeout || attempt > retries) {
          throw error;
        }

        logger.warn(`Retrying EasyOCR request after timeout (${attempt}/${retries + 1}).`);
      }
    }
  }

  return { submit: submitPaddleOcrRequest, prewarm: prewarmPaddleOcrWorker, reset: resetPaddleOcrWorker };
}
