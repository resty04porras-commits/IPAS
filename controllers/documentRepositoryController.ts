import type { Request, Response } from "express";
import { writeAuditLog } from "./auditHelper.js";
import {
  createDocument,
  deleteDocument,
  getDocumentById,
  getDocuments,
  updateDocument,
} from "../database/repositories/documentRepository.js";

export type DocumentRepositoryControllerDependencies = {
  normalizeNextcloudPath: (targetPath: string) => string;
  sanitizeNextcloudSegment: (value: string, label: string) => string;
  getWebDAVClient: (overrides?: {
    url?: string;
    username?: string;
    password?: string;
  }) => any;
  resolveNextcloudConfig: (overrides?: {
    url?: string;
    username?: string;
    password?: string;
  }) => {
    url: string;
    username: string;
    password: string;
  };
  verifyWebDAVConnection: (client: any) => Promise<void>;
  createWebDAVClient: (
    url: string,
    options: { username: string; password: string },
  ) => any;
  readFile: (filePath: string) => Promise<Buffer>;
  unlinkFile: (filePath: string) => Promise<void>;
  getSafeFileName: (fileName: string) => string;
  getFileName: (filePath: string) => string;
  getRepoMimeType: (fileName: string) => string;
};

export function createDocumentRepositoryController(
  dependencies: DocumentRepositoryControllerDependencies,
) {
  const {
    normalizeNextcloudPath,
    sanitizeNextcloudSegment,
    getWebDAVClient,
    resolveNextcloudConfig,
    verifyWebDAVConnection,
    createWebDAVClient,
    readFile,
    unlinkFile,
    getSafeFileName,
    getFileName,
    getRepoMimeType,
  } = dependencies;
  const listDocumentRecords = async (_req: Request, res: Response) => {
    try {
      const documents = await getDocuments();
      return res.json(documents);
    } catch (error: any) {
      console.error("Document list error:", error);
      return res.status(500).json({
        error: error.message || "Failed to retrieve documents.",
      });
    }
  };

  const getDocumentRecord = async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        error: "Document ID is required.",
      });
    }

    try {
      const document = await getDocumentById(id);

      if (!document) {
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      return res.json(document);
    } catch (error: any) {
      console.error("Document retrieval error:", error);

      if (error?.code === "22P02") {
        return res.status(400).json({
          error: "Invalid document ID.",
        });
      }

      return res.status(500).json({
        error: error.message || "Failed to retrieve document.",
      });
    }
  };

  const createDocumentRecord = async (req: Request, res: Response) => {
    const sessionUser = (req as any).session?.user;
    const originalFilename = String(
      req.body?.originalFilename ?? "",
    ).trim();

    if (!sessionUser?.id) {
      return res.status(401).json({
        error: "Authentication required.",
      });
    }

    if (!originalFilename) {
      return res.status(400).json({
        error: "Original filename is required.",
      });
    }

    try {
      const document = await createDocument({
        ...req.body,
        originalFilename,
        uploadedBy: sessionUser.id,
      });

      await writeAuditLog(req, {
        action: "DOCUMENT_CREATED",
        entityType: "document",
        entityId: document.id,
        details: {},
      });

      return res.status(201).json(document);
    } catch (error: any) {
      console.error("Document create error:", error);

      if (error?.code === "22P02") {
        return res.status(400).json({
          error: "Invalid UUID value.",
        });
      }

      if (error?.code === "23503") {
        return res.status(400).json({
          error:
            "Referenced accountability form, travel report, or user does not exist.",
        });
      }

      return res.status(500).json({
        error: error.message || "Failed to create document.",
      });
    }
  };

  const updateDocumentRecord = async (req: Request, res: Response) => {
    const { id } = req.params;
    const sessionUser = (req as any).session?.user;
    const originalFilename = String(
      req.body?.originalFilename ?? "",
    ).trim();

    if (!sessionUser?.id) {
      return res.status(401).json({
        error: "Authentication required.",
      });
    }

    if (!id) {
      return res.status(400).json({
        error: "Document ID is required.",
      });
    }

    if (!originalFilename) {
      return res.status(400).json({
        error: "Original filename is required.",
      });
    }

    try {
      const existing = await getDocumentById(id);

      if (!existing) {
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      const document = await updateDocument(id, {
        ...req.body,
        originalFilename,
        uploadedBy: existing.uploadedBy,
      });

      if (!document) {
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      await writeAuditLog(req, {
        action: "DOCUMENT_UPDATED",
        entityType: "document",
        entityId: document.id,
        details: {},
      });

      return res.json(document);
    } catch (error: any) {
      console.error("Document update error:", error);

      if (error?.code === "22P02") {
        return res.status(400).json({
          error: "Invalid UUID value.",
        });
      }

      if (error?.code === "23503") {
        return res.status(400).json({
          error:
            "Referenced accountability form, travel report, or user does not exist.",
        });
      }

      return res.status(500).json({
        error: error.message || "Failed to update document.",
      });
    }
  };

  const deleteDocumentRecord = async (req: Request, res: Response) => {
    const { id } = req.params;
    const sessionUser = (req as any).session?.user;

    if (!sessionUser?.id) {
      return res.status(401).json({
        error: "Authentication required.",
      });
    }

    if (!id) {
      return res.status(400).json({
        error: "Document ID is required.",
      });
    }

    try {
      const deleted = await deleteDocument(id);

      if (!deleted) {
        return res.status(404).json({
          error: "Document not found.",
        });
      }

      await writeAuditLog(req, {
        action: "DOCUMENT_DELETED",
        entityType: "document",
        entityId: deleted.id,
        details: {},
      });

      return res.json({
        success: true,
        message: "Document record deleted.",
        id: deleted.id,
      });
    } catch (error: any) {
      console.error("Document delete error:", error);

      if (error?.code === "22P02") {
        return res.status(400).json({
          error: "Invalid document ID.",
        });
      }

      return res.status(500).json({
        error: error.message || "Failed to delete document.",
      });
    }
  };

  const createFolder = async (req: Request, res: Response) => {
    const {
      targetPath,
      folderName,
      nextcloudUrl,
      nextcloudUsername,
      nextcloudPassword,
    } = req.body;

    if (!targetPath || !folderName) {
      return res.status(400).json({
        error: "Target path and folder name are required.",
      });
    }

    try {
      const normalizedTargetPath = normalizeNextcloudPath(targetPath);
      const sanitizedFolderName = sanitizeNextcloudSegment(
        folderName,
        "Folder name",
      );

      const client = getWebDAVClient({
        url: nextcloudUrl,
        username: nextcloudUsername,
        password: nextcloudPassword,
      });

      const parts = normalizedTargetPath.split("/").filter(Boolean);
      let currentPath = "";

      for (const part of parts) {
        currentPath += `/${part}`;

        try {
          const exists = await client.exists(currentPath);
          if (!exists) {
            await client.createDirectory(currentPath);
          }
        } catch (dirErr: any) {
          if (dirErr.status !== 405) throw dirErr;
        }
      }

      const newFolderPath = `${currentPath}/${sanitizedFolderName}`;
      console.log(`Creating new folder: ${newFolderPath}`);

      const exists = await client.exists(newFolderPath);
      if (exists) {
        return res.status(400).json({
          error: "Folder already exists.",
        });
      }

      await client.createDirectory(newFolderPath);

      return res.json({
        success: true,
        message: `Successfully created folder: ${sanitizedFolderName}`,
      });
    } catch (error: any) {
      console.error("Nextcloud Create Folder Error:", error);

      return res.status(500).json({
        error:
          error.message ||
          "Failed to create folder on Nextcloud.",
      });
    }
  };

  const uploadToNextcloud = async (req: Request, res: Response) => {
    const {
      targetPath,
      nextcloudUrl,
      nextcloudUsername,
      nextcloudPassword,
    } = req.body;

    const files = (req as any).files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    try {
      const normalizedTargetPath = normalizeNextcloudPath(targetPath);
      const { url, username, password } = resolveNextcloudConfig({
        url: nextcloudUrl,
        username: nextcloudUsername,
        password: nextcloudPassword,
      });

      const fullDavUrl = `${url}/remote.php/dav/files/${username}`;
      console.log(`Connecting to Nextcloud WebDAV at: ${fullDavUrl}`);

      const client = createWebDAVClient(fullDavUrl, {
        username,
        password,
      });

      const parts = normalizedTargetPath.split("/").filter(Boolean);
      let currentPath = "";
      console.log(`Target path parts (trimmed): ${JSON.stringify(parts)}`);

      try {
        await verifyWebDAVConnection(client);
        console.log("Nextcloud connection verified successfully.");
      } catch (connErr: any) {
        console.error("Nextcloud connection verification failed:", connErr);
        throw new Error(
          `Failed to connect to Nextcloud: ${connErr.message}. Please check your credentials.`,
        );
      }

      for (const part of parts) {
        currentPath += `/${part}`;

        try {
          const exists = await client.exists(currentPath);
          console.log(`Checking if path exists: ${currentPath} -> ${exists}`);

          if (!exists) {
            console.log(`Creating directory: ${currentPath}`);
            await client.createDirectory(currentPath);
          }
        } catch (dirErr: any) {
          if (dirErr.status === 405) {
            console.log(`Directory already exists (405): ${currentPath}`);
          } else {
            console.error(`Error creating directory ${currentPath}:`, dirErr);
            throw dirErr;
          }
        }
      }

      for (const file of files) {
        const safeFileName = getSafeFileName(file.originalname);
        const remoteFilePath = `${currentPath}/${safeFileName}`;

        console.log(
          `Uploading file to: ${remoteFilePath} (${file.size} bytes)`,
        );

        const fileBuffer = await readFile(file.path);
        await client.putFileContents(remoteFilePath, fileBuffer, {
          overwrite: true,
        });

        console.log(`Successfully uploaded: ${remoteFilePath}`);
      }

      return res.json({
        success: true,
        message:
          `Successfully uploaded ${files.length} files to ${normalizedTargetPath}`,
      });
    } catch (error: any) {
      console.error("Nextcloud Upload Error:", error);

      return res.status(error?.status === 401 ? 401 : 500).json({
        error:
          error.message ||
          "Failed to upload to Nextcloud. Please verify your credentials and folder permissions.",
      });
    } finally {
      for (const file of files || []) {
        try {
          await unlinkFile(file.path);
        } catch (unlinkErr) {
          console.error("Failed to delete temp file", unlinkErr);
        }
      }
    }
  };

  const repositoryFile = async (req: Request, res: Response) => {
    const {
      path: filePath,
      nextcloudUrl,
      nextcloudUsername,
      nextcloudPassword,
      download: forceDownload,
    } = req.body || {};

    if (!filePath) {
      return res.status(400).json({ error: "File path is required." });
    }

    try {
      const normalizedPath = normalizeNextcloudPath(String(filePath));
      const client = getWebDAVClient({
        url: nextcloudUrl,
        username: nextcloudUsername,
        password: nextcloudPassword,
      });

      const stat = await client.stat(normalizedPath) as any;
      const filename = getFileName(normalizedPath);
      const mimeType = getRepoMimeType(filename);
      const fileSize: number =
        stat?.size || stat?.props?.getcontentlength || 0;

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "no-store");

      if (fileSize > 0) {
        res.setHeader("Content-Length", String(fileSize));
      }

      if (forceDownload) {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
      } else {
        res.setHeader(
          "Content-Disposition",
          `inline; filename="${filename}"`,
        );
      }

      const fileStream = client.createReadStream(normalizedPath);

      fileStream.on("error", (err: any) => {
        if (!res.headersSent) {
          res.status(500).json({
            error: "Stream error: " + err.message,
          });
        } else {
          res.destroy();
        }
      });

      fileStream.pipe(res);
    } catch (error: any) {
      console.error("Repository file proxy error:", error);

      if (!res.headersSent) {
        return res.status(500).json({
          error:
            error.message ||
            "Failed to fetch file from repository.",
        });
      }
    }
  };

  const browseRepository = async (req: Request, res: Response) => {
    const {
      path: reqPath,
      nextcloudUrl,
      nextcloudUsername,
      nextcloudPassword,
    } = req.body || {};

    const requestedPath =
      ((reqPath as string) || "").trim() ||
      "/IICTD Asset Management Record";

    try {
      const normalizedPath = normalizeNextcloudPath(requestedPath);
      const client = getWebDAVClient({
        url: nextcloudUrl,
        username: nextcloudUsername,
        password: nextcloudPassword,
      });

      const raw = await client.getDirectoryContents(normalizedPath) as any[];

      const files = raw
        .filter((item: any) => {
          const fp: string = (item.filename || "").replace(/\/+$/, "");
          return (
            fp !== normalizedPath &&
            fp !== normalizedPath.replace(/\/+$/, "")
          );
        })
        .map((item: any) => ({
          name: item.basename || "",
          path: item.filename || "",
          type: item.type || "file",
          size: item.size || 0,
          modified: item.lastmod || "",
          mime: item.mime || "",
        }))
        .sort((a: any, b: any) => {
          if (a.type !== b.type) {
            return a.type === "directory" ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

      return res.json({
        path: normalizedPath,
        files,
      });
    } catch (error: any) {
      console.error("Repository browse error:", error);
      return res.status(500).json({
        error:
          error.message ||
          "Failed to list repository contents.",
      });
    }
  };

  return {
    listDocumentRecords,
    getDocumentRecord,
    createDocumentRecord,
    updateDocumentRecord,
    deleteDocumentRecord,
    createFolder,
    uploadToNextcloud,
    repositoryFile,
    browseRepository,
  };
}
