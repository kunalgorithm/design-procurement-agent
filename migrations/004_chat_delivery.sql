ALTER TABLE turns ADD COLUMN generated_attachments jsonb;
ALTER TABLE turns ADD COLUMN failure_notified_at timestamptz;
ALTER TABLE turns ADD COLUMN notification_attempts integer NOT NULL DEFAULT 0;
-- Historical failures stay inspectable without sending new alerts during rollout.
UPDATE turns SET failure_notified_at=now() WHERE status='failed';
CREATE TABLE turn_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('progress','failure')),
  text text NOT NULL,
  sent_at timestamptz,
  UNIQUE(turn_id,phase)
);
CREATE TABLE project_media (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  mime_type text NOT NULL,
  filename text NOT NULL,
  bytes bytea NOT NULL,
  provider_attachment_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_media_conversation ON project_media(conversation_id);
