import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as core from '../proExtensions';
import {
  NO_JAVI_AGENT,
  PRO_EXTENSION_NAMES,
  noAgentToolLabel,
  useNoInsightsExplain,
  useNoJaviAgent,
} from '../proDefaults';
import { EMPTY_AGENT } from '../../components/javi/timeline';

// Contract of the core extension module (docs/adr/0001-open-core-split.md 3.11): the Pro module exports the same
// names, so a host never has to check whether a name exists, only whether a component is null.
describe('core proExtensions module', () => {
  it('exports exactly PRO_EXTENSION_NAMES', () => {
    expect(PRO_EXTENSION_NAMES).toHaveLength(10);
    expect(Object.isFrozen(PRO_EXTENSION_NAMES)).toBe(true);
    expect(Object.keys(core).sort()).toEqual([...PRO_EXTENSION_NAMES].sort());
  });

  it('is the build without the Pro UI', () => {
    expect(core.PRO_UI_INCLUDED).toBe(false);
  });

  it('has no Pro components', () => {
    for (const name of ['JaviComposer', 'ConfirmActionCard', 'BriefingMessage', 'FolderAskPanel', 'FolderReportWriter']) {
      expect(core[name], name).toBeNull();
    }
  });

  it('uses the documented defaults', () => {
    expect(core.useJaviAgent).toBe(useNoJaviAgent);
    expect(core.useInsightsExplain).toBe(useNoInsightsExplain);
    expect(core.agentToolLabel).toBe(noAgentToolLabel);
    expect(core.agentToolLabel('add_todo')).toBe('');
    expect(core.AGENT_UNREACHABLE_MESSAGE).toBeNull();
  });
});

describe('useNoJaviAgent', () => {
  it('returns the frozen empty agent with every field of the useJarvis return', () => {
    const { result } = renderHook(() => useNoJaviAgent());
    expect(result.current).toBe(NO_JAVI_AGENT);
    expect(Object.isFrozen(NO_JAVI_AGENT)).toBe(true);
    expect(Object.keys(NO_JAVI_AGENT).sort()).toEqual(
      ['messages', 'tools', 'actions', 'pendingCount', 'running', 'error', 'errorCode', 'errorReason', 'send', 'stop', 'reset', 'respond'].sort(),
    );
    for (const key of Object.keys(EMPTY_AGENT)) expect(NO_JAVI_AGENT[key]).toBe(EMPTY_AGENT[key]);
    expect(NO_JAVI_AGENT.pendingCount).toBe(0);
  });

  it('does nothing on send, stop and reset, and answers respond with an error result', async () => {
    expect(NO_JAVI_AGENT.send('hello', { page: 'todos' })).toBeUndefined();
    expect(NO_JAVI_AGENT.stop()).toBeUndefined();
    expect(NO_JAVI_AGENT.reset()).toBeUndefined();
    await expect(NO_JAVI_AGENT.respond('t'.repeat(32), true)).resolves.toEqual({ status: 'error', name: null });
  });
});

describe('useNoInsightsExplain', () => {
  it('starts empty and explain() only marks the Pro attempt', () => {
    const { result } = renderHook(() => useNoInsightsExplain({ result: null, summaryKey: 'k' }));
    expect(result.current).toMatchObject({
      explaining: false,
      explanation: '',
      error: '',
      unavailable: false,
      unavailableReason: null,
      unavailableMessage: null,
      proAttempted: false,
    });
    act(() => result.current.explain());
    expect(result.current.proAttempted).toBe(true);
    expect(result.current.explanation).toBe('');
    expect(result.current.explaining).toBe(false);
  });
});
