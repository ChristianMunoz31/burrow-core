// The Pro UI extension points of the core build: every one is a "not in this build" default (proDefaults.js).
// Path frozen: a build with the Pro module swaps this exact file for the Pro UI entry module (Vite plugin
// `burrow-pro-ui`), so no Pro UI code reaches a build without it. Vitest has no Vite plugins and always sees
// this file; Pro UI tests vi.mock it with the Pro module (docs/OPEN_CORE.md).
import { noAgentToolLabel, useNoInsightsExplain, useNoJaviAgent } from './proDefaults';

/** False in the core build: the private module's UI is not compiled in, so hosts show the not-included notice. */
export const PRO_UI_INCLUDED = false;
export const useJaviAgent = useNoJaviAgent;
export const agentToolLabel = noAgentToolLabel;
export const AGENT_UNREACHABLE_MESSAGE = null;
export const JaviComposer = null;
export const ConfirmActionCard = null;
export const BriefingMessage = null;
export const useInsightsExplain = useNoInsightsExplain;
export const FolderAskPanel = null;
export const FolderReportWriter = null;
