BEGIN;

-- =========================================================
-- IPAS User Registry Compatibility
-- Migration: 003
--
-- Purpose:
-- Preserve the current User Registry frontend fields while
-- keeping division_id and district_id available for future
-- normalized organizational master-data relationships.
-- =========================================================

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS division VARCHAR(150),
    ADD COLUMN IF NOT EXISTS district VARCHAR(150),
    ADD COLUMN IF NOT EXISTS remarks TEXT;

COMMENT ON COLUMN users.division IS
    'Compatibility field for the current User Registry division value.';

COMMENT ON COLUMN users.district IS
    'Compatibility field for the current User Registry district value.';

COMMENT ON COLUMN users.remarks IS
    'Additional notes entered through the User Registry.';

COMMIT;
