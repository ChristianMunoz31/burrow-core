import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { PRO_NOT_INCLUDED, PRO_REQUIRED, buildApiError, isProNotIncludedError, isProRequiredError } from '../apiError';
import { PRO_NOT_INCLUDED_COPY } from '../../constants/proFeatures';

// 501 { error: 'pro_not_included', code, feature, message } (docs/adr/0001-open-core-split.md 3.8).
const BODY = { error: 'pro_not_included', code: 'pro_not_included', feature: 'explain', message: PRO_NOT_INCLUDED_COPY };

describe('pro_not_included', () => {
  it('is a structured code with the server copy and the feature', () => {
    expect(PRO_NOT_INCLUDED).toBe('pro_not_included');
    const err = buildApiError({ status: 501, statusText: 'Not Implemented' }, BODY);
    expect(err).toMatchObject({ status: 501, code: PRO_NOT_INCLUDED, feature: 'explain', userFacing: true });
    expect(err.message).toBe(PRO_NOT_INCLUDED_COPY);
    expect(isProNotIncludedError(err)).toBe(true);
    expect(isProRequiredError(err)).toBe(false);
  });

  it('does not match pro_required or other errors', () => {
    const required = buildApiError({ status: 403 }, { error: PRO_REQUIRED, feature: 'explain', message: 'Pro.' });
    expect(isProNotIncludedError(required)).toBe(false);
    expect(isProNotIncludedError(new Error('x'))).toBe(false);
    expect(isProNotIncludedError(null)).toBe(false);
  });

  it('client copy is the exact text of the server MSG_PRO_NOT_INCLUDED', () => {
    const src = readFileSync(resolve(process.cwd(), 'server/pro.js'), 'utf8');
    const match = src.match(/MSG_PRO_NOT_INCLUDED\s*=\s*\n?\s*'([^']+)'/);
    expect(match?.[1]).toBe(PRO_NOT_INCLUDED_COPY);
  });
});
