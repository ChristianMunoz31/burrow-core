import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import AppShell from './components/shell/AppShell';
import { PageSkeleton } from './components/shared/Skeleton';
import { ThemeProvider } from './contexts/ThemeContext';
import { ModeProvider } from './contexts/ModeContext';
import { AuthProvider } from './auth/useAuth';
import AuthGate from './auth/AuthGate';
import { ToastProvider } from './contexts/ToastContext';
import PendingSyncFlush from './components/PendingSyncFlush';
import Onboarding from './components/onboarding/Onboarding';

const Home = lazy(() => import('./pages/Home'));
const Budget = lazy(() => import('./pages/Budget'));
const Health = lazy(() => import('./pages/Health'));
const Todos = lazy(() => import('./pages/Todos'));
const Habits = lazy(() => import('./pages/Habits'));
const Journal = lazy(() => import('./pages/Journal'));
const Notes = lazy(() => import('./pages/Notes'));
const Bookmarks = lazy(() => import('./pages/Bookmarks'));
const Focus = lazy(() => import('./pages/Focus'));
const Folders = lazy(() => import('./pages/Folders'));
const Countdowns = lazy(() => import('./pages/Countdowns'));
const Calendar = lazy(() => import('./pages/Calendar'));
const Settings = lazy(() => import('./pages/Settings'));
const DataBrowser = lazy(() => import('./pages/DataBrowser'));

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AuthGate>
          <ModeProvider>
            <BrowserRouter>
              <ToastProvider>
                <PendingSyncFlush />
                <Onboarding />
                <AppShell>
                  <Suspense fallback={<PageSkeleton />}>
                    <Routes>
                      <Route path="/" element={<Home />} />
                      <Route path="/budget/*" element={<Budget />} />
                      {/* Weather shows in the Javi card on Home; old links land there */}
                      <Route path="/weather" element={<Navigate to="/" replace />} />
                      <Route path="/health" element={<Health />} />
                      <Route path="/todos" element={<Todos />} />
                      <Route path="/habits" element={<Habits />} />
                      <Route path="/focus" element={<Focus />} />
                      <Route path="/folders" element={<Folders />} />
                      <Route path="/countdowns" element={<Countdowns />} />
                      <Route path="/calendar" element={<Calendar />} />
                      <Route path="/journal" element={<Journal />} />
                      <Route path="/notes" element={<Notes />} />
                      <Route path="/bookmarks" element={<Bookmarks />} />
                      <Route path="/settings" element={<Settings />} />
                      <Route path="/settings/data" element={<DataBrowser />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </Suspense>
                </AppShell>
              </ToastProvider>
            </BrowserRouter>
          </ModeProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
