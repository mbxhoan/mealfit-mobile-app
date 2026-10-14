CREATE TABLE IF NOT EXISTS mealfit_accounts (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  role text NOT NULL CHECK (role IN ('admin', 'user', 'shipper')),
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mealfit_accounts_name_idx ON mealfit_accounts (lower(name));

INSERT INTO mealfit_accounts (id, name, role) VALUES
  ('admin', 'Admin', 'admin'),
  ('user', 'Nhân viên', 'user'),
  ('hieu', 'Hiếu', 'shipper'),
  ('hoan', 'Hoàn', 'shipper'),
  ('shipper', 'Shipper', 'shipper')
ON CONFLICT (id) DO NOTHING;
