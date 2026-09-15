ALTER TABLE contractor_signups ADD COLUMN business_name text;
CREATE INDEX contractor_signups_agent_phone_phone ON contractor_signups(agent_phone, phone);

ALTER TABLE conversations ADD COLUMN participant_handles text[];
ALTER TABLE conversations ADD COLUMN contractor_signup_id uuid REFERENCES contractor_signups(id);
