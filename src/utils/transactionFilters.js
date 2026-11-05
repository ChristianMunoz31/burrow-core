// Categories representing money movement between the user's own accounts
// (not real income or spending). Excluded from analytics when the
// "Exclude transfers" toggle is on.
export const TRANSFER_CATEGORIES = new Set([
  'Transfer',
  'Credit Card Payment',
]);

export function isTransfer(transaction) {
  return TRANSFER_CATEGORIES.has(transaction.category);
}
