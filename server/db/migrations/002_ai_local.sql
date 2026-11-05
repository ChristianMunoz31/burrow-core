-- Phase 2: local AI (Ollama). The removed cloud providers' saved keys and the old
-- Javi provider/model choice no longer mean anything; drop them so they are not kept
-- around encrypted or exported. AI settings now live in app_state 'ai.settings'.
DELETE FROM app_secrets WHERE name IN ('BEDROCK_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
DELETE FROM app_state WHERE key IN ('jarvis.provider', 'jarvis.model');
