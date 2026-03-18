DROP INDEX IF EXISTS idx_agent_deployments_agent_id;
DROP INDEX IF EXISTS idx_agent_deployments_target;
DROP INDEX IF EXISTS idx_agent_deployments_active_target;
DROP TABLE IF EXISTS agent_deployments_new;

CREATE TABLE agent_deployments_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO agent_deployments_new (
  id, tenant_id, agent_id, agent_version_id, target_type, target_id, status, created_at, updated_at
)
SELECT
  id, tenant_id, agent_id, agent_version_id, target_type, target_id, status, created_at, updated_at
FROM agent_deployments;

DROP TABLE agent_deployments;

ALTER TABLE agent_deployments_new RENAME TO agent_deployments;

CREATE INDEX idx_agent_deployments_agent_id
ON agent_deployments(agent_id);

CREATE INDEX idx_agent_deployments_target
ON agent_deployments(target_type, target_id, status);

CREATE UNIQUE INDEX idx_agent_deployments_active_target
ON agent_deployments(target_type, target_id)
WHERE status = 'active';
