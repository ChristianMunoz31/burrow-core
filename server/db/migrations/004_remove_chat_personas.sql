-- The standalone Chat page was removed. Drop its saved personas so they do not linger in the
-- database or in exports. Javi's conversations and memory are separate tables and stay.
DELETE FROM app_state WHERE key = 'pos:gpts';
