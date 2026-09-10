CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('linq', 'sandbox')),
  is_group boolean NOT NULL DEFAULT false,
  owner_handle text,
  paused boolean NOT NULL DEFAULT false,
  brief jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial UNIQUE NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_id text UNIQUE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'operator')),
  sender text NOT NULL,
  text text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]',
  provider_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation ON messages(conversation_id, seq DESC);
CREATE TABLE webhook_events (
  id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_order bigserial UNIQUE NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'operator')),
  through_seq bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed','cancelled')),
  operator_text text,
  decision jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX turns_one_pending_agent ON turns(conversation_id) WHERE status='pending' AND kind='agent';
CREATE INDEX turns_queue ON turns(status, available_at);
CREATE TABLE handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL UNIQUE REFERENCES turns(id),
  kind text NOT NULL CHECK (kind IN ('design','proposal','procurement','human')),
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX handoffs_one_open_kind ON handoffs(conversation_id,kind) WHERE status='open';
