import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import * as apiError from '../apiError';
import { PRO_NOT_INCLUDED, buildApiError, isProNotIncludedError } from '../apiError';
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
  });

  it('has no pro_required code any more and does not match other errors', () => {
    expect(apiError.PRO_REQUIRED).toBeUndefined();
    expect(apiError.isProRequiredError).toBeUndefined();
    expect(isProNotIncludedError(buildApiError({ status: 403 }, { error: 'forbidden', message: 'No.' }))).toBe(false);
    expect(isProNotIncludedError(new Error('x'))).toBe(false);
    expect(isProNotIncludedError(null)).toBe(false);
  });

  it('client copy is the exact text of the server MSG_PRO_NOT_INCLUDED', () => {
    const src = readFileSync(resolve(process.cwd(), 'server/pro.js'), 'utf8');
    const match = src.match(/MSG_PRO_NOT_INCLUDED\s*=\s*\n?\s*'([^']+)'/);
    expect(match?.[1]).toBe(PRO_NOT_INCLUDED_COPY);
  });

  it('client copy offers nothing to buy and never says Pro', () => {
    expect(PRO_NOT_INCLUDED_COPY).toBe(
      'This build of Burrow does not include this feature. The official Burrow app includes it at no cost.',
    );
    expect(PRO_NOT_INCLUDED_COPY).not.toMatch(/\bpro\b|buy|upgrade|trial|license/i);
  });
});
