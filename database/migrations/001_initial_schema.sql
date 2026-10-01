BEGIN;

-- =========================================================
-- IPAS PostgreSQL Initial Schema
-- Migration: 001
-- =========================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- ORGANIZATIONAL STRUCTURE
-- =========================================================

CREATE TABLE divisions (
    id              BIGSERIAL PRIMARY KEY,
    division_code   VARCHAR(30) NOT NULL UNIQUE,
    division_name   VARCHAR(150) NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE districts (
    id              BIGSERIAL PRIMARY KEY,
    division_id     BIGINT NOT NULL REFERENCES divisions(id),
    district_code   VARCHAR(30) NOT NULL,
    district_name   VARCHAR(150),
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (division_id, district_code)
);

CREATE TABLE branches (
    id              BIGSERIAL PRIMARY KEY,
    district_id     BIGINT NOT NULL REFERENCES districts(id),
    branch_code     VARCHAR(30) NOT NULL UNIQUE,
    branch_name     VARCHAR(200) NOT NULL,
    address         TEXT,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- USERS / RBAC
-- =========================================================

CREATE TABLE users (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id             VARCHAR(50) NOT NULL UNIQUE,
    name                    VARCHAR(200) NOT NULL,
    email                   VARCHAR(255),
    designation             VARCHAR(150),
    department              VARCHAR(150),
    base_office             VARCHAR(200),
    user_group              VARCHAR(150),

    division_id             BIGINT REFERENCES divisions(id),
    district_id             BIGINT REFERENCES districts(id),

    role                    VARCHAR(50) NOT NULL DEFAULT 'USER',
    status                  VARCHAR(30) NOT NULL DEFAULT 'Active',

    password_hash           TEXT NOT NULL,
    must_change_password    BOOLEAN NOT NULL DEFAULT TRUE,

    photo_url               TEXT,
    signature_path          TEXT,

    ui_settings             JSONB NOT NULL DEFAULT '{}'::jsonb,
    profile_customization   JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at           TIMESTAMPTZ
);

CREATE TABLE roles (
    id          BIGSERIAL PRIMARY KEY,
    role_code   VARCHAR(50) NOT NULL UNIQUE,
    role_name   VARCHAR(150) NOT NULL,
    description TEXT,
    active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE permissions (
    id              BIGSERIAL PRIMARY KEY,
    permission_code VARCHAR(100) NOT NULL UNIQUE,
    permission_name VARCHAR(200) NOT NULL,
    description     TEXT
);

CREATE TABLE role_permissions (
    role_id       BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- =========================================================
-- ASSET / INVENTORY
-- =========================================================

CREATE TABLE assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hardware_id     VARCHAR(100) UNIQUE,
    component       VARCHAR(100) NOT NULL,
    description     TEXT,
    brand           VARCHAR(150),
    model           VARCHAR(150),
    serial_number   VARCHAR(200),

    status          VARCHAR(50),
    availability    VARCHAR(50) DEFAULT 'in_inventory',

    division_id     BIGINT REFERENCES divisions(id),
    district_id     BIGINT REFERENCES districts(id),
    branch_id       BIGINT REFERENCES branches(id),

    accountable_to  UUID REFERENCES users(id),

    remarks         TEXT,

    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Generic inventory compatibility with current InventoryItem API
CREATE TABLE inventory_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku             VARCHAR(100) NOT NULL UNIQUE,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    category        VARCHAR(100) NOT NULL,
    quantity        INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    unit_price      NUMERIC(14,2) NOT NULL DEFAULT 0,
    location        TEXT,
    supplier        VARCHAR(200),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- ACCOUNTABILITY
-- =========================================================

CREATE TABLE accountability_forms (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    employee_id         VARCHAR(50),
    employee_name       VARCHAR(200) NOT NULL,
    designation         VARCHAR(150),
    department          VARCHAR(150),
    effective_date      DATE,

    signature_path      TEXT,

    processed_by        VARCHAR(200),
    processed_date      DATE,

    checked_by          VARCHAR(200),
    checked_date        DATE,

    verified_by         VARCHAR(200),
    verified_title      VARCHAR(150),
    verified_date       DATE,

    noted_by            VARCHAR(200),
    noted_title         VARCHAR(150),
    noted_date          DATE,

    status              VARCHAR(50) NOT NULL DEFAULT 'draft',

    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE accountability_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    accountability_id   UUID NOT NULL
                            REFERENCES accountability_forms(id)
                            ON DELETE CASCADE,

    asset_id            UUID REFERENCES assets(id),

    source_name         TEXT,
    component           VARCHAR(100),
    description         TEXT,
    hardware_id         VARCHAR(100),
    serial_number       VARCHAR(200),
    remarks             TEXT,
    notes               TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- TRAVEL EXPENSE REPORT / LIQUIDATION
-- =========================================================

CREATE TABLE travel_reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ter_id              VARCHAR(160) UNIQUE,

    employee_id         VARCHAR(50),
    employee_name       VARCHAR(200) NOT NULL,
    report_date         DATE,
    designation         VARCHAR(150),
    base                VARCHAR(200),
    purpose             TEXT,

    cash_advance        NUMERIC(14,2) NOT NULL DEFAULT 0,

    prepared_by_name    VARCHAR(200),
    prepared_by_title   VARCHAR(150),

    checked_by_name     VARCHAR(200),
    checked_by_title    VARCHAR(150),

    reviewed_by_name    VARCHAR(200),
    reviewed_by_title   VARCHAR(150),

    noted_by_name       VARCHAR(200),
    noted_by_title      VARCHAR(150),

    approved_by_name    VARCHAR(200),
    approved_by_title   VARCHAR(150),

    prepared_signature_path TEXT,

    status              VARCHAR(50) NOT NULL DEFAULT 'draft',

    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE travel_entries (
    id                      VARCHAR(160) PRIMARY KEY,
    travel_report_id        UUID REFERENCES travel_reports(id) ON DELETE CASCADE,
    ter_id                  VARCHAR(160) NOT NULL,

    source_name             TEXT,
    transaction_date        DATE,
    transaction_time        VARCHAR(30),

    origin                  TEXT,
    destination             TEXT,
    mode_of_transportation  VARCHAR(150),

    amount                  NUMERIC(14,2) NOT NULL DEFAULT 0,
    per_diem                NUMERIC(14,2) NOT NULL DEFAULT 0,
    breakfast               NUMERIC(14,2) NOT NULL DEFAULT 0,
    lunch                   NUMERIC(14,2) NOT NULL DEFAULT 0,
    dinner                  NUMERIC(14,2) NOT NULL DEFAULT 0,
    others                  NUMERIC(14,2) NOT NULL DEFAULT 0,

    remarks                 TEXT,
    notes                   TEXT,

    ticket_file_name        TEXT,
    ticket_mime_type        VARCHAR(150),
    ticket_storage_path     TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_travel_entries_ter_id
    ON travel_entries(ter_id);

-- =========================================================
-- DOCUMENT REPOSITORY / SUPPORTING DOCUMENTS
-- =========================================================

CREATE TABLE documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    document_type       VARCHAR(100),
    category            VARCHAR(100),

    original_filename   TEXT NOT NULL,
    stored_filename     TEXT,
    mime_type           VARCHAR(150),
    file_size           BIGINT,

    storage_provider    VARCHAR(50) NOT NULL DEFAULT 'local',
    storage_path        TEXT,
    nextcloud_path      TEXT,
    nextcloud_url       TEXT,

    accountability_id   UUID REFERENCES accountability_forms(id)
                            ON DELETE SET NULL,

    travel_report_id    UUID REFERENCES travel_reports(id)
                            ON DELETE SET NULL,

    uploaded_by         UUID REFERENCES users(id),
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    status              VARCHAR(50) NOT NULL DEFAULT 'active',
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- =========================================================
-- SMART CAPTURE IMAGE METADATA
-- Actual image should remain in file/Nextcloud storage.
-- =========================================================

CREATE TABLE smart_capture_images (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        VARCHAR(200),
    fingerprint     VARCHAR(255),
    file_name       TEXT,
    mime_type       VARCHAR(150),
    capture_type    VARCHAR(100),
    storage_path    TEXT,
    captured_at     TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- FORM HISTORY
-- Flexible payload preserves compatibility with current API.
-- =========================================================

CREATE TABLE form_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_type       VARCHAR(100),
    reference_id    VARCHAR(200),
    action          VARCHAR(100),
    status          VARCHAR(50),
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- AUDIT LOG
-- =========================================================

CREATE TABLE audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    employee_id     VARCHAR(50),
    actor_name      VARCHAR(200),
    action          VARCHAR(150) NOT NULL,
    entity_type     VARCHAR(100),
    entity_id       VARCHAR(200),
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================
-- USEFUL INDEXES
-- =========================================================

CREATE INDEX idx_users_division
    ON users(division_id);

CREATE INDEX idx_users_district
    ON users(district_id);

CREATE INDEX idx_assets_hardware_id
    ON assets(hardware_id);

CREATE INDEX idx_assets_serial_number
    ON assets(serial_number);

CREATE INDEX idx_assets_branch
    ON assets(branch_id);

CREATE INDEX idx_accountability_employee
    ON accountability_forms(employee_id);

CREATE INDEX idx_documents_accountability
    ON documents(accountability_id);

CREATE INDEX idx_documents_travel_report
    ON documents(travel_report_id);

CREATE INDEX idx_audit_logs_user
    ON audit_logs(user_id);

CREATE INDEX idx_audit_logs_created_at
    ON audit_logs(created_at DESC);

COMMIT;
