import { buildApiError } from '../utils/apiError';

const PROXY_URL = '/api';

export const sheetsService = {
  // Fetch a published Google Sheets CSV via the backend proxy (avoids CORS;
  // the server enforces an SSRF allowlist). Returns the raw CSV text.
  async fetchCsv(url) {
    const response = await fetch(`${PROXY_URL}/sheets/csv?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw buildApiError(response, data);
    }
    return data.csv || '';
  },
};
