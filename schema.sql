
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
    external_id TEXT NOT NULL,
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
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(org_id, external_id)
);

CREATE TABLE IF NOT EXISTS walk_lists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    created_by_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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

CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON memberships(org_id);
CREATE INDEX IF NOT EXISTS idx_voters_org_id ON voters(org_id);
CREATE INDEX IF NOT EXISTS idx_voters_external_id ON voters(external_id);
CREATE INDEX IF NOT EXISTS idx_lists_org_id ON walk_lists(org_id);
CREATE INDEX IF NOT EXISTS idx_assignments_org_id ON assignments(org_id);
CREATE INDEX IF NOT EXISTS idx_assignments_canvasser ON assignments(canvasser_id);
CREATE INDEX IF NOT EXISTS idx_interactions_org_id ON interactions(org_id);
CREATE INDEX IF NOT EXISTS idx_interactions_voter_id ON interactions(voter_id);
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
