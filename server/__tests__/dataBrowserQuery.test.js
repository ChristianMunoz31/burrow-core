// Pure data-browser helpers: allowlist integrity, param validation, safe search
// construction, overview aggregation, redaction.
import { describe, it, expect } from 'vitest';
import { DATA_TABLES, getTableDef } from '../dataBrowser/tables.js';
import {
  parseListParams,
  sanitizeSearchTerm,
  buildSearch,
  aggregateOverview,
} from '../dataBrowser/query.js';
import { IMPORT_ORDER, TABLES } from '../db/index.js';
import {
  redactAppStateRow,
  redactValue,
  REDACTED,
} from '../dataBrowser/redact.js';

const EXPECTED_IDS = [
  'transactions',
  'todos',
  'todo_columns',
  'habits',
  'habit_completions',
  'notes',
  'journal',
  'bookmarks',
  'countdowns',
  'calendar_events',
  'focus_sessions',
  'jarvis_conversations',
  'jarvis_messages',
  'jarvis_memory',
  'app_state',
];

const tx = getTableDef('transactions');

describe('table config', () => {
  it('contains exactly the 15 allowlisted tables and never app_secrets', () => {
    expect(DATA_TABLES.map((t) => t.id).sort()).toEqual([...EXPECTED_IDS].sort());
    expect(getTableDef('app_secrets')).toBeUndefined();
    expect(getTableDef('__proto__')).toBeUndefined();
    expect(getTableDef('users')).toBeUndefined();
  });

  it.each(DATA_TABLES.map((t) => [t.id, t]))('%s is internally consistent', (_id, def) => {
    const names = def.columns.map((c) => c.name);
    expect(names).toContain(def.primaryKey);
    for (const c of [...def.sortable, ...def.search]) expect(names).toContain(c);
    if (def.dateColumn) expect(names).toContain(def.dateColumn);
    if (def.amountColumn) expect(names).toContain(def.amountColumn);
    expect(names).toContain(def.defaultSort.column);
    expect(def.sortable).toContain(def.defaultSort.column);
    for (const s of def.search) expect(def.columns.find((c) => c.name === s).type).toBe('text');
  });
});

describe('DATA_TABLES vs the db layer', () => {
  it('covers exactly the importable tables', () => {
    expect(DATA_TABLES.map((t) => t.id).sort()).toEqual([...IMPORT_ORDER].sort());
  });

  it.each(DATA_TABLES.map((t) => [t.id, t]))('%s column types match TABLES', (_id, def) => {
    const known = TABLES[def.id].columns;
    expect(def.columns.map((c) => c.name).sort()).toEqual(Object.keys(known).sort());
    for (const c of def.columns) expect(c.type).toBe(known[c.name]);
    expect(def.primaryKey).toBe(TABLES[def.id].primaryKey);
  });
});

describe('parseListParams', () => {
  it('applies defaults', () => {
    expect(parseListParams(tx, {})).toEqual({
      ok: true,
      params: { page: 1, pageSize: 25, sort: 'date', order: 'desc', q: '' },
    });
  });

  it('accepts valid params', () => {
    const res = parseListParams(tx, { page: '3', pageSize: '100', sort: 'amount', order: 'asc', q: 'cafe' });
    expect(res).toEqual({ ok: true, params: { page: 3, pageSize: 100, sort: 'amount', order: 'asc', q: 'cafe' } });
  });

  it.each(['0', '-1', '1.5', 'abc', '100001', ''])('rejects page %j', (page) => {
    expect(parseListParams(tx, { page })).toMatchObject({ ok: false, code: 'invalid_page' });
  });

  it.each(['0', '101', 'x', '-5'])('rejects pageSize %j', (pageSize) => {
    expect(parseListParams(tx, { pageSize })).toMatchObject({ ok: false, code: 'invalid_page_size' });
  });

  it.each(['amount; drop', 'nope', 'id', 'source_file', ['date', 'amount']])('rejects sort %j', (sort) => {
    expect(parseListParams(tx, { sort })).toMatchObject({ ok: false, code: 'invalid_sort' });
  });

  it('rejects a bad order and an over-long or non-string q', () => {
    expect(parseListParams(tx, { order: 'up' })).toMatchObject({ ok: false, code: 'invalid_order' });
    expect(parseListParams(tx, { q: 'a'.repeat(101) })).toMatchObject({ ok: false, code: 'invalid_query' });
    expect(parseListParams(tx, { q: ['a', 'b'] })).toMatchObject({ ok: false, code: 'invalid_query' });
    expect(parseListParams(tx, { q: 'a'.repeat(100) }).ok).toBe(true);
  });

  it('trims q before the length check and caps the reachable offset at 100,000 rows', () => {
    expect(parseListParams(tx, { q: `  ${'a'.repeat(100)}   ` }).ok).toBe(true);
    expect(parseListParams(tx, { q: `  ${'a'.repeat(101)}` })).toMatchObject({ ok: false, code: 'invalid_query' });
    expect(parseListParams(tx, { page: '1000', pageSize: '100' }).ok).toBe(true); // 100,000
    expect(parseListParams(tx, { page: '1001', pageSize: '100' })).toMatchObject({ ok: false, code: 'invalid_page' });
    expect(parseListParams(tx, { page: '100000', pageSize: '1' }).ok).toBe(true);
    expect(parseListParams(tx, { page: '100000', pageSize: '2' })).toMatchObject({ ok: false, code: 'invalid_page' });
  });

  it('treats an empty-after-sanitizing q as no filter', () => {
    expect(parseListParams(tx, { q: '%*,()' }).params.q).toBe('');
  });
});

describe('search construction', () => {
  it('strips wildcard/separator metacharacters and control chars, keeps _ . @ :', () => {
    expect(sanitizeSearchTerm('a,b(c)%')).toBe('abc');
    expect(sanitizeSearchTerm('a*b\\c"d')).toBe('abcd');
    expect(sanitizeSearchTerm('x\u0000y\u007fz\u001f')).toBe('xyz');
    expect(sanitizeSearchTerm('a_b.c@d:e')).toBe('a_b.c@d:e');
    expect(sanitizeSearchTerm('  two   words ')).toBe('two words');
    expect(sanitizeSearchTerm(42)).toBe('');
  });

  it('builds the search option from allowlisted columns with the sanitized term', () => {
    expect(buildSearch(tx, 'a,b(c)%')).toEqual({
      columns: ['merchant', 'category', 'type', 'source_file'],
      term: 'abc',
    });
  });

  it('returns null for empty terms and tables without search columns', () => {
    expect(buildSearch(tx, '')).toBeNull();
    expect(buildSearch(tx, '%%')).toBeNull();
    expect(buildSearch(getTableDef('habit_completions'), 'x')).toBeNull();
  });

  it('returns a copy so the frozen allowlist is never shared', () => {
    expect(buildSearch(tx, 'x').columns).not.toBe(tx.search);
  });
});

describe('aggregateOverview', () => {
  const rows = [
    { date: '2026-01-05', amount: '100.10' },
    { date: '2026-01-20', amount: -40.555 },
    { date: '2026-03-02T10:00:00+00:00', amount: -10 },
    { date: null, amount: 5 },
    { date: 'garbage', amount: 5 },
  ];

  it('buckets by month, fills gaps with zero, counts undated', () => {
    const out = aggregateOverview(tx, rows);
    expect(out.rowsOverTime).toEqual([
      { period: '2026-01', count: 2 },
      { period: '2026-02', count: 0 },
      { period: '2026-03', count: 1 },
    ]);
    expect(out.sampled).toBe(5);
    expect(out.undated).toBe(2);
  });

  it('computes income, expenses and net in cents', () => {
    const out = aggregateOverview(tx, rows);
    expect(out.amountByMonth).toEqual([
      { period: '2026-01', income: 100.1, expenses: 40.56, net: 59.54 },
      { period: '2026-02', income: 0, expenses: 0, net: 0 },
      { period: '2026-03', income: 0, expenses: 10, net: -10 },
    ]);
  });

  it('omits amountByMonth when the table has no amount column and handles empties', () => {
    const notes = getTableDef('notes');
    const out = aggregateOverview(notes, [{ created_at: '2026-02-01T00:00:00Z' }]);
    expect(out.amountByMonth).toBeUndefined();
    expect(out.rowsOverTime).toEqual([{ period: '2026-02', count: 1 }]);
    expect(aggregateOverview(tx, []).rowsOverTime).toEqual([]);
  });
});

describe('redaction', () => {
  it('redacts the whole value when the row key is sensitive', () => {
    const row = redactAppStateRow({ key: 'openai.apiKey', value: 'plain', updated_at: 't' });
    expect(row).toEqual({ key: 'openai.apiKey', value: REDACTED, updated_at: 't' });
  });

  it('redacts nested sensitive properties and keeps siblings', () => {
    const input = { a: { apiKey: 'x', keep: 1, list: [{ token: 1, ok: 'yes' }] } };
    expect(redactValue(input)).toEqual({
      a: { apiKey: REDACTED, keep: 1, list: [{ token: REDACTED, ok: 'yes' }] },
    });
  });

  it.each(['apiKey', 'api_key', 'OPENAI_API_KEY', 'authToken', 'session', 'password'])(
    'redacts the key %s',
    (k) => {
      expect(redactValue({ [k]: 'v' })[k]).toBe(REDACTED);
    },
  );

  it('does not redact author or authorName, or ordinary keys', () => {
    expect(redactValue({ author: 'me', authorName: 'you' })).toEqual({ author: 'me', authorName: 'you' });
    expect(redactAppStateRow({ key: 'jarvis.briefing.latest', value: { a: 1 } }).value).toEqual({ a: 1 });
    expect(redactAppStateRow({ key: 'budget:targets', value: [1, 2] }).value).toEqual([1, 2]);
  });

  it('redacts secret-looking strings under innocuous keys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig';
    expect(redactValue({ note: jwt, other: 'sk-abcdef0123456789abcd', fine: 'hello' })).toEqual({
      note: REDACTED,
      other: REDACTED,
      fine: 'hello',
    });
  });

  describe('broadened key matching', () => {
    it.each([
      'password', 'passwd', 'pwd', 'dbPwd', 'client_secret', 'access_token', 'refreshToken', 'x-api-key',
      'apiKey', 'API_KEY', 'credentials', 'awsCredential', 'privateKey', 'private-key', 'sessionId',
      'Set-Cookie', 'bearerToken', 'signature', 'sentryDsn', 'slackWebhook', 'jwt', 'auth', 'authToken',
      'Authorization', 'authorization',
    ])('redacts %s', (k) => {
      expect(redactValue({ [k]: 'v' })[k]).toBe(REDACTED);
    });

    it.each(['author', 'authorName', 'authors', 'theme', 'budget', 'amount', 'title', 'category', 'currency', 'coauthor'])(
      'keeps %s',
      (k) => {
        expect(redactValue({ [k]: 'dark' })[k]).toBe('dark');
      },
    );

    it('leaves ordinary values alone', () => {
      expect(redactValue({ author: 'Ada', theme: 'dark', budget: 1234.5, food: 300, nested: { limit: 50 } })).toEqual({
        author: 'Ada',
        theme: 'dark',
        budget: 1234.5,
        food: 300,
        nested: { limit: 50 },
      });
      expect(redactAppStateRow({ key: 'theme', value: 'dark' }).value).toBe('dark');
      expect(redactAppStateRow({ key: 'budget:targets', value: { food: 300 } }).value).toEqual({ food: 300 });
      expect(redactValue(['task-1', 'risk-free', 'ask-me', 'Bearer', 'plain text'])).toEqual([
        'task-1',
        'risk-free',
        'ask-me',
        'Bearer',
        'plain text',
      ]);
    });
  });

  describe('broadened value matching', () => {
    it.each([
      ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
      ['Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstu'],
      ['Google OAuth token', 'ya29.a0AfH6SMBx-example'],
      ['Stripe live', 'sk_live_abcdef123456'],
      ['Stripe test', 'sk_test_abcdef123456'],
      ['OpenAI-style', 'sk-abcdef0123456789'],
      ['Groq', 'gsk_abcdef0123456789'],
      ['GitHub PAT', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
      ['GitHub fine-grained', 'github_pat_11ABCDEFG0123456789_abcdef'],
      ['Slack', 'xoxb-123456789012-abcdef'],
      ['Bearer header', 'Bearer abc.def.ghi'],
      ['Bearer embedded', 'curl -H "Authorization: Bearer abcdef123456" https://x'],
      ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'],
      ['URL with userinfo', 'postgres://admin:hunter2@db.example.com:5432/app'],
      ['https URL with userinfo', 'https://user:p4ss@example.com/path'],
      ['value after punctuation', 'key=AKIAIOSFODNN7EXAMPLE'],
    ])('redacts a %s under an innocuous key', (_label, secret) => {
      expect(redactValue({ note: secret }).note).toBe(REDACTED);
    });

    it('does not redact look-alikes or plain URLs', () => {
      const ok = ['task-1', 'disk-usage', 'https://example.com/a@b', 'user@example.com', 'AKIA-short', 'eyJ short'];
      for (const v of ok) expect(redactValue({ note: v }).note).toBe(v);
    });
  });

  it('redacts sensitive strings inside arrays and arrays nested in objects', () => {
    expect(redactValue(['hello', 'sk-abcdef0123456789', ['nested', 'AKIAIOSFODNN7EXAMPLE']])).toEqual([
      'hello',
      REDACTED,
      ['nested', REDACTED],
    ]);
    expect(redactValue({ list: ['ok', 'Bearer abc123'] })).toEqual({ list: ['ok', REDACTED] });
  });

  describe('name/key + value pair objects', () => {
    it('redacts value when the label is sensitive', () => {
      expect(redactValue({ name: 'OPENAI_API_KEY', value: 'plain-looking' })).toEqual({
        name: 'OPENAI_API_KEY',
        value: REDACTED,
      });
      expect(redactValue({ key: 'dbPassword', value: { nested: 1 } })).toEqual({ key: 'dbPassword', value: REDACTED });
      expect(redactValue([{ name: 'slack_webhook', value: 'https://hooks.example/x' }])).toEqual([
        { name: 'slack_webhook', value: REDACTED },
      ]);
    });

    it('keeps value when the label is ordinary', () => {
      expect(redactValue({ name: 'theme', value: 'dark' })).toEqual({ name: 'theme', value: 'dark' });
      expect(redactValue({ key: 'food', value: 300 })).toEqual({ key: 'food', value: 300 });
    });
  });

  describe('extended key names', () => {
    it.each(['accessKey', 'access_key', 'access-key', 'accessKeyId', 'AWS_ACCESS_KEY_ID', 'pw', 'db_pw', 'pw_hash', 'passcode', 'adminPasscode'])(
      'redacts %s',
      (k) => {
        expect(redactValue({ [k]: 'v' })[k]).toBe(REDACTED);
      },
    );

    it.each(['power', 'pwa', 'access', 'accessLevel'])('keeps %s', (k) => {
      expect(redactValue({ [k]: 'v' })[k]).toBe('v');
    });
  });

  describe('[name, value] tuples', () => {
    it('redacts the second element when the first is a sensitive key', () => {
      expect(redactValue([['OPENAI_API_KEY', 'plain-looking'], ['theme', 'dark']])).toEqual([
        ['OPENAI_API_KEY', REDACTED],
        ['theme', 'dark'],
      ]);
      expect(redactValue(['dbPassword', { nested: 1 }])).toEqual(['dbPassword', REDACTED]);
    });

    it('does not treat longer arrays or non-string heads as pairs', () => {
      expect(redactValue(['token', 'a', 'b'])).toEqual(['token', 'a', 'b']);
      expect(redactValue([1, 'x'])).toEqual([1, 'x']);
    });
  });

  describe('JSON-looking strings', () => {
    it('parses, redacts sensitive keys and values, and re-serializes', () => {
      const out = redactValue({ blob: JSON.stringify({ apiKey: 'abc', keep: 1, list: ['ok', 'sk-abcdef0123456789'] }) });
      expect(JSON.parse(out.blob)).toEqual({ apiKey: REDACTED, keep: 1, list: ['ok', REDACTED] });
      expect(JSON.parse(redactValue('[["token","t"]]'))).toEqual([['token', REDACTED]]);
    });

    it('redacts JSON nested inside JSON strings', () => {
      const inner = JSON.stringify({ password: 'p' });
      const out = redactValue(JSON.stringify({ wrapped: inner }));
      expect(JSON.parse(JSON.parse(out).wrapped)).toEqual({ password: REDACTED });
    });

    it('leaves invalid JSON to the value regexes and keeps harmless JSON intact', () => {
      expect(redactValue('{not json')).toBe('{not json');
      expect(redactValue('{bad Bearer abcdef')).toBe(REDACTED);
      expect(JSON.parse(redactValue('{"a":1}'))).toEqual({ a: 1 });
    });

    it('does not parse strings over 64KB', () => {
      const big = JSON.stringify({ password: 'p', pad: 'x'.repeat(65 * 1024) });
      expect(redactValue(big)).toBe(big);
    });
  });

  describe('value scan cap', () => {
    it('still matches secrets within the first 4096 chars of a long string', () => {
      expect(redactValue(`sk-abcdef0123456789 ${'x'.repeat(10000)}`)).toBe(REDACTED);
    });

    it('conservatively redacts long strings containing :// and @ beyond the scanned head', () => {
      const long = `${'x'.repeat(5000)} postgres://u:p@h/db`;
      expect(redactValue(long)).toBe(REDACTED);
    });

    it('keeps long strings without :// and @', () => {
      const long = `${'x'.repeat(5000)} https://example.com/a`;
      expect(redactValue(long)).toBe(long);
    });
  });

  it('fails closed beyond depth 20', () => {
    let deep = { leaf: 'v' };
    for (let i = 0; i < 25; i += 1) deep = { n: deep };
    expect(JSON.stringify(redactValue(deep))).toContain(REDACTED);
  });

  it('never mutates its input', () => {
    const input = { a: { apiKey: 'x' }, b: [{ token: 't' }] };
    const copy = JSON.parse(JSON.stringify(input));
    redactValue(input);
    redactAppStateRow({ key: 'k', value: input });
    expect(input).toEqual(copy);
  });
});
