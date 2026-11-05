import { clip, localDay, round2 } from '../javiContext';
import { relativeDay } from '../relativeDay';
import { redactText } from '../javiRedact';
import { formatCurrency } from '../budgetAggregate';
import { statusContext } from './_status';

const MAX_ITEMS = 15;
const MAX_BILLS = 5;
const MERCHANT_CLIP = 40;
// Person-to-person apps are not subscriptions and their labels can carry names. They stay in the
// lists and totals (Javi's numbers must match the UI) but get a generic, name-free label.
// Tested against the merchant key and the lowercased raw merchant ("PayPal *JohnSmith"
// normalizes to a bare name, so only the raw text still shows the PayPal prefix).
const P2P_PROVIDERS = [
  { re: /^venmo/, label: 'Personal payment (Venmo)' },
  { re: /^zelle/, label: 'Personal payment (Zelle)' },
  { re: /^cash app/, label: 'Personal payment (Cash App)' },
  { re: /^paypal\s*(\*|transfer)/, label: 'Personal payment (PayPal)' },
];
// A "paypal *X" item whose key is a known merchant is a real subscription paid via PayPal.
const KNOWN_MERCHANT_RE =
  /\b(netflix|spotify|hulu|disney|apple|google|microsoft|adobe|amazon|youtube|dropbox|openai|github|patreon|nintendo|playstation|xbox|steam|audible|nytimes)\b/;

function p2pLabel(item) {
  const key = String(item.merchantKey ?? '');
  const raw = String(item.merchant ?? '').toLowerCase().trim();
  const provider = P2P_PROVIDERS.find((p) => p.re.test(key) || p.re.test(raw));
  if (!provider) return null;
  if (provider.label.endsWith('(PayPal)') && KNOWN_MERCHANT_RE.test(key.toLowerCase())) return null;
  return provider.label;
}
const isBill = (item) => item.kind === 'bill';

// Money leaves the builder as "$1,234.56" strings, same pattern as budget.js.
const usd = (n) => {
  const v = round2(n);
  return v === null ? null : formatCurrency(v);
};

const finiteOr0 = (n) => (Number.isFinite(n) ? n : 0);
const countOr = (reported, fallback) => (Number.isFinite(reported) ? reported : fallback.length);

const increaseText = (p) =>
  p ? `+${usd(p.to - p.from)} (${Math.round(Number(p.pct) || 0)}%)` : null;

// Bank descriptors carry store numbers and reference ids; strip them, redact, then clip
// (redacting first so a clip can never leave half a secret behind).
function merchantLabel(item) {
  const personal = p2pLabel(item);
  if (personal) return personal;
  const cleaned = String(item.merchant ?? '')
    .replace(/#\d+/g, ' ')
    .replace(/\S*\d{4,}\S*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(redactText(cleaned || String(item.merchantKey ?? '')), MERCHANT_CLIP);
}

const entryOf = (i, today) => {
  const entry = {
    merchant: merchantLabel(i),
    cadence: i.cadence,
    typical: usd(i.typicalAmount),
    monthly: usd(i.monthlyEquivalent),
    nextExpected: i.nextExpected,
  };
  // Plain words so the model never works out how far away the date is ("in 5 days", "yesterday").
  const when = relativeDay(i.nextExpected, today);
  if (when) entry.when = when;
  const increase = increaseText(i.priceIncrease);
  if (increase) entry.priceIncrease = increase;
  return entry;
};

/**
 * Totals come straight from the detector result so they match the UI. Person-to-person items
 * stay in the lists and totals but carry a generic label instead of a name.
 * @param {{ result?: { items?: object[], monthlyTotal?: number, yearlyTotal?: number,
 *   activeCount?: number, billsMonthlyTotal?: number, billsActiveCount?: number },
 *   loading?: boolean, error?: unknown, now?: Date }} input
 */
export function buildSubscriptionsContext({ result, loading, error, now = new Date() } = {}) {
  const early = statusContext({ loading, error });
  if (early) return early;
  const today = localDay(now);
  const items = Array.isArray(result?.items) ? result.items.filter(Boolean) : [];
  const active = items.filter((i) => i.active);
  const activeSubs = active.filter((i) => !isBill(i));
  const activeBills = active.filter(isBill);

  // Summary first: if the serializer ever truncates, the tail it cuts is item detail.
  return {
    view: 'subscriptions',
    monthlyTotal: usd(finiteOr0(result?.monthlyTotal)),
    yearlyTotal: usd(finiteOr0(result?.yearlyTotal)),
    activeCount: countOr(result?.activeCount, activeSubs),
    billsMonthlyTotal: usd(finiteOr0(result?.billsMonthlyTotal)),
    billsActiveCount: countOr(result?.billsActiveCount, activeBills),
    inactiveCount: items.length - active.length,
    items: activeSubs.slice(0, MAX_ITEMS).map((i) => entryOf(i, today)),
    bills: activeBills.slice(0, MAX_BILLS).map((i) => entryOf(i, today)),
  };
}
