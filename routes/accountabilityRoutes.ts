import { Router } from "express";
import multer from "multer";
import type { AccountabilityController } from "../controllers/accountabilityController.js";

export function createAccountabilityRoutes(
  controller: AccountabilityController,
) {
  const router = Router();

  // Scan Barcode
  router.post("/barcode/lookup", controller.lookupBarcode);

  router.post(
    "/barcode/scan",
    (req, res, next) => {
      controller.upload.any()(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          return res.status(400).json({
            error: `Upload error: ${err.message}`,
          });
        }

        if (err) {
          return res.status(500).json({
            error: err.message || "Failed to process barcode upload.",
          });
        }

        next();
      });
    },
    controller.scanBarcode,
  );

  // Smart Capture
  router.post("/ocr-v2", (req,res,next) => {
    controller.upload.any()(req,res,(err) => {
      if (err instanceof multer.MulterError) return res.status(400).json({error:`Upload error: ${err.message}`});
      if (err) return res.status(500).json({error:err.message || "Failed to process OCR upload."});
      next();
    });
  }, controller.ocrV2);

  router.post("/intake/extract", (req,res,next) => {
    controller.upload.array("evidence")(req,res,(err) => {
      if (err instanceof multer.MulterError) return res.status(400).json({error:`Upload error: ${err.message}`});
      if (err) return res.status(500).json({error:err.message || "Failed to process intake upload."});
      next();
    });
  }, controller.extractIntake);

  // Comparison Tools
  router.post("/compare", controller.compare);

  router.post(
    "/compare-upload",
    (req, res, next) => {
      controller.upload.fields([
        { name: "source1", maxCount: 1 },
        { name: "source2", maxCount: 20 },
      ])(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          return res.status(400).json({
            error: `Upload error: ${err.message}`,
          });
        }

        if (err) {
          return res.status(500).json({
            error: err.message || "Failed to process comparison upload.",
          });
        }

        next();
      });
    },
    controller.compareUpload,
  );

  // Structured Accountability Forms
  router.get(
    "/accountability/forms",
    controller.getAccountabilityFormList,
  );

  router.get(
    "/accountability/forms/:id",
    controller.getAccountabilityForm,
  );

  router.post(
    "/accountability/forms",
    controller.createAccountabilityFormRecord,
  );

  router.put(
    "/accountability/forms/:id",
    controller.updateAccountabilityFormRecord,
  );

  router.delete(
    "/accountability/forms/:id",
    controller.deleteAccountabilityFormRecord,
  );


  // File Manager / Accountability history
  router.get("/history", controller.getHistory);
  router.post("/history", controller.createHistory);
  router.delete("/history/:id", controller.deleteHistory);

  // Legacy compatibility endpoint
  router.delete("/forms/:id", controller.deleteHistory);

  return router;
}
