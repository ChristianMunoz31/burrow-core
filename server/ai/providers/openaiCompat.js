// OpenAI-compatible transport (cloud AI, opt-in). Exposes the same event stream as the
// Ollama transport: { type: 'token' } | { type: 'tool_calls' } | { type: 'done' }.
// Tool calls use a non-streaming request; plain chat streams over SSE.
import { chatWithTools, streamChat } from '../llmClient.js';

/** The fixed Chat Completions path under the configured base URL. */
export const chatCompletionsUrl = (baseURL) => `${String(baseURL).replace(/\/+$/, '')}/chat/completions`;

/**
 * @param {{ baseURL: string, apiKey: string, model: string, messages: object[], tools?: object[],
 *   maxTokens?: number, temperature?: number, tokenParam?: string|null, format?: 'json', signal?: AbortSignal }} opts
 */
export async function* openaiCompatChatStream({ tools, ...rest }) {
  const opts = { ...rest, url: chatCompletionsUrl(rest.baseURL) };
  if (Array.isArray(tools) && tools.length) {
    const { message, finishReason, usage } = await chatWithTools({ ...opts, tools });
    if (message.content) yield { type: 'token', text: message.content };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      yield {
        type: 'tool_calls',
        calls: message.tool_calls.map((c, i) => ({
          id: typeof c?.id === 'string' && c.id ? c.id.slice(0, 64) : `call_${i}`,
          type: 'function',
          function: {
            name: typeof c?.function?.name === 'string' ? c.function.name : '',
            arguments: typeof c?.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c?.function?.arguments ?? {}),
          },
        })),
      };
    }
    yield { type: 'done', usage, finishReason: message.tool_calls?.length ? 'tool_calls' : finishReason };
    return;
  }
  yield* streamChat(opts);
}
