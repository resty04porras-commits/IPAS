import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import type { Multer } from "multer";
import type { createDocumentRepositoryController } from "../controllers/documentRepositoryController.js";

type DocumentRepositoryController = ReturnType<typeof createDocumentRepositoryController>;

interface RegisterDocumentRepositoryRoutesOptions {
  documentRepositoryController: DocumentRepositoryController;
  upload: Multer;
}

/** Register the existing Nextcloud/WebDAV and PostgreSQL document endpoints. */
export function registerDocumentRepositoryRoutes(
  app: Express,
  { documentRepositoryController: controller, upload }: RegisterDocumentRepositoryRoutesOptions,
): void {
  app.post("/api/create-folder", controller.createFolder);

  app.post(
    "/api/upload-to-nextcloud",
    (req: Request, res: Response, next: NextFunction) => {
      console.log(`[Upload] Starting upload request... Content-Length: ${req.headers['content-length']}`);
      upload.array("files", 100)(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          console.error(`[Upload] Multer Error: ${err.message}`, err);
          return res.status(400).json({ error: `Multer error: ${err.message}` });
        } else if (err) {
          console.error(`[Upload] Unknown Multer Error: ${err.message}`, err);
          return res.status(500).json({ error: `Unknown upload error: ${err.message}` });
        }
        console.log(`[Upload] Multer finished processing. Files: ${((req as any).files || []).length}`);
        next();
      });
    },
    controller.uploadToNextcloud,
  );

  app.post("/api/repository/file", controller.repositoryFile);
  app.get("/api/repository/documents", controller.listDocumentRecords);
  app.get("/api/repository/documents/:id", controller.getDocumentRecord);
  app.post("/api/repository/documents", controller.createDocumentRecord);
  app.put("/api/repository/documents/:id", controller.updateDocumentRecord);
  app.delete("/api/repository/documents/:id", controller.deleteDocumentRecord);
  app.post("/api/repository/browse", controller.browseRepository);
}
