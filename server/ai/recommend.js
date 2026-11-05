// First-run model recommendation and Ollama install detection. Pure: no I/O, no env reads
// (callers pass the platform, env and an exists() probe). The picks are chosen so that
// pickAutoModels (registry.js) turns an install into the chat and tools models: the tool model
// is the largest tools-capable model (qwen2.5:7b when present), and the chat model is the
// smallest text model of at least 2.5B parameters below it (llama3.2:3b), else the same model.

const GIB = 1024 ** 3;

const LLAMA_1B = Object.freeze({
  name: 'llama3.2:1b',
  downloadGb: 1.3,
  purpose: 'both',
  reason: 'Small enough to run on a computer with limited memory. Answers are simpler, but it works.',
});
const LLAMA_3B = Object.freeze({
  name: 'llama3.2:3b',
  downloadGb: 2.0,
  purpose: 'both',
  reason: 'A good balance of speed and quality for most computers.',
});
const LLAMA_3B_FAST = Object.freeze({
  name: 'llama3.2:3b',
  downloadGb: 2.0,
  purpose: 'chat',
  reason: 'Fast replies for everyday questions.',
});
const QWEN_7B_OPTIONAL = Object.freeze({
  name: 'qwen2.5:7b',
  downloadGb: 4.7,
  purpose: 'both',
  reason: 'Smarter and better at using your data, but slower on this computer. Optional.',
});
const QWEN_7B_TOOLS = Object.freeze({
  name: 'qwen2.5:7b',
  downloadGb: 4.7,
  purpose: 'tools',
  reason: 'Best at looking things up in your data and making changes you approve.',
});

// The small search model behind Folders questions. Not part of any recommendation tier: it is
// downloaded only on an explicit click on the Folders page.
export const NOMIC_EMBED = Object.freeze({
  name: 'nomic-embed-text',
  downloadGb: 0.3,
  purpose: 'embed',
  reason: 'Lets you ask questions about folders you add. Small enough for any computer.',
});

/** Every model the setup flow may download. The pull route accepts nothing else. */
export const PULLABLE_MODELS = new Set([LLAMA_1B.name, LLAMA_3B.name, QWEN_7B_OPTIONAL.name, NOMIC_EMBED.name]);

/**
 * Recommend models for the machine's total memory.
 * @param {number} totalBytes Total RAM in bytes.
 * @returns {{ tier: 'tiny'|'small'|'medium'|'large', ramGb: number, primary: object[], optional: object[] }}
 */
export function recommendModels(totalBytes) {
  const gib = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes / GIB : 0;
  const ramGb = Math.round(gib * 10) / 10;
  if (gib < 6) return { tier: 'tiny', ramGb, primary: [{ ...LLAMA_1B }], optional: [] };
  if (gib < 10) return { tier: 'small', ramGb, primary: [{ ...LLAMA_3B }], optional: [] };
  if (gib < 14.5) return { tier: 'medium', ramGb, primary: [{ ...LLAMA_3B }], optional: [{ ...QWEN_7B_OPTIONAL }] };
  return { tier: 'large', ramGb, primary: [{ ...QWEN_7B_TOOLS }, { ...LLAMA_3B_FAST }], optional: [] };
}

/**
 * Whether the Ollama app or binary exists at a well-known install path.
 * @param {{ platform: string, env?: Record<string, string | undefined>, exists: (path: string) => boolean }} opts
 * @returns {boolean}
 */
export function detectOllamaInstall({ platform, env = {}, exists }) {
  if (typeof exists !== 'function') return false;
  const paths = [];
  if (platform === 'win32') {
    const base = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
    if (base) paths.push(`${base.replace(/[\\/]+$/, '')}\\Programs\\Ollama\\ollama.exe`);
  } else if (platform === 'darwin') {
    paths.push('/Applications/Ollama.app', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama');
  } else if (platform === 'linux') {
    paths.push('/usr/local/bin/ollama', '/usr/bin/ollama');
  }
  return paths.some((p) => {
    try {
      return exists(p) === true;
    } catch {
      return false;
    }
  });
}
