-- Trusted admin choices belong to one private session, never the signup profile.
ALTER TABLE conversations ADD COLUMN role_override text;
ALTER TABLE conversations ADD COLUMN role_override_sender text;
ALTER TABLE conversations ADD CONSTRAINT conversations_role_override_check CHECK (
  (role_override IS NULL AND role_override_sender IS NULL) OR
  (role_override IS NOT NULL AND role_override IN ('homeowner','contractor')
    AND role_override_sender IS NOT NULL AND role_override_sender ~ '^\+[1-9][0-9]{7,14}$')
);
