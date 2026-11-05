// Pure helpers for the data browser: param validation, safe search construction and
// overview aggregation. No I/O.

const MAX_PAGE = 100000;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 100000;
const MAX_Q_LENGTH = 100;

const fail = (code, error) => ({ ok: false, code, error });
const isInt = (v) => typeof v === 'string' && /^\d+$/.test(v);

/**
 * Absent param = default; present-but-invalid = failure.
 * @param {import('./tables.js').DataTableDef} def
 * @param {Record<string, unknown>} query
 */
export function parseListParams(def, query = {}) {
  const q = query || {};

  let page = 1;
  if (q.page !== undefined) {
    if (!isInt(q.page) || Number(q.page) < 1 || Number(q.page) > MAX_PAGE) {
      return fail('invalid_page', 'page must be an integer between 1 and 100000');
    }
    page = Number(q.page);
  }

  let pageSize = 25;
  if (q.pageSize !== undefined) {
    if (!isInt(q.pageSize) || Number(q.pageSize) < 1 || Number(q.pageSize) > MAX_PAGE_SIZE) {
      return fail('invalid_page_size', 'pageSize must be an integer between 1 and 100');
    }
    pageSize = Number(q.pageSize);
  }

  let sort = def.defaultSort.column;
  if (q.sort !== undefined) {
    if (typeof q.sort !== 'string' || !def.sortable.includes(q.sort)) {
      return fail('invalid_sort', 'sort is not a sortable column of this table');
    }
    sort = q.sort;
  }

  let order = def.defaultSort.order;
  if (q.order !== undefined) {
    if (q.order !== 'asc' && q.order !== 'desc') return fail('invalid_order', 'order must be asc or desc');
    order = q.order;
  }

  let search = '';
  if (q.q !== undefined) {
    if (typeof q.q !== 'string' || q.q.trim().length > MAX_Q_LENGTH) {
      return fail('invalid_query', 'q must be a string of at most 100 characters');
    }
    search = sanitizeSearchTerm(q.q);
  }

  // Deep OFFSET scans are expensive; cap how far a page window can reach.
  if (page * pageSize > MAX_OFFSET) {
    return fail('invalid_page', 'page is beyond the browsable range (first 100000 rows)');
  }

  return { ok: true, params: { page, pageSize, sort, order, q: search } };
}

/**
 * Normalizes the echoed search term: collapses whitespace and strips `% * \ " , ( )` and
 * control chars. The term is bound as a parameter, so this is hygiene, not the safety net.
 * @param {unknown} q
 * @returns {string}
 */
export function sanitizeSearchTerm(q) {
  if (typeof q !== 'string') return '';
  return (
    q
      .replace(/\s+/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[%*\\",()\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Builds the `search` option for the db query helper. Columns come only from the
 * allowlist; the term is bound as a parameter (case-insensitive substring, no wildcards).
 * @param {import('./tables.js').DataTableDef} def
 * @param {string} term
 * @returns {{ columns: string[], term: string } | null} null = no filter
 */
export function buildSearch(def, term) {
  const clean = sanitizeSearchTerm(term);
  return clean && def.search.length ? { columns: [...def.search], term: clean } : null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const PERIOD_RE = /^\d{4}-\d{2}$/;

function monthRange(first, last) {
  const out = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Monthly aggregation of already-fetched rows.
 * @param {import('./tables.js').DataTableDef} def
 * @param {Array<Record<string, unknown>>} rows
 */
export function aggregateOverview(def, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!def.dateColumn) {
    return { rowsOverTime: null, sampled: list.length, undated: 0 };
  }
  const counts = new Map();
  const money = new Map();
  let undated = 0;
  for (const row of list) {
    const raw = row?.[def.dateColumn];
    const period = raw == null ? '' : String(raw).slice(0, 7);
    if (!PERIOD_RE.test(period)) {
      undated += 1;
      continue;
    }
    counts.set(period, (counts.get(period) || 0) + 1);
    if (def.amountColumn) {
      const amount = Number(row[def.amountColumn]);
      if (row[def.amountColumn] != null && Number.isFinite(amount)) {
        const bucket = money.get(period) || { income: 0, expenses: 0 };
        if (amount > 0) bucket.income += amount;
        else if (amount < 0) bucket.expenses += Math.abs(amount);
        money.set(period, bucket);
      }
    }
  }
  const periods = [...counts.keys()].sort();
  const filled = periods.length ? monthRange(periods[0], periods[periods.length - 1]) : [];
  const result = {
    rowsOverTime: filled.map((period) => ({ period, count: counts.get(period) || 0 })),
    sampled: list.length,
    undated,
  };
  if (def.amountColumn) {
    result.amountByMonth = filled.map((period) => {
      const { income = 0, expenses = 0 } = money.get(period) || {};
      return {
        period,
        income: round2(income),
        expenses: round2(expenses),
        net: round2(income - expenses),
      };
    });
  }
  return result;
}
