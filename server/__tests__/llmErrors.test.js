// Pure-unit coverage of the AI error classifier (server/ai/llmErrors.js): rate limits from an
// optional cloud provider, plus the local cases (Ollama down, timeout, model missing).
import { describe, it, expect } from 'vitest';
import { FRIENDLY, classifyLLMError, isConnectionError } from '../ai/llmErrors.js';

describe('classifyLLMError', () => {
  it('flags a per-day quota error', () => {
    const e = new Error('429 RequestsPerDay quota exceeded');
    e.httpStatus = 429;
    const c = classifyLLMError(e);
    expect(c.scope).toBe('day');
    expect(c.isRateLimit).toBe(true);
  });

  it('flags a per-minute rate limit', () => {
    const e = new Error('Rate limit reached: requests per minute');
    e.httpStatus = 429;
    expect(classifyLLMError(e).scope).toBe('minute');
  });

  it('treats a bare 429 as a per-minute blip', () => {
    const e = new Error('Too many requests');
    e.httpStatus = 429;
    expect(classifyLLMError(e).scope).toBe('minute');
  });

  it('classifies a non-rate-limit error as unknown (no retry)', () => {
    const e = new Error('Internal Server Error');
    e.httpStatus = 500;
    const c = classifyLLMError(e);
    expect(c.scope).toBe('unknown');
    expect(c.isRateLimit).toBe(false);
  });

  it('passes through an explicit retryAfterMs', () => {
    const e = new Error('429 slow down');
    e.httpStatus = 429;
    e.retryAfterMs = 5000;
    expect(classifyLLMError(e).retryMs).toBe(5000);
  });

  it('returns a friendly message for every scope', () => {
    const e = new Error('boom');
    expect(typeof classifyLLMError(e).friendly).toBe('string');
    expect(classifyLLMError(e).friendly.length).toBeGreaterThan(0);
  });

  it('maps ECONNREFUSED / ENOTFOUND / tagged transport errors to unavailable', () => {
    expect(classifyLLMError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })).scope).toBe('unavailable');
    expect(classifyLLMError(Object.assign(new Error('getaddrinfo'), { cause: { code: 'ENOTFOUND' } })).scope).toBe('unavailable');
    expect(classifyLLMError(Object.assign(new Error('Ollama request failed'), { code: 'unavailable' })).scope).toBe('unavailable');
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isConnectionError(new Error('plain'))).toBe(false);
  });

  it('maps an Ollama "model not found" body to model_missing', () => {
    const e = Object.assign(new Error('Ollama HTTP 404'), { httpStatus: 404, body: '{"error":"model \\"nope:1b\\" not found, try pulling it first"}' });
    expect(classifyLLMError(e).scope).toBe('model_missing');
    expect(classifyLLMError(Object.assign(new Error('x'), { code: 'model_missing' })).friendly).toBe(FRIENDLY.model_missing);
  });

  it('maps timeouts to timeout', () => {
    expect(classifyLLMError(Object.assign(new Error('t'), { isTimeout: true })).scope).toBe('timeout');
    expect(classifyLLMError(Object.assign(new Error('t'), { code: 'timeout' })).httpStatus).toBe(504);
  });

  it('never assumes a cloud quota for local failures, and never echoes provider text', () => {
    const e = Object.assign(new Error('Ollama HTTP 500'), { httpStatus: 500, body: 'SECRET-UPSTREAM-BODY' });
    const c = classifyLLMError(e);
    expect(c.friendly).toBe(FRIENDLY.unknown);
    expect(c.friendly).not.toMatch(/quota|billing/i);
    expect(JSON.stringify(c)).not.toContain('SECRET-UPSTREAM-BODY');
    for (const msg of Object.values(FRIENDLY)) expect(msg).not.toMatch(/[‒-―]/);
  });
});
