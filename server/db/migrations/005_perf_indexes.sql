-- Burrow schema v5: indexes for the newest-row scans and one lookup.
-- transactions/jarvis_messages (created_at): the license clock-evidence read is ORDER BY created_at DESC LIMIT 1.
-- jarvis_conversations (updated_at): listConversations orders by updated_at DESC NULLS FIRST, rowid DESC, which a reverse scan of an ascending index covers (a DESC index would need a temp B-tree for the rowid term).
-- habit_completions (habit_id, date): the toggle lookup and delete filter on both columns; it also serves
-- habit_id alone, so the single-column habit_completions_habit_idx is redundant and dropped.
CREATE INDEX IF NOT EXISTS transactions_created_idx ON transactions (created_at);
CREATE INDEX IF NOT EXISTS jarvis_messages_created_idx ON jarvis_messages (created_at);
CREATE INDEX IF NOT EXISTS jarvis_conversations_updated_idx ON jarvis_conversations (updated_at);
CREATE INDEX IF NOT EXISTS habit_completions_habit_date_idx ON habit_completions (habit_id, date);
DROP INDEX IF EXISTS habit_completions_habit_idx;
