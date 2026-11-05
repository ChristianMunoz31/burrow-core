import { Suspense, lazy, useState } from 'react';
import { useProfile } from '../../hooks/useProfile';

// The flow (and the Ollama setup step) only ships to people who still need onboarding.
const OnboardingFlow = lazy(() => import('./OnboardingFlow'));

/** Mounts the first-run flow until the profile is onboarded (never while it is loading). */
export default function Onboarding() {
  const { onboarded, isLoading, unresolved } = useProfile();
  // Dismissed (Escape/backdrop) only hides it for this session; it does not mark onboarded.
  const [dismissed, setDismissed] = useState(false);
  if (isLoading || unresolved || onboarded || dismissed) return null;
  return (
    <Suspense fallback={null}>
      <OnboardingFlow onDismiss={() => setDismissed(true)} />
    </Suspense>
  );
}
