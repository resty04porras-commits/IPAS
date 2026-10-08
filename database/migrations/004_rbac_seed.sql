BEGIN;

-- =========================================================
-- IPAS Role-Based Access Control (RBAC) Initial Seed
-- Migration: 004
--
-- Purpose:
-- Establish the initial PostgreSQL-backed RBAC baseline
-- without changing existing user role assignments.
--
-- Compatibility:
-- Current production roles SUPER_ADMIN and USER are retained.
-- More specific operational roles can be introduced later
-- after the User Registry and authorization middleware are
-- fully migrated to permission-based access control.
-- =========================================================

-- ---------------------------------------------------------
-- Roles
-- ---------------------------------------------------------

INSERT INTO roles (
    role_code,
    role_name,
    description,
    active
)
VALUES
    (
        'SUPER_ADMIN',
        'Super Administrator',
        'Full administrative access to IPAS.',
        TRUE
    ),
    (
        'USER',
        'Standard User',
        'Compatibility role for existing non-administrator users.',
        TRUE
    )
ON CONFLICT (role_code) DO NOTHING;


-- ---------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------

INSERT INTO permissions (
    permission_code,
    permission_name,
    description
)
VALUES
    (
        'users.manage',
        'Manage Users',
        'Create, update, and manage IPAS user accounts.'
    ),
    (
        'assets.manage',
        'Manage Assets',
        'Create, update, and manage asset and inventory records.'
    ),
    (
        'accountability.manage',
        'Manage Accountability',
        'Create, update, and manage accountability forms and records.'
    ),
    (
        'travel_reports.manage',
        'Manage Travel Reports',
        'Create, update, and manage travel expense and liquidation records.'
    ),
    (
        'forms.approve',
        'Approve Forms',
        'Review, approve, or sign forms when approval workflow is enabled.'
    ),
    (
        'repository.view',
        'View Document Repository',
        'View documents and metadata in the Document Repository.'
    ),
    (
        'repository.manage',
        'Manage Document Repository',
        'Create, update, and remove Document Repository metadata and records.'
    ),
    (
        'audit.view',
        'View Audit Logs',
        'View system audit and activity logs.'
    ),
    (
        'settings.manage',
        'Manage System Settings',
        'Manage system-level configuration and settings.'
    ),
    (
        'permissions.manage',
        'Manage Roles and Permissions',
        'Manage RBAC roles, permissions, and role-permission assignments.'
    )
ON CONFLICT (permission_code) DO NOTHING;


-- ---------------------------------------------------------
-- SUPER_ADMIN permissions
-- ---------------------------------------------------------

INSERT INTO role_permissions (
    role_id,
    permission_id
)
SELECT
    r.id,
    p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.role_code = 'SUPER_ADMIN'
ON CONFLICT (role_id, permission_id) DO NOTHING;


-- ---------------------------------------------------------
-- USER compatibility permissions
--
-- Keep this role intentionally limited. Existing Field
-- Engineer accounts currently using USER remain functional
-- while more specific operational roles are designed.
-- ---------------------------------------------------------

INSERT INTO role_permissions (
    role_id,
    permission_id
)
SELECT
    r.id,
    p.id
FROM roles r
JOIN permissions p
    ON p.permission_code IN (
        'assets.manage',
        'accountability.manage',
        'travel_reports.manage',
        'repository.view'
    )
WHERE r.role_code = 'USER'
ON CONFLICT (role_id, permission_id) DO NOTHING;


COMMIT;