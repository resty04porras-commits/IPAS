import { Router } from "express";

export function createAuthRoutes(controller: any) {
  const router = Router();

  router.post("/login", controller.login);
  router.get("/me", controller.me);
  router.post("/logout", controller.logout);
  router.post("/change-password", controller.changePassword);
  router.post("/update-user", controller.updateUser);

  return router;
}
