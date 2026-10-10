ALTER TABLE module_event_inbox ADD COLUMN push_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE module_event_inbox ADD COLUMN push_next_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE module_event_inbox ADD COLUMN push_lease_until TEXT;
ALTER TABLE module_event_inbox ADD COLUMN push_last_error TEXT;
ALTER TABLE module_event_inbox ADD COLUMN pushed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_feedback_push ON module_event_inbox(acknowledged_at,push_next_at,push_lease_until);
