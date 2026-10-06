import { Router } from "express";

export function createManagementRoutes(controller: any) {
  const router = Router();

  router.get("/users", controller.getUsers);
  router.post("/users", controller.saveUser);

  return router;
}
