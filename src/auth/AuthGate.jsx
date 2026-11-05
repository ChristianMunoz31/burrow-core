import { useAuth } from './useAuth';
import LoginScreen from './LoginScreen';

export default function AuthGate({ children }) {
  const { loading, enabled, authenticated } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-slate600 border-t-slate-slate100" />
      </div>
    );
  }

  if (enabled && !authenticated) return <LoginScreen />;

  return children;
}
