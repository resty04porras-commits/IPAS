import { Router } from "express";
import {
  loadTerTravelEntries,
  saveTerTravelEntry,
} from "../controllers/terController.js";

const router = Router();

router.post("/travel-entry", saveTerTravelEntry);
router.get("/travel-entries", loadTerTravelEntries);

export default router;
