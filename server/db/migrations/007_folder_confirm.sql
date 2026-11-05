-- Burrow schema v7: imported folders wait for the user to confirm them before Burrow reads anything.
ALTER TABLE folders ADD COLUMN confirm_state TEXT NOT NULL DEFAULT 'ok' CHECK (confirm_state IN ('ok', 'needs_confirm'));
