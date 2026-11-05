import { describe, it, expect } from 'vitest';
import { buildTimeline } from '../timeline';

const msg = (id, role, content, at) => ({ id, role, content, ...(at === undefined ? {} : { at }) });

describe('buildTimeline', () => {
  it('returns an empty list for missing inputs', () => {
    expect(buildTimeline(null, null)).toEqual([]);
    expect(buildTimeline({ messages: [] }, { messages: [], actions: [] })).toEqual([]);
  });

  it('interleaves advice, agent messages and actions by time', () => {
    const thread = { messages: [msg('a1', 'assistant', 'advice', 10)] };
    const agent = {
      messages: [msg('u1', 'user', 'add milk', 20), msg('b1', 'assistant', 'On it', 20)],
      actions: [{ token: 't1', at: 30 }],
    };
    expect(buildTimeline(thread, agent).map((i) => i.key)).toEqual(['advice:a1', 'agent:u1', 'agent:b1', 'a:t1']);
  });

  it('skips empty assistant placeholders but keeps empty user text out of the way', () => {
    const agent = { messages: [msg('u1', 'user', 'hi', 5), msg('b1', 'assistant', '', 5)], actions: [] };
    expect(buildTimeline(null, agent).map((i) => i.key)).toEqual(['agent:u1']);
  });

  it('treats a missing timestamp as 0 and sorts stably', () => {
    const thread = { messages: [msg('a1', 'assistant', 'x'), msg('a2', 'user', 'y')] };
    const agent = { messages: [msg('u1', 'user', 'z', 1)] };
    expect(buildTimeline(thread, agent).map((i) => i.key)).toEqual(['advice:a1', 'advice:a2', 'agent:u1']);
  });

  it('tags kinds and carries the original objects', () => {
    const action = { token: 't', at: 1 };
    const [item] = buildTimeline(null, { messages: [], actions: [action] });
    expect(item.kind).toBe('action');
    expect(item.action).toBe(action);
  });

  it('keeps keys unique when advice and agent messages share an id', () => {
    const thread = { messages: [msg('1', 'assistant', 'advice', 1)] };
    const agent = { messages: [msg('1', 'assistant', 'reply', 2)] };
    const keys = buildTimeline(thread, agent).map((i) => i.key);
    expect(new Set(keys).size).toBe(2);
  });
});
