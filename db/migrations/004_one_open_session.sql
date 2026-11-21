-- One open delivery session per shipper, enforced by the database. Run ONLY after scripts/repair-owner.mjs --apply has
-- repaired legacy data; the guard below stops the migration while any shipper still has several open sessions.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mealfit_sessions WHERE status IN ('notStarted', 'active', 'paused') GROUP BY owner_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Some shippers still have several open sessions. Run scripts/repair-owner.mjs --apply first.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS mealfit_sessions_one_open ON mealfit_sessions (owner_id) WHERE status IN ('notStarted', 'active', 'paused');
