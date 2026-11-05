-- Developer-only features (GitHub page, key testing opt-in) were removed. Drop their saved
-- token and the leftover settings so nothing stale stays in the database or in exports.
DELETE FROM app_secrets WHERE name = 'GITHUB_TOKEN';
UPDATE app_state SET value = json_remove(value, '$.github', '$.keyTest')
  WHERE key = 'network.optIn' AND json_valid(value) AND json_type(value) = 'object';
UPDATE app_state SET value = json_remove(value, '$.cards.github')
  WHERE key = 'pos:homeLayout' AND json_valid(value) AND json_type(value, '$.cards') = 'object';
