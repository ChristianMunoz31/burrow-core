// Tiny subsequence fuzzy matcher — enough for the command palette's ~25 entries,
// no dependency. Returns a score (higher = better); 0 means no match.
export function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = (text || '').toLowerCase();
  let qi = 0;
  let score = 0;
  let prevIdx = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += prevIdx === ti - 1 ? 3 : 1; // consecutive run bonus
      if (ti === 0 || t[ti - 1] === ' ') score += 2; // word-start bonus
      prevIdx = ti;
      qi++;
    }
  }
  if (qi < q.length) return 0; // not all query chars matched in order
  return score - t.length * 0.01; // mild preference for shorter targets
}

// Filter + rank a list by fuzzy match against getText(item). Empty query keeps
// the original order.
export function fuzzyFilter(query, items, getText) {
  if (!query) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(query, getText(item)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}
