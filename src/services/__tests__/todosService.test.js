import { afterEach, describe, expect, it, vi } from 'vitest';
import { todosService } from '../todosService';
import { GENERIC_ERROR } from '../../utils/apiError';
import { todoColumnsService } from '../todoColumnsService';

const respond = (status, body, statusText = 'Bad') =>
  vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    statusText,
    json: () => Promise.resolve(body),
  });

describe('todo services error handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not surface a raw server error string', async () => {
    vi.stubGlobal('fetch', respond(500, { error: 'SQLITE_ERROR: no such table' }, 'Server Error'));
    const err = await todosService.list().catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toBe(GENERIC_ERROR);
    expect(err.message).not.toContain('SQLITE');
  });

  it('uses the fixed message from the server body when present', async () => {
    vi.stubGlobal('fetch', respond(400, { error: 'invalid_body', message: 'Check what you entered.' }));
    const err = await todoColumnsService.create({ name: '' }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Check what you entered.');
  });
});
