ALTER TABLE handoffs DROP CONSTRAINT handoffs_kind_check;
ALTER TABLE handoffs ADD CONSTRAINT handoffs_kind_check CHECK (kind IN ('design','proposal','procurement','finalization','human'));
ALTER TABLE handoffs DROP CONSTRAINT handoffs_status_check;
ALTER TABLE handoffs ADD CONSTRAINT handoffs_status_check CHECK (status IN ('open','completed','superseded'));
ALTER TABLE handoffs ADD COLUMN design_approval jsonb;
ALTER TABLE handoffs ADD CONSTRAINT handoffs_finalization_evidence CHECK (kind!='finalization' OR design_approval IS NOT NULL);
CREATE INDEX handoffs_design_finalization ON handoffs(conversation_id,created_at DESC) WHERE kind='finalization';
ALTER TABLE conversations ADD COLUMN participant_roles jsonb NOT NULL DEFAULT '{}';
