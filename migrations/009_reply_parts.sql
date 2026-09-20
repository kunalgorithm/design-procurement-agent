CREATE TABLE reply_parts (
  id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  text text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]',
  external_id text,
  sent_at timestamptz,
  UNIQUE(turn_id, position)
);
