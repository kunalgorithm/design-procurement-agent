CREATE TABLE contractor_signups (
  id uuid PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL,
  website text,
  license_number text,
  agent_phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contractor_signups_created_at ON contractor_signups(created_at DESC);
