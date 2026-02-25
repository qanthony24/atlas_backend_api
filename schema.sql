
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'pending_delete')),
    plan_id TEXT NOT NULL DEFAULT 'starter',
    limits JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin', 'canvasser')),
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, email)
);

-- -------------------------
-- Phase 3: Campaign onboarding scaffolding
-- -------------------------

CREATE TABLE IF NOT EXISTS campaign_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    office_type TEXT,
    district_type TEXT,
    election_date DATE,
    win_number_target INTEGER,
    expected_turnout INTEGER,
    geography_unit_type TEXT,
    campaign_phase TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id)
);

CREATE TABLE IF NOT EXISTS campaign_goals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    goal_type TEXT NOT NULL CHECK (goal_type IN ('doors', 'contacts', 'ids', 'turnout')),
    target_value INTEGER NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS geography_units (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    unit_type TEXT NOT NULL,
    external_id TEXT,
    name TEXT NOT NULL,
    past_turnout INTEGER,
    past_dem_result DOUBLE PRECISION,
    geometry_json JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, unit_type, external_id)
);

-- -------------------------

CREATE TABLE IF NOT EXISTS memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('admin', 'canvasser')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, user_id)
);

CREATE TABLE IF NOT EXISTS voters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    -- For imported/registered voters: registration number (stable upsert key).
    -- For manual leads: may be NULL.
    external_id TEXT,
    source TEXT NOT NULL DEFAULT 'import' CHECK (source IN ('import', 'manual')),
    -- If a lead is merged into an imported voter, we store the target here (manual review only).
    merged_into_voter_id UUID,
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    suffix TEXT,
    age INTEGER,
    gender TEXT,
    race TEXT,
    party TEXT,
    phone TEXT,
    address TEXT NOT NULL,
    unit TEXT,
    city TEXT NOT NULL,
    state TEXT,
    zip TEXT NOT NULL,
    geom_lat DOUBLE PRECISION,
    geom_lng DOUBLE PRECISION,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voter_merge_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    lead_voter_id UUID NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    imported_voter_id UUID NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, lead_voter_id, imported_voter_id)
);

CREATE TABLE IF NOT EXISTS walk_lists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Phase 3: Turf Engine v1 (Milestone 3)
ALTER TABLE walk_lists ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'static' CHECK (type IN ('static', 'turf'));
ALTER TABLE walk_lists ADD COLUMN IF NOT EXISTS turf_strategy TEXT CHECK (turf_strategy IN ('precinct', 'grid', 'radius', 'filter'));
ALTER TABLE walk_lists ADD COLUMN IF NOT EXISTS geography_unit_id UUID;
ALTER TABLE walk_lists ADD COLUMN IF NOT EXISTS target_contact_goal INTEGER;

CREATE TABLE IF NOT EXISTS turf_metadata (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    list_id UUID NOT NULL REFERENCES walk_lists(id) ON DELETE CASCADE,
    voter_count INTEGER NOT NULL DEFAULT 0,
    unit_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    completion_percentage DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, list_id)
);

CREATE TABLE IF NOT EXISTS list_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    list_id UUID NOT NULL REFERENCES walk_lists(id) ON DELETE CASCADE,
    voter_id UUID NOT NULL REFERENCES voters(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, list_id, voter_id)
);

CREATE TABLE IF NOT EXISTS assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    list_id UUID NOT NULL REFERENCES walk_lists(id) ON DELETE CASCADE,
    canvasser_id UUID NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('assigned', 'in_progress', 'completed')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID NOT NULL REFERENCES users(id),
    voter_id UUID NOT NULL REFERENCES voters(id),
    assignment_id UUID REFERENCES assignments(id),
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('canvass')),
    result_code TEXT NOT NULL CHECK (result_code IN ('contacted', 'not_home', 'refused', 'moved', 'inaccessible', 'deceased')),
    notes TEXT,
    client_interaction_uuid TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, client_interaction_uuid)
);

CREATE TABLE IF NOT EXISTS survey_responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    interaction_id UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    responses JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Phase 3: Metrics aggregates (Milestone 2)
-- -------------------------

CREATE TABLE IF NOT EXISTS voter_contact_summary (
    org_id UUID PRIMARY KEY REFERENCES organizations(id),
    doors_knocked INTEGER NOT NULL DEFAULT 0,
    contacts INTEGER NOT NULL DEFAULT 0,
    ids INTEGER NOT NULL DEFAULT 0,
    last_occurred_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assignment_progress_summary (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    assignment_id UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    list_id UUID NOT NULL REFERENCES walk_lists(id) ON DELETE CASCADE,
    canvasser_id UUID NOT NULL REFERENCES users(id),
    total_voters INTEGER NOT NULL DEFAULT 0,
    contacted_voters INTEGER NOT NULL DEFAULT 0,
    completion_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_activity_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, assignment_id)
);

CREATE TABLE IF NOT EXISTS goal_progress_summary (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    goal_id UUID NOT NULL REFERENCES campaign_goals(id) ON DELETE CASCADE,
    goal_type TEXT NOT NULL,
    target_value INTEGER NOT NULL,
    current_value INTEGER NOT NULL DEFAULT 0,
    completion_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, goal_id)
);

CREATE TABLE IF NOT EXISTS geography_progress_summary (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    geography_unit_id UUID NOT NULL REFERENCES geography_units(id) ON DELETE CASCADE,
    contacted_voters INTEGER NOT NULL DEFAULT 0,
    total_voters INTEGER,
    completion_pct DOUBLE PRECISION,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, geography_unit_id)
);

CREATE TABLE IF NOT EXISTS import_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK (type IN ('import_voters', 'export_data')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    file_key TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    result JSONB,
    error TEXT,
    metadata JSONB
);

CREATE TABLE IF NOT EXISTS platform_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID REFERENCES users(id),
    event_type TEXT NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action TEXT NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES users(id),
    target_org_id UUID NOT NULL REFERENCES organizations(id),
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB
);

-- Back-compat migrations (schema.sql is run at startup)
-- IMPORTANT: schema.sql runs on every boot (API + worker). Keep these idempotent.
DO $$
BEGIN
  -- Drop NOT NULL only if it is currently set.
  IF EXISTS (
    SELECT 1
      FROM pg_attribute a
     WHERE a.attrelid = 'voters'::regclass
       AND a.attname = 'external_id'
       AND a.attnotnull = true
  ) THEN
    ALTER TABLE voters ALTER COLUMN external_id DROP NOT NULL;
  END IF;
END $$;

ALTER TABLE voters ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'import';
ALTER TABLE voters ADD COLUMN IF NOT EXISTS merged_into_voter_id UUID;

-- Replace unconditional unique(org_id, external_id) with partial uniqueness.
-- (Allows manual leads with NULL external_id while preserving stable upsert for imported voters.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'voters_org_id_external_id_key'
  ) THEN
    ALTER TABLE voters DROP CONSTRAINT voters_org_id_external_id_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_voters_org_external_id_not_null
  ON voters(org_id, external_id)
  WHERE external_id IS NOT NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_campaign_profiles_org_id ON campaign_profiles(org_id);
CREATE INDEX IF NOT EXISTS idx_campaign_goals_org_id ON campaign_goals(org_id);
CREATE INDEX IF NOT EXISTS idx_geography_units_org_id ON geography_units(org_id);
CREATE INDEX IF NOT EXISTS idx_assignment_progress_org_id ON assignment_progress_summary(org_id);
CREATE INDEX IF NOT EXISTS idx_goal_progress_org_id ON goal_progress_summary(org_id);
CREATE INDEX IF NOT EXISTS idx_geography_progress_org_id ON geography_progress_summary(org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_voters_org_id ON voters(org_id);
CREATE INDEX IF NOT EXISTS idx_voters_external_id ON voters(external_id);
CREATE INDEX IF NOT EXISTS idx_voters_org_source ON voters(org_id, source);
CREATE INDEX IF NOT EXISTS idx_voters_org_merged_into ON voters(org_id, merged_into_voter_id);
CREATE INDEX IF NOT EXISTS idx_merge_alerts_org_status ON voter_merge_alerts(org_id, status);
CREATE INDEX IF NOT EXISTS idx_merge_alerts_org_created_at ON voter_merge_alerts(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lists_org_id ON walk_lists(org_id);
CREATE INDEX IF NOT EXISTS idx_lists_org_type ON walk_lists(org_id, type);
CREATE INDEX IF NOT EXISTS idx_turf_metadata_org_id ON turf_metadata(org_id);
CREATE INDEX IF NOT EXISTS idx_assignments_org_id ON assignments(org_id);
CREATE INDEX IF NOT EXISTS idx_assignments_canvasser ON assignments(canvasser_id);
CREATE INDEX IF NOT EXISTS idx_interactions_org_id ON interactions(org_id);
CREATE INDEX IF NOT EXISTS idx_interactions_voter_id ON interactions(voter_id);
CREATE INDEX IF NOT EXISTS idx_interactions_org_occurred_at ON interactions(org_id, occurred_at DESC);

-- Ensure at most one survey_responses row per interaction (retry-safe)
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_responses_org_interaction_id ON survey_responses(org_id, interaction_id);

CREATE INDEX IF NOT EXISTS idx_import_jobs_org_id ON import_jobs(org_id);

INSERT INTO organizations (id, name, status, plan_id)
VALUES ('11111111-1111-1111-1111-111111111111', 'Demo Campaign', 'active', 'enterprise')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, org_id, name, email, role, password_hash)
VALUES 
('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Admin User', 'admin@example.com', 'admin', 'password'),
('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Canvasser Bob', 'bob@example.com', 'canvasser', 'password')
ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (org_id, user_id, role)
VALUES
('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'admin'),
('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'canvasser')
ON CONFLICT (org_id, user_id) DO NOTHING;
