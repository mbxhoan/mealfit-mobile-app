-- Server-authoritative sessions: delivery facts that every device must read identically are stored, not re-derived per device.
-- Additive only: nullable columns and a wider CHECK. Old code ignores both.
ALTER TABLE mealfit_orders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE mealfit_orders ADD COLUMN IF NOT EXISTS delivery_method text;

-- User actions are recorded as idempotent commands.
ALTER TABLE mealfit_operations DROP CONSTRAINT IF EXISTS mealfit_operations_entity_type_check;
ALTER TABLE mealfit_operations ADD CONSTRAINT mealfit_operations_entity_type_check CHECK (entity_type IN ('order', 'session', 'command'));

-- Command lookups for repairing orphaned in-transit orders per account.
CREATE INDEX IF NOT EXISTS mealfit_orders_session_idx ON mealfit_orders (session_id) WHERE session_id IS NOT NULL;
