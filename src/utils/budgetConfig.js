// Runtime budget config: merges Burrow's static budget taxonomy (groups +
// categories, in budgetConfig.json) with hand-curated overrides (fallback
// budgets + merchant hints, in budgetOverrides.json).
//
// Exports BUCKETS for existing components, plus new exports (CATEGORIES / categorizeTransaction / getCategoryBudget)
// for subcategory-aware views.
// budgetOverrides.json keys are 'GroupDisplay / SubcategoryName' (see budgetConfig.json
// categories[].key). fallbackBudget is the baseline monthly budget per category; it
// starts at 0 and is set in onboarding or the Budget Planner. Merchant hint lists
// are empty by default.
import config from '../data/budgetConfig.json';
import overrides from '../data/budgetOverrides.json';

// --- UI palette (display-only) ---
const BUCKET_THEMES = {
  Savings: {
    id: 'savings',
    accent: 'bg-green-green',
  },
  'Fixed Bills': {
    id: 'fixed_bills',
    accent: 'bg-slate-slateBlue',
  },
  Essentials: {
    id: 'essentials',
    accent: 'bg-yellow-yellow',
  },
  Wants: {
    id: 'wants',
    accent: 'bg-cyan-cyan',
  },
  Buffer: {
    id: 'buffer',
    accent: 'bg-red-redLight1',
  },
};

// Normalize merchant/category strings the same way the legacy module did so
// existing CSV merchants like "DISCOVER         E-PAYMENT" still match the
// "discover e-payment" hint.
export const norm = (s) =>
  (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();

// Lowercased words only (punctuation collapsed), so alias matching can respect word
// boundaries: "bar" matches "Bars & Pubs" but not "Crowbar".
function phrase(s) {
  return norm(s).replace(/[^a-z0-9]+/g, ' ').trim();
}
const hasPhrase = (text, alias) => alias !== '' && ` ${text} `.includes(` ${alias} `);

const groupByDisplay = new Map(config.groups.map((g) => [g.displayName, g]));

// Look up the dollar budget for a subcategory in a given month.
// Source: the hand-curated fallbackBudget in budgetOverrides.json, else 0.
// monthKey keeps callers month-aware should budgets ever vary per month.
// eslint-disable-next-line no-unused-vars
export function getCategoryBudget(categoryId, monthKey) {
  const cat = CATEGORIES_BY_ID.get(categoryId);
  if (!cat) return 0;
  const rule = overrides.categoryRules?.[cat.key];
  return rule?.fallbackBudget ?? 0;
}

// Build the categories list with merchant hints + fallback budgets attached.
const CATEGORIES_ENRICHED = config.categories.map((c) => {
  const rule = overrides.categoryRules?.[c.key] ?? {};
  return {
    ...c,
    fallbackBudget: rule.fallbackBudget ?? 0,
    strongMerchants: rule.strongMerchants ?? [],
    merchants: rule.merchants ?? [],
    categoryAliases: (rule.categoryAliases ?? []).map(phrase),
    isIncome: groupByDisplay.get(c.groupName)?.isIncome === true,
  };
});

export const CATEGORIES = CATEGORIES_ENRICHED;
const CATEGORIES_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

// Build legacy-shaped BUCKETS array (one entry per non-income group).
const NON_INCOME_GROUPS = config.groups
  .filter((g) => !g.isIncome)
  .sort((a, b) => a.sortOrder - b.sortOrder);

export const BUCKETS = NON_INCOME_GROUPS.map((g) => {
  const theme = BUCKET_THEMES[g.displayName] ?? BUCKET_THEMES.Buffer;
  const groupRule = overrides.groupRules?.[g.displayName] ?? {};
  return {
    id: theme.id,
    groupId: g.id,
    name: g.displayName,
    accent: theme.accent,
    categoryAliases: groupRule.categoryAliases ?? [],
    defaultSubcategoryName: groupRule.defaultSubcategory ?? null,
    transferDefaultSubcategoryName: groupRule.transferDefaultSubcategory ?? null,
  };
});

const BUCKETS_BY_GROUP_DISPLAY = new Map(BUCKETS.map((b) => [b.name, b]));

export function getCategoryDef(id) {
  return CATEGORIES_BY_ID.get(id);
}

function matchMerchant(merchant, hints) {
  if (!merchant) return false;
  return hints.some((h) => merchant.includes(h));
}

// Subcategory-level classifier - returns the subcategory id plus
// the bucket slug + confidence (exact/hint/category/fallback).
export function categorizeTransaction(t) {
  if (!t) return fallbackResult();
  if (t.type === 'credit') {
    const incomeCat = CATEGORIES_ENRICHED.find(
      (c) => c.isIncome && c.name === 'Income'
    );
    return {
      bucketId: 'income',
      subcategoryId: incomeCat?.id ?? null,
      confidence: 'exact',
    };
  }

  const cat = norm(t.category);
  const merchant = norm(t.merchant);

  // 1. Transfer: merchant-driven, with Buffer override for Apple Pay / Zelle
  if (cat === 'transfer') {
    if (matchMerchant(merchant, ['apple pay', 'zelle'])) {
      return resolveSubcategoryByName('Buffer', 'Buffer', 'hint');
    }
    for (const c of CATEGORIES_ENRICHED) {
      if (matchMerchant(merchant, c.strongMerchants)) {
        return { bucketId: bucketIdFor(c), subcategoryId: c.id, confidence: 'exact' };
      }
    }
    // Default for transfers: route to Savings' transferDefault
    const savings = BUCKETS_BY_GROUP_DISPLAY.get('Savings');
    if (savings) {
      return resolveSubcategoryByName(
        'Savings',
        savings.transferDefaultSubcategoryName,
        'fallback'
      );
    }
    return fallbackResult();
  }

  // 2. Strong merchant hint → exact subcategory match
  for (const c of CATEGORIES_ENRICHED) {
    if (matchMerchant(merchant, c.strongMerchants)) {
      return { bucketId: bucketIdFor(c), subcategoryId: c.id, confidence: 'exact' };
    }
  }

  // 3a. The statement category IS a starter category/group (id or name, any case).
  const direct = resolveDirectCategory(cat);
  if (direct) return direct;

  // 3b. Generic per-category aliases ("restaurants" -> Dining, "fuel" -> Transport).
  const words = phrase(cat);
  if (words) {
    for (const c of CATEGORIES_ENRICHED) {
      if (!c.isIncome && c.categoryAliases.some((a) => hasPhrase(words, a))) {
        return { bucketId: bucketIdFor(c), subcategoryId: c.id, confidence: 'category' };
      }
    }
  }

  // 3c. Statement category at the bucket level → group's defaultSubcategory
  for (const b of BUCKETS) {
    if (b.categoryAliases.some((ac) => cat.includes(ac))) {
      return resolveSubcategoryByName(b.name, b.defaultSubcategoryName, 'category');
    }
  }

  // 4. Loose merchant hint
  for (const c of CATEGORIES_ENRICHED) {
    if (matchMerchant(merchant, c.merchants)) {
      return { bucketId: bucketIdFor(c), subcategoryId: c.id, confidence: 'hint' };
    }
  }

  // 5. Buffer fallback
  return resolveSubcategoryByName('Buffer', 'Buffer', 'fallback');
}

// Exact (case/whitespace-insensitive) match of a transaction category against the
// starter taxonomy: subcategory id or name, else group id or name (-> group default).
// Income entries are skipped: a debit is never income (callers send it to Buffer).
function resolveDirectCategory(cat) {
  if (!cat) return null;
  const sub = CATEGORIES_ENRICHED.find(
    (c) => !c.isIncome && (norm(c.id) === cat || norm(c.name) === cat)
  );
  if (sub) return { bucketId: bucketIdFor(sub), subcategoryId: sub.id, confidence: 'exact' };
  const bucket = BUCKETS.find((b) => norm(b.groupId) === cat || norm(b.name) === cat);
  if (bucket) return resolveSubcategoryByName(bucket.name, bucket.defaultSubcategoryName, 'category');
  return null;
}

function bucketIdFor(category) {
  const b = BUCKETS_BY_GROUP_DISPLAY.get(category.groupName);
  return b?.id ?? 'buffer';
}

function resolveSubcategoryByName(groupDisplay, subName, confidence) {
  if (!subName) return fallbackResult();
  const cat = CATEGORIES_ENRICHED.find(
    (c) => c.groupName === groupDisplay && c.name === subName
  );
  if (!cat) return fallbackResult();
  return {
    bucketId: BUCKETS_BY_GROUP_DISPLAY.get(groupDisplay)?.id ?? 'buffer',
    subcategoryId: cat.id,
    confidence,
  };
}

function fallbackResult() {
  const cat = CATEGORIES_ENRICHED.find(
    (c) => c.groupName === 'Buffer' && c.name === 'Buffer'
  );
  return {
    bucketId: 'buffer',
    subcategoryId: cat?.id ?? null,
    confidence: 'fallback',
  };
}
