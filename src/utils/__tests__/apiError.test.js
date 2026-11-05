import { describe, expect, it } from 'vitest';
import {
  GENERIC_ERROR,
  buildApiError,
  errorText,
  isNetworkOptInError,
  userError,
  userMessage,
} from '../apiError';

describe('errorText', () => {
  it('uses the human message for the structured codes', () => {
    expect(
      errorText({ error: 'ai_not_configured', message: 'AI is not configured. Add a provider in Settings.' }, 'x'),
    ).toBe('AI is not configured. Add a provider in Settings.');
    expect(errorText({ error: 'network_opt_in_required', message: 'Weather is off.' }, 'x')).toBe('Weather is off.');
  });

  it('shows body.message, maps known codes, and never renders a raw error string', () => {
    expect(errorText({ error: 'whatever', message: 'Friendly text.' }, 'fallback')).toBe('Friendly text.');
    expect(errorText({ error: 'action_not_found' }, 'fallback')).toMatch(/expired or was already handled/);
    expect(errorText({ error: 'Boom' }, 'fallback')).toBe('fallback');
    expect(errorText({ error: 'SQLITE_ERROR: no such table' }, 'fallback')).toBe('fallback');
    expect(errorText({}, 'fallback')).toBe('fallback');
    expect(errorText(null, 'fallback')).toBe('fallback');
  });
});

describe('buildApiError', () => {
  it('flags the opt-in error with code, feature and status', () => {
    const err = buildApiError(
      { status: 403, statusText: 'Forbidden' },
      { error: 'network_opt_in_required', feature: 'weather', message: 'Weather is off.' },
    );
    expect(isNetworkOptInError(err)).toBe(true);
    expect(err).toMatchObject({ status: 403, feature: 'weather', message: 'Weather is off.' });
  });

  it('does not flag ordinary failures', () => {
    const err = buildApiError({ status: 503, statusText: 'Unavailable' }, {});
    expect(isNetworkOptInError(err)).toBe(false);
    expect(err.message).toBe(GENERIC_ERROR);
  });
});

describe('userFacing and userMessage', () => {
  it('marks an error userFacing only when the text is the server own copy', () => {
    const withMessage = buildApiError({ status: 400, statusText: 'Bad Request' }, { error: 'x', message: 'Title is required.' });
    expect(withMessage).toMatchObject({ message: 'Title is required.', userFacing: true, status: 400 });
    const friendly = buildApiError({ status: 404, statusText: 'Not Found' }, { error: 'action_not_found' });
    expect(friendly.userFacing).toBe(true);
    expect(friendly.message).toMatch(/expired or was already handled/);
    const busy = buildApiError({ status: 429, statusText: 'Too Many' }, { error: 'ai_busy' });
    expect(busy).toMatchObject({ userFacing: true, code: 'ai_busy' });
  });

  it('falls back to the generic text, never statusText, when the body has no human copy', () => {
    const bare = buildApiError({ status: 500, statusText: 'Internal Server Error' }, { error: 'title is required' });
    expect(bare.message).toBe(GENERIC_ERROR);
    expect(bare.userFacing).toBeUndefined();
    expect(buildApiError({ status: 503, statusText: 'Service Unavailable' }, null).message).toBe(GENERIC_ERROR);
  });

  it('userMessage shows userFacing text and hides everything else', () => {
    expect(userMessage(userError('1 of 3 could not be removed'))).toBe('1 of 3 could not be removed');
    expect(userMessage(new Error('boom'))).toBe(GENERIC_ERROR);
    expect(userMessage(new Error('boom'), 'Could not save.')).toBe('Could not save.');
    expect(userMessage(Object.assign(new Error('x'), { userFacing: 'yes' }))).toBe(GENERIC_ERROR);
    expect(userMessage(undefined)).toBe(GENERIC_ERROR);
    expect(userMessage(null, 'Fallback')).toBe('Fallback');
  });

  it('userError builds a userFacing Error', () => {
    const err = userError('Fixed copy');
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ message: 'Fixed copy', userFacing: true });
  });
});
