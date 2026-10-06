import type { Request, Response } from "express";

export type ManagementControllerDependencies = {
  users: any[];
};

export function createManagementController(
  dependencies: ManagementControllerDependencies,
) {
  const { users } = dependencies;

  const getUsers = (_req: Request, res: Response) => {
    return res.json(users);
  };

  const saveUser = (req: Request, res: Response) => {
    const newUser = req.body;
    const index = users.findIndex((u) => u.id === newUser.id);

    if (index !== -1) {
      users[index] = {
        ...users[index],
        ...newUser,
      };
    } else {
      users.push({
        ...newUser,
        password: "1234",
        mustChangePassword: true,
      });
    }

    return res.json({ success: true });
  };

  return {
    getUsers,
    saveUser,
  };
}
