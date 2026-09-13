ALTER TABLE messages ADD COLUMN service text;
ALTER TABLE turns ADD COLUMN reaction_attempted_at timestamptz;
