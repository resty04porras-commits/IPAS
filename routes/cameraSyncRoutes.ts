import { Router } from "express";

export function createCameraSyncRoutes(controller: any) {
  const router = Router();

  router.get("/events", controller.events);
  router.post("/push", controller.push);
  router.get("/pending", controller.pending);
  router.delete("/pending/:eventId", controller.deletePending);

  return router;
}
