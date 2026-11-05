// Edge cases for the number check (server/javi/groundedNumbers.js) and the fixed-copy notices built on it.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../profile.js', () => ({ getDisplayName: vi.fn(async () => null) }));

import { checkGroundedNumbers, extractNumbers } from '../javi/groundedNumbers.js';
import { MSG_UNGROUNDED, generateAdvice, streamAdvice } from '../javi/advisorService.js';
import { clearAdviceCache } from '../javi/adviceCache.js';

const un = (answer, facts = '', opts) => checkGroundedNumbers(answer, facts, opts).ungrounded;

describe('formats of the same figure', () => {
  it('$1,234.50 matches a fact of 1234.5 either way round', () => {
    expect(un('Spent $1,234.50.', '{"v":1234.5}')).toEqual([]);
    expect(un('Spent $1234.5.', '{"v":"1,234.50"}')).toEqual([]);
    expect(un('Spent 4,521.', '{"v":4521}')).toEqual([]);
    expect(un('Spent 4521.', 'total 4,521')).toEqual([]);
  });

  it('signs do not matter: "over by $102" matches -102, and -$40.00 matches 40', () => {
    expect(un('You are over by $102.00.', '{"over":-102}')).toEqual([]);
    expect(un('Down -$40.00 this week.', '{"x":40}')).toEqual([]);
    expect(un('Down -$41.00 this week.', '{"x":40}')).toEqual(['$41.00']);
  });

  it('12% matches 12 and 12.0, but 12.5% does not match 12', () => {
    expect(un('Up 12% and 12.0%.', '{"p":12}')).toEqual([]);
    expect(un('Up 12 percent.', '{"p":12.0}')).toEqual([]);
    expect(un('Up 12.5%.', '{"p":12}')).toEqual(['12.5%']);
    expect(un('Up 12%.', '{"p":12.4}')).toEqual([]); // rounds at the precision shown
  });

  it('rounds at the precision the answer shows ($252 and 252.4 ground to 252.4, $252.00 and $253 do not)', () => {
    const facts = '{"v":252.4}';
    expect(un('$252', facts)).toEqual([]);
    expect(un('252.4', facts)).toEqual([]);
    expect(un('$252.4', facts)).toEqual([]);
    expect(un('$252.00', facts)).toEqual(['$252.00']);
    expect(un('$253', facts)).toEqual(['$253']);
  });

  it('a small money amount or percent is still checked even though small bare integers are not', () => {
    expect(un('Only $3 left and 4% more.', '')).toEqual(['$3', '4%']);
    expect(un('Only 3 left.', '')).toEqual([]);
  });
});

describe('text that only looks numeric', () => {
  it('ignores years, ISO dates, slash dates, month names, times and ordinals', () => {
    const answer =
      'In 2024, on 12/25/2025, Oct. 5, 2026, 5 Oct 2026, 2026-10-09T10:00:00Z, at 7:45pm, 9:30 AM, 22:15:10, 10 PM, the 21st and 3rd.';
    expect(un(answer)).toEqual([]);
  });

  it('ignores list markers at line start ("1." and "2)")', () => {
    expect(un('1. First\n2) Second\n  12. Twelfth\n  15) Fifteenth')).toEqual([]);
  });

  it('ignores a bold list marker like **1.**', () => {
    expect(un('**1.** Pay rent\n**2.** Call the bank')).toEqual([]);
  });

  it('ignores a bold list marker above the small-integer cutoff, like **12.**', () => {
    // A marker is wording, not data: "**12.**" must not raise the "figure not in your data" notice.
    expect(un('**12.** Pay rent')).toEqual([]);
  });

  it('does not read digits glued to a leading letter or underscore (ids)', () => {
    expect(extractNumbers('abc123 x_55 id9')).toEqual([]);
  });

  it('an id or uuid copied from the facts verbatim stays grounded', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const facts = JSON.stringify({ id: uuid, ref: 'item-4521', code: 'abc123' });
    expect(un(`Todo ${uuid} (item-4521, abc123) is open.`, facts)).toEqual([]);
  });

  it('does not treat a fraction like 45/50 as two invented figures', () => {
    expect(un('You finished 45/50 tasks.')).toEqual([]);
  });
});

describe('degenerate input', () => {
  it('handles empty, whitespace, non-string and number-free answers', () => {
    for (const a of ['', '   \n', null, undefined, 42, {}, [], 'no digits here']) {
      expect(checkGroundedNumbers(a, '{"a":5000}')).toEqual({ ungrounded: [], grounded: [] });
    }
  });

  it('treats empty, null and undefined facts as "nothing is grounded"', () => {
    for (const f of ['', null, undefined]) expect(un('You spent $5,000.', f)).toEqual(['$5,000']);
  });

  it('reports each distinct figure once, in order of appearance', () => {
    expect(un('$99.99 then $88.88 then $99.99')).toEqual(['$99.99', '$88.88']);
  });

  it('handles a huge digit run without throwing', () => {
    expect(() => checkGroundedNumbers('9'.repeat(400), '')).not.toThrow();
  });
});

describe('performance', () => {
  const timed = (fn) => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it('checks a 100 KB answer against 100 KB of facts quickly (target 50 ms, asserted at 250 ms for a loaded machine)', () => {
    const answer = 'Spent $12.34 on 45 items, up 7%. '.repeat(3200);
    const facts = '{"a":12.34,"b":45,"c":7}'.repeat(4000);
    expect(answer.length).toBeGreaterThan(100_000);
    checkGroundedNumbers(answer.slice(0, 2000), facts); // warm up
    expect(timed(() => checkGroundedNumbers(answer, facts))).toBeLessThan(250);
  });

  it('stays linear on adversarial text (digit run, comma run, dollar run, whitespace run, marker run)', () => {
    const cases = ['1'.repeat(100_000), '9,'.repeat(50_000), `${'$'.repeat(50_000)}5`, `${' '.repeat(100_000)}1`, '1. '.repeat(30_000), 'Oct '.repeat(25_000)];
    for (const text of cases) expect(timed(() => checkGroundedNumbers(text, ''))).toBeLessThan(500);
  });
});

describe('notices are fixed copy and never echo a figure', () => {
  const client = (content, finishReason = 'stop') => ({
    provider: 'ollama',
    model: 'qwen2.5:3b',
    purpose: 'chat',
    numCtx: 8192,
    stats: { calls: 0 },
    complete: vi.fn(async () => ({ content, usage: null, model: 'qwen2.5:3b', finishReason })),
    stream: vi.fn(async function* stream() {
      yield { type: 'token', text: content };
      yield { type: 'done', usage: null, finishReason };
    }),
  });
  const input = { page: 'budget', pageLabel: 'Budget', context: '{"spend":100}', messages: [] };

  it('advice (JSON and stream) uses MSG_UNGROUNDED, which holds no digit', async () => {
    clearAdviceCache();
    const a = await generateAdvice(input, { client: client('- You owe $7,654.32 and 87.5%.') });
    const s = await streamAdvice(input, { client: client('- You owe $7,654.32 and 87.5%.') });
    for (const out of [a, s]) {
      expect(out.notice).toBe(MSG_UNGROUNDED);
      expect(out.groundingNote).toBe(MSG_UNGROUNDED);
      expect(out.notice).not.toContain('7,654');
    }
    expect(MSG_UNGROUNDED).not.toMatch(/\d/);
  });

  it('a grounded answer carries no notice at all', async () => {
    const a = await generateAdvice(input, { client: client('- Spend is $100.00.') });
    expect(a.notice).toBeNull();
  });
});
