import { Request, Response, NextFunction } from "express";
import type { Multer } from "multer";

interface DocumentRepositoryController {
  createFolder: (req: Request, res: Response) => Promise<void>;
  uploadToNextcloud: (req: Request, res: Response) => Promise<void>;
  repositoryFile: (req: Request, res: Response) => Promise<void>;
  listDocumentRecords: (req: Request, res: Response) => Promise<void>;
  getDocumentRecord: (req: Request, res: Response) => Promise<void>;
  createDocumentRecord: (req: Request, res: Response) => Promise<void>;
  updateDocumentRecord: (req: Request, res: Response) => Promise<void>;
  deleteDocumentRecord: (req: Request, res: Response) => Promise<void>;
  browseRepository: (req: Request, res: Response) => Promise<void>;
}

interface RegisterDocumentRepositoryRoutesOptions {
  documentRepositoryController: DocumentRepositoryController;
  upload: Multer;
}

/**
 * Register all Document Repository routes (Nextcloud WebDAV + PostgreSQL metadata).
 * 
 * Routes:
 * - POST /api/create-folder
 * - POST /api/upload-to-nextcloud
 * - POST /api/repository/file
 * - GET  /api/repository/documents
 * - GET  /api/repository/documents/:id
 * - POST /api/repository/documents
 * - PUT  /api/repository/documents/:id
 * - DELETE /api/repository/documents/:id
 * - POST /api/repository/browse
 */
export function registerDocumentRepositoryRoutes(
  app: any,
  { documentRepositoryController, upload }: RegisterDocumentRepositoryRoutesOptions
): void {
  // Nextcloud Create Folder Endpoint
  app.post("/api/create-folder", documentRepositoryController.createFolder);

// Nextcloud Upload Endpoint
  app.post("/api/upload-to-nextcloud", (req: Request, res: Response, next: NextFunction) => {
    console.log(`[Upload] Starting upload request... Content-Length: ${req.headers['content-length']}`);
    upload.array("files", 100)(req, res, (err) => {
      if (err) {
        console.error(`[Upload] Multer Error: ${err.message}`, err);
        const status = (err as any).code ? 400 : 500;
        return res.status(status).json({ error: `Upload error: ${err.message}` });
      }
      console.log(`[Upload] Multer finished processing. Files: ${((req as any).files || []).length}`);
      next();
    });
  }, documentRepositoryController.uploadToNextcloud);

// Proxy a single file from Nextcloud for in-app preview or direct download
  app.post("/api/repository/file", documentRepositoryController.repositoryFile);

// Document Repository — PostgreSQL metadata
  app.get(
    "/api/repository/documents",
    documentRepositoryController.listDocumentRecords,
  );

app.get(
    "/api/repository/documents/:id",
    documentRepositoryController.getDocumentRecord,
  );

app.post(
    "/api/repository/documents",
    documentRepositoryController.createDocumentRecord,
  );

app.put(
    "/api/repository/documents/:id",
    documentRepositoryController.updateDocumentRecord,
  );

app.delete(
    "/api/repository/documents/:id",
    documentRepositoryController.deleteDocumentRecord,
  );

app.post("/api/repository/browse", documentRepositoryController.browseRepository);
}
