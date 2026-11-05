// Shared loading/error short-circuit for page builders.
export const LOADING_CONTEXT = Object.freeze({ status: 'loading' });
export const ERROR_CONTEXT = Object.freeze({ status: 'error' });

/**
 * @param {{ loading?: boolean, error?: unknown }} input
 * @returns {{ status: 'loading' | 'error' } | null}
 */
export function statusContext({ loading, error } = {}) {
  if (loading) return { ...LOADING_CONTEXT };
  if (error) return { ...ERROR_CONTEXT };
  return null;
}
