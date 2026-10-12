import { Router } from "express";

export function createManagementRoutes(controller: any) {
  const router = Router();

  router.get("/users", controller.getUsers);
  router.post("/users", controller.saveUser);
  router.delete("/users/:id", controller.deactivateUser);
  router.patch("/users/:id/activate", controller.activateUser);

  router.get("/roles", controller.getRoles);
  router.get("/permissions", controller.getPermissions);
  router.get(
    "/role-permissions",
    controller.getRolesWithPermissions,
  );

  router.get("/audit-logs", controller.getAuditLogs);

  return router;
}