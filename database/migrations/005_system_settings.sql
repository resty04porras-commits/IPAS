BEGIN;

-- =========================================================
-- IPAS PostgreSQL System Settings
-- Migration: 005
-- =========================================================

CREATE TABLE IF NOT EXISTS system_settings (
    id BIGSERIAL PRIMARY KEY,

    setting_key VARCHAR(150) NOT NULL UNIQUE,
    category VARCHAR(100) NOT NULL DEFAULT 'general',
    setting_value JSONB NOT NULL DEFAULT 'null'::jsonb,

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_by UUID REFERENCES users(id)
        ON DELETE SET NULL,

    CONSTRAINT system_settings_key_not_empty
        CHECK (LENGTH(TRIM(setting_key)) > 0),

    CONSTRAINT system_settings_category_not_empty
        CHECK (LENGTH(TRIM(category)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_system_settings_category
    ON system_settings(category);

COMMENT ON TABLE system_settings IS
    'Non-sensitive application configuration for IPAS.';

COMMENT ON COLUMN system_settings.setting_value IS
    'JSONB configuration value. Never store passwords, tokens, or secrets.';

COMMIT;