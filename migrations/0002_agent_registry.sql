ALTER TABLE agents ADD COLUMN slug TEXT;
ALTER TABLE agents ADD COLUMN description TEXT;
ALTER TABLE agents ADD COLUMN default_version_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_tenant_slug
ON agents(tenant_id, slug);

CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  version TEXT NOT NULL,
  model TEXT,
  config_r2_key TEXT,
  manifest_r2_key TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_id_status
ON agent_versions(agent_id, status);

CREATE TABLE IF NOT EXISTS agent_capabilities (
  id TEXT PRIMARY KEY,
  agent_version_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  config_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_capabilities_version_id
ON agent_capabilities(agent_version_id);

CREATE INDEX IF NOT EXISTS idx_agent_capabilities_capability
ON agent_capabilities(capability);

CREATE TABLE IF NOT EXISTS agent_tool_bindings (
  id TEXT PRIMARY KEY,
  agent_version_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(agent_version_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_bindings_version_id
ON agent_tool_bindings(agent_version_id);

CREATE TABLE IF NOT EXISTS agent_deployments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(target_type, target_id, status)
);

CREATE INDEX IF NOT EXISTS idx_agent_deployments_agent_id
ON agent_deployments(agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_deployments_target
ON agent_deployments(target_type, target_id, status);
