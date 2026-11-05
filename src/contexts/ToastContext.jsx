import { createContext, useCallback, useContext, useState } from 'react';

const ToastContext = createContext(null);

const DEFAULT_DURATION_MS = 3000;
const ERROR_DURATION_MS = 6000;

// Glass surface with accent text (adaptive tokens, readable in both themes).
const TYPE_CLASS = {
  error: 'text-accent-red',
  success: 'text-accent-green',
  info: 'text-slate-slate100',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  // Errors stay longer so they can be read; an explicit duration always wins.
  const toast = useCallback(({ message, type = 'info', duration }) => {
    const ms = duration ?? (type === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS);
    // Use a combination of timestamp and a counter to avoid Date.now() collisions
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ms);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className="fixed bottom-[calc(var(--javi-toast-offset,1rem)+env(safe-area-inset-bottom))] right-4 sm:right-[var(--javi-toast-right,1rem)] z-[200] flex flex-col gap-2 pointer-events-none"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            className={`glass-strong px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-overlay-in ${
              TYPE_CLASS[t.type] ?? TYPE_CLASS.info
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
