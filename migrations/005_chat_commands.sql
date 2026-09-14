-- Quiesce old workers and block incoming traffic: older ingest code requires the original unique constraint.
ALTER TABLE conversations ADD COLUMN archived_at timestamptz;
ALTER TABLE conversations DROP CONSTRAINT conversations_channel_external_id_key;
CREATE UNIQUE INDEX conversations_active_chat ON conversations(channel,external_id) WHERE archived_at IS NULL;
ALTER TABLE messages ADD COLUMN is_control boolean NOT NULL DEFAULT false;
ALTER TABLE turns DROP CONSTRAINT turns_kind_check;
ALTER TABLE turns ADD CONSTRAINT turns_kind_check CHECK (kind IN ('agent','operator','control'));
