import { useState } from 'react';
import { useAuth } from './useAuth';

export default function LoginScreen() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await login(password);
    } catch (err) {
      setError(err.message || 'Login failed');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="glass-strong w-full max-w-sm rounded-2xl p-6"
      >
        <h1 className="text-xl font-semibold text-slate-slate100">Burrow</h1>
        <p className="mt-1 text-sm text-slate-slate400">Enter your password to continue.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="glass-input mt-4 w-full rounded-md px-3 py-2 text-sm"
        />
        {error && <p className="mt-2 text-sm text-red-red">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-4 w-full rounded-md bg-blue-blue px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
