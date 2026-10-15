// Nextcloud / WebDAV client helpers - extracted from server.ts (Phase 2A)
import { createClient } from "webdav";

export const NEXTCLOUD_ROOT_SEGMENT = "IICTD Asset Management Record";
export const DEFAULT_NEXTCLOUD_URL = "https://nextcloud.lbfinc.org";

export const normalizeNextcloudUrl = (value?: string) => {
  const trimmed = (value || "").trim();
  return trimmed.replace(/\/+$/, "") || DEFAULT_NEXTCLOUD_URL;
};

export const sanitizeNextcloudSegment = (value: string, label: string) => {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }

  if (
    trimmed === "."
    || trimmed === ".."
    || trimmed.includes("..")
    || trimmed.includes("/")
    || trimmed.includes("\\")
    || trimmed.includes("\0")
  ) {
    throw new Error(`${label} contains an invalid folder name.`);
  }

  return trimmed;
};

export const normalizeNextcloudPath = (targetPath: string) => {
  const normalized = String(targetPath || "").replace(/\\/g, "/");
  const parts = normalized
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => sanitizeNextcloudSegment(part, "Target path"));

  if (parts.length === 0) {
    throw new Error("Target path is required.");
  }

  if (parts[0] !== NEXTCLOUD_ROOT_SEGMENT) {
    throw new Error("Target path must stay inside the IICTD Asset Management Record folder.");
  }

  return `/${parts.join("/")}`;
};

export const resolveNextcloudConfig = (overrides?: { url?: string; username?: string; password?: string }) => {
  const url = normalizeNextcloudUrl(overrides?.url || process.env.NEXTCLOUD_URL || DEFAULT_NEXTCLOUD_URL);
  const username = overrides?.username || process.env.NEXTCLOUD_USERNAME;
  const password = overrides?.password || process.env.NEXTCLOUD_PASSWORD;

  if (!username || !password) {
    throw new Error("Nextcloud credentials not configured in environment variables. Please set NEXTCLOUD_USERNAME and NEXTCLOUD_PASSWORD in the Secrets panel.");
  }

  return { url, username, password };
};

export const getWebDAVClient = (overrides?: { url?: string; username?: string; password?: string }) => {
  const { url, username, password } = resolveNextcloudConfig(overrides);
  const fullDavUrl = `${url}/remote.php/dav/files/${username}`;
  return createClient(fullDavUrl, {
    username,
    password,
  });
};

export const verifyWebDAVConnection = async (client: ReturnType<typeof createClient>) => {
  await client.getDirectoryContents("/");
};

