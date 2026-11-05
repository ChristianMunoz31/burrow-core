// Core defaults for the Pro UI extension points (docs/adr/0001-open-core-split.md 3.11, docs/OPEN_CORE.md).
// `src/extensions/proExtensions.js` re-exports these under the names in PRO_EXTENSION_NAMES. A build with the
// Pro module swaps that file for the Pro UI entry module (Vite plugin `burrow-pro-ui`, scripts/build/proUi.js),
// which exports the same names. Hosts treat a null component as "not in this build" and fall back to core UI.
import { useCallback, useState } from 'react';
import { EMPTY_AGENT } from '../components/javi/timeline';

/** The 10 extension names, in contract order. Both modules export exactly these. */
export const PRO_EXTENSION_NAMES = Object.freeze([
  'PRO_UI_INCLUDED',
  'useJaviAgent',
  'agentToolLabel',
  'AGENT_UNREACHABLE_MESSAGE',
  'JaviComposer',
  'ConfirmActionCard',
  'BriefingMessage',
  'useInsightsExplain',
  'FolderAskPanel',
  'FolderReportWriter',
]);

const noop = () => {};

/** What a build without the Javi agent returns: an empty agent whose actions do nothing. */
export const NO_JAVI_AGENT = Object.freeze({
  ...EMPTY_AGENT,
  pendingCount: 0,
  send: noop,
  stop: noop,
  reset: noop,
  respond: () => Promise.resolve(Object.freeze({ status: 'error', name: null })),
});

/** Default `useJaviAgent`: no agent in this build. Calls no React hook, so it is stable in any position. */
export function useNoJaviAgent() {
  return NO_JAVI_AGENT;
}

/** Default `agentToolLabel`: no tool chips to label. */
export const noAgentToolLabel = () => '';

/**
 * Default `useInsightsExplain`: nothing to explain in this build. `explain()` only sets `proAttempted`, so the
 * card shows the not-included notice (NotIncludedNotice).
 */
export function useNoInsightsExplain() {
  const [proAttempted, setProAttempted] = useState(false);
  const explain = useCallback(() => setProAttempted(true), []);
  return {
    explaining: false,
    explanation: '',
    error: '',
    unavailable: false,
    unavailableReason: null,
    unavailableMessage: null,
    proAttempted,
    explain,
  };
}
