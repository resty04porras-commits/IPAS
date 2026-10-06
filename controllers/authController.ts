import type { Request, Response } from "express";

export type AuthControllerDependencies = {
  users: any[];
};

export function createAuthController(dependencies: AuthControllerDependencies) {
  const { users } = dependencies;

  const login = (req: Request, res: Response) => {
    const { employeeId, password } = req.body;
    const foundUser = users.find((u) => u.employeeId === employeeId);

    if (foundUser && password === foundUser.password) {
      const sessionUser = {
        id: foundUser.id,
        employeeId: foundUser.employeeId,
        name: foundUser.name,
        designation: foundUser.designation,
        role: foundUser.role || (foundUser.designation === "Administrator" ? "SUPER_ADMIN" : "USER"),
        photoURL: foundUser.photoURL || null,
        mustChangePassword: foundUser.mustChangePassword,
        uiSettings: foundUser.uiSettings,
        profileCustomization: foundUser.profileCustomization,
      };
      (req as any).session.user = sessionUser;
      return res.json(sessionUser);
    }

    return res.status(401).json({ error: "Invalid Employee ID or Password" });
  };

  const me = (req: Request, res: Response) => {
    return res.json((req as any).session.user || null);
  };

  const logout = (req: Request, res: Response) => {
    (req as any).session = null;
    return res.json({ success: true });
  };

  const changePassword = (req: Request, res: Response) => {
    const { employeeId, newPassword } = req.body;
    const sessionUser = (req as any).session.user;
    const targetEmployeeId = sessionUser?.employeeId || employeeId;

    if (!targetEmployeeId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const userIndex = users.findIndex((u) => u.employeeId === targetEmployeeId);

    if (userIndex !== -1) {
      users[userIndex].password = newPassword;
      users[userIndex].mustChangePassword = false;

      if ((req as any).session.user) {
        (req as any).session.user.mustChangePassword = false;
      }

      return res.json({ success: true });
    }

    return res.status(404).json({ error: "User not found" });
  };

  const updateUser = (req: Request, res: Response) => {
    const sessionUser = (req as any).session.user;

    if (!sessionUser) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { photoURL, uiSettings, profileCustomization } = req.body;
    const userIndex = users.findIndex((u) => u.id === sessionUser.id);

    if (userIndex !== -1) {
      if (photoURL !== undefined) users[userIndex].photoURL = photoURL;
      if (uiSettings !== undefined) users[userIndex].uiSettings = uiSettings;
      if (profileCustomization !== undefined) users[userIndex].profileCustomization = profileCustomization;

      const updatedSessionUser = {
        ...sessionUser,
        photoURL: users[userIndex].photoURL,
        uiSettings: users[userIndex].uiSettings,
        profileCustomization: users[userIndex].profileCustomization,
      };

      (req as any).session.user = updatedSessionUser;
      return res.json(updatedSessionUser);
    }

    return res.status(404).json({ error: "User not found" });
  };

  return {
    login,
    me,
    logout,
    changePassword,
    updateUser,
  };
}
