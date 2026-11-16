/** Shared append-only SDK migration sequence. Never edit shipped entries. */
export const STORAGE_MIGRATIONS = [
  "CREATE TABLE IF NOT EXISTS team_resource_state (scope TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS team_resource_quota (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS team_resource_provider_pools (provider TEXT PRIMARY KEY, pools TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS team_execution_events (id TEXT PRIMARY KEY, scope TEXT NOT NULL, operation TEXT NOT NULL, timestamp REAL NOT NULL, data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS team_execution_events_scope ON team_execution_events(scope,operation,timestamp)",
];
