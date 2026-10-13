CREATE TABLE IF NOT EXISTS mealfit_orders (
  code text PRIMARY KEY,
  row_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  ordered_at timestamptz,
  subtotal bigint NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  shipping_fee bigint NOT NULL DEFAULT 0 CHECK (shipping_fee >= 0),
  total bigint NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid_amount bigint NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  remaining_due bigint NOT NULL DEFAULT 0 CHECK (remaining_due >= 0),
  payment_status text NOT NULL DEFAULT 'Chưa thanh toán' CHECK (payment_status IN ('Chưa thanh toán', 'Đã thanh toán')),
  shipping_status text NOT NULL DEFAULT 'Chưa giao hàng' CHECK (shipping_status IN ('Chưa giao hàng', 'Đang giao hàng', 'Đã giao hàng', 'Đã huỷ đơn')),
  shipper_name text NOT NULL DEFAULT 'Chưa phân công',
  assigned_user_id text,
  note text NOT NULL DEFAULT '',
  maps_url text NOT NULL DEFAULT '',
  session_id text,
  payments jsonb NOT NULL DEFAULT '[]'::jsonb,
  items jsonb DEFAULT '[]'::jsonb,
  source_revision bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mealfit_orders_updated_idx ON mealfit_orders (updated_at DESC, code DESC);
CREATE INDEX IF NOT EXISTS mealfit_orders_shipper_status_idx ON mealfit_orders (assigned_user_id, shipping_status, ordered_at DESC, code DESC);

CREATE TABLE IF NOT EXISTS mealfit_sessions (
  session_id text PRIMARY KEY,
  owner_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('notStarted', 'active', 'paused', 'completed', 'cancelled')),
  payload jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mealfit_sessions_owner_idx ON mealfit_sessions (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS mealfit_operations (
  operation_id text PRIMARY KEY,
  actor_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('order', 'session')),
  entity_id text NOT NULL,
  body_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mealfit_payment_events (
  payment_id text PRIMARY KEY,
  order_code text NOT NULL REFERENCES mealfit_orders(code),
  session_id text,
  actor_id text NOT NULL,
  method text NOT NULL CHECK (method IN ('Tiền mặt', 'Chuyển khoản', 'Khác')),
  amount bigint NOT NULL CHECK (amount >= 0),
  paid_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS mealfit_payment_session_idx ON mealfit_payment_events (session_id, method);

CREATE TABLE IF NOT EXISTS mealfit_upstream_outbox (
  operation_id text PRIMARY KEY,
  order_code text NOT NULL REFERENCES mealfit_orders(code),
  target_revision bigint NOT NULL,
  request_body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'conflict')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mealfit_outbox_ready_idx ON mealfit_upstream_outbox (next_attempt_at, created_at) WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS mealfit_outbox_order_idx ON mealfit_upstream_outbox (order_code, target_revision);

CREATE TABLE IF NOT EXISTS mealfit_media (
  media_id text PRIMARY KEY,
  order_code text NOT NULL REFERENCES mealfit_orders(code),
  blob_pathname text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'deleted')),
  n8n_file_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mealfit_media_order_idx ON mealfit_media (order_code, created_at);

CREATE TABLE IF NOT EXISTS mealfit_conflicts (
  conflict_id text PRIMARY KEY,
  order_code text NOT NULL REFERENCES mealfit_orders(code),
  app_revision bigint NOT NULL,
  sheet_revision bigint NOT NULL,
  app_payload jsonb NOT NULL,
  sheet_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved-sheet', 'resolved-app')),
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS mealfit_conflicts_open_idx ON mealfit_conflicts (created_at DESC) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS mealfit_audit_log (
  audit_id bigserial PRIMARY KEY,
  actor_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  operation text NOT NULL,
  operation_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mealfit_audit_entity_idx ON mealfit_audit_log (entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mealfit_auth_attempts (
  ip_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mealfit_sync_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
