import type { GoogleGenAI } from "@google/genai";

interface StructuredAiDependencies {
  models: readonly string[];
  logger?: Pick<Console, "warn">;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class InvalidStructuredResponseError extends Error {
  responseSnippet: string;

  constructor(message: string, responseText: string, cause?: unknown) {
    super(message);
    this.name = "InvalidStructuredResponseError";
    this.responseSnippet = responseText.slice(0, 500);
    if (cause) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function extractUpstreamErrorMessage(error: any): string {
  if (typeof error?.message === "string") {
    const trimmed = error.message.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return (
          parsed?.error?.message ||
          parsed?.message ||
          error.message
        );
      } catch {
        return error.message;
      }
    }

    return error.message;
  }

  return String(error || "Unknown error");
}

export function isGeminiRateLimit(error: any): boolean {
  const message = extractUpstreamErrorMessage(error);
  return (
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    error?.status === 429
  );
}

export function isGeminiUnavailable(error: any): boolean {
  const message = extractUpstreamErrorMessage(error);
  return (
    message.includes("503") ||
    message.includes("UNAVAILABLE") ||
    message.toLowerCase().includes("high demand") ||
    error?.status === 503
  );
}

export function isInvalidStructuredResponse(error: unknown): error is InvalidStructuredResponseError {
  return error instanceof InvalidStructuredResponseError;
}

export function parseJsonResponse<T>(responseText: string): T {
  const cleanJson = responseText
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "");

  if (!cleanJson) {
    throw new InvalidStructuredResponseError(
      "Gemini returned an empty structured response.",
      responseText
    );
  }

  try {
    return JSON.parse(cleanJson) as T;
  } catch (error) {
    throw new InvalidStructuredResponseError(
      "Gemini returned malformed structured JSON.",
      cleanJson,
      error
    );
  }
}

/** Existing structured-response transport; model configuration and extraction prompts remain with their callers. */
export function createStructuredAiClient(dependencies: StructuredAiDependencies) {
  const {
    models: compareModels, logger = console,
    sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  } = dependencies;

  async function withRetry<T>(fn: () => Promise<T>, maxRetries = 6, initialDelay = 2000): Promise<T> {
    let retries = 0;

    while (retries < maxRetries) {
      try {
        return await fn();
      } catch (error: any) {
        const shouldRetry = isGeminiRateLimit(error) || isGeminiUnavailable(error);

        if (!shouldRetry || retries >= maxRetries - 1) {
          throw error;
        }

        const delay = initialDelay * Math.pow(1.5, retries);
        logger.warn(`Gemini temporarily unavailable. Retrying in ${delay}ms... (${retries + 1}/${maxRetries})`);
        await sleep(delay);
        retries += 1;
      }
    }

    throw new Error("Gemini is temporarily busy. Please wait a moment and try again.");
  }

  async function callGeminiForStructuredOutput<T>(
    ai: GoogleGenAI,
    parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
    responseSchema: any
  ): Promise<T> {
    let lastError: any;
    const maxStructuredRetriesPerModel = 3;

    for (const model of compareModels) {
      for (let attempt = 1; attempt <= maxStructuredRetriesPerModel; attempt += 1) {
        try {
          const response = await withRetry(() =>
            ai.models.generateContent({
              model,
              contents: [{ parts }],
              config: {
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
                responseSchema,
              },
            })
          );

          return parseJsonResponse<T>(response.text || "[]");
        } catch (error: any) {
          lastError = error;
          const malformedStructuredResponse = isInvalidStructuredResponse(error);

          if (malformedStructuredResponse) {
            logger.warn(
              `Gemini model ${model} returned malformed structured JSON on attempt ${attempt}/${maxStructuredRetriesPerModel}.`
            );

            if (attempt < maxStructuredRetriesPerModel) {
              continue;
            }
          }

          const retryableAcrossModels =
            isGeminiUnavailable(error) ||
            isGeminiRateLimit(error) ||
            malformedStructuredResponse;

          if (!retryableAcrossModels || model === compareModels[compareModels.length - 1]) {
            throw error;
          }

          logger.warn(`Gemini model ${model} failed structured output, trying fallback model.`);
          break;
        }
      }
    }

    throw lastError || new Error("Gemini comparison failed.");
  }

  return { callStructuredOutput: callGeminiForStructuredOutput, withRetry };
}
