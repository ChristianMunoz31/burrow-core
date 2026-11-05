import { useLocation } from 'react-router-dom';
import BurgerMenu from './BurgerMenu';
import TopBar from './TopBar';
import LazyCommandPalette from '../palette/LazyCommandPalette';
import JaviAdvisor from '../javi/JaviAdvisor';
import TrialNotice from '../license/TrialNotice';
import { PageContextProvider } from '../../contexts/PageContextContext';
import { useJaviSettings } from '../../hooks/useJaviSettings';
import { resolveJaviBarPageKey } from '../../constants/javiPages';
import { routeKey } from './routeKey';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

export default function AppShell({ children }) {
  const location = useLocation();
  useDocumentTitle(location.pathname);
  const { showButton, autoAdvise } = useJaviSettings();
  // No Javi bar or window on Home (the Javi card there), Settings and Folders (null page key).
  const javiPageKey = resolveJaviBarPageKey(location.pathname);
  // `showButton` only hides the Javi bar; Javi stays available (palette, javi:open, Alt+J).
  const javiAvailable = javiPageKey !== null;
  const barShown = showButton && javiAvailable;

  return (
    <PageContextProvider>
      {/* Static mesh background (gradients live in index.css): decorative, behind all content */}
      <div id="bg-layer" aria-hidden="true" />

      <div className="relative z-[1] min-h-screen flex">
        <BurgerMenu />
        <main tabIndex={-1} className="flex-1 min-w-0 flex flex-col focus:outline-none">
          <TopBar />
          <TrialNotice />
          {/* Keyed on the top-level segment so switching modules replays the
              fade/slide-in, while sub-routes within a module (e.g. /budget to
              /budget/planner) don't re-animate or remount.
              (Animation is disabled under prefers-reduced-motion; see index.css.)
              Bottom padding keeps the Javi bar from covering page controls. */}
          <div
            key={routeKey(location.pathname)}
            className={`flex-1 min-w-0 animate-page-in ${barShown ? 'pb-16' : ''}`}
          >
            {children}
          </div>
        </main>
        <LazyCommandPalette javiAvailable={javiAvailable} />
        {/* Inside the z-[1] stacking context, after the content: its z-40 sits above the TopBar (z-30) and
            below the drawer (z-50), burger and palette (z-[60]); root-level modals and toasts cover it. */}
        <JaviAdvisor pageKey={javiPageKey} visible={javiAvailable} showLauncher={showButton} autoAdvise={autoAdvise} />
      </div>
    </PageContextProvider>
  );
}
