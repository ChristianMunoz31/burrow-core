import { describe, it, expect } from "vitest";
import { detectSubscriptions, normalizeMerchant } from "../subscriptions";

const NOW = new Date(2026, 9, 3, 12, 0);

const tx = (date, merchant, amount, extra = {}) => ({
  id: `${merchant}-${date}`,
  date,
  merchant,
  amount,
  category: "Entertainment",
  type: "debit",
  ...extra,
});

const monthlyNetflix = (amounts) =>
  amounts.map((a, i) => tx(`2026-0${7 + i}-15`, "NETFLIX.COM", a));

describe("normalizeMerchant", () => {
  it("produces stable keys across bank noise", () => {
    expect(normalizeMerchant("POS DEBIT NETFLIX.COM 866-579-7172")).toBe(
      "netflix com",
    );
    expect(normalizeMerchant("SQ *BLUE BOTTLE #1234")).toBe("blue bottle");
    expect(normalizeMerchant("Spotify USA")).toBe("spotify usa");
  });

  it("returns empty string for empty or garbage input", () => {
    expect(normalizeMerchant("")).toBe("");
    expect(normalizeMerchant(null)).toBe("");
    expect(normalizeMerchant("*** ### 12345")).toBe("");
    expect(normalizeMerchant("POS DEBIT")).toBe("");
  });
});

describe("detectSubscriptions", () => {
  it("returns an empty result for empty or tiny input without NaN", () => {
    const empty = {
      items: [],
      monthlyTotal: 0,
      yearlyTotal: 0,
      activeCount: 0,
      billsMonthlyTotal: 0,
      billsActiveCount: 0,
    };
    expect(detectSubscriptions([], { now: NOW })).toEqual(empty);
    expect(
      detectSubscriptions([tx("2026-09-15", "X", 5)], { now: NOW }),
    ).toEqual(empty);
  });

  it("detects a monthly subscription with equivalents and next date", () => {
    const { items } = detectSubscriptions(
      monthlyNetflix([15.49, 15.49, 15.49]),
      { now: NOW },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "netflix com|monthly|15.49",
      cadence: "monthly",
      typicalAmount: 15.49,
      monthlyEquivalent: 15.49,
      yearlyEquivalent: 185.88,
      lastCharge: "2026-09-15",
      nextExpected: "2026-10-15",
      occurrences: 3,
      active: true,
      priceIncrease: null,
    });
  });

  it("rejects irregular gaps and too few charges", () => {
    const irregular = [
      tx("2026-05-01", "GYM", 30),
      tx("2026-05-20", "GYM", 30),
      tx("2026-08-02", "GYM", 30),
      tx("2026-08-09", "GYM", 30),
    ];
    expect(detectSubscriptions(irregular, { now: NOW }).items).toEqual([]);
    const two = [tx("2026-08-15", "HULU", 9), tx("2026-09-15", "HULU", 9)];
    expect(detectSubscriptions(two, { now: NOW }).items).toEqual([]);
  });

  it("excludes a one-off large purchase at the same merchant from the series", () => {
    const rows = [
      ...monthlyNetflix([15.49, 15.49, 15.49]),
      tx("2026-08-20", "NETFLIX.COM", 400),
    ];
    const { items } = detectSubscriptions(rows, { now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0].occurrences).toBe(3);
    expect(items[0].typicalAmount).toBe(15.49);
  });

  it("flags a price increase of 3% and at least $0.50", () => {
    const { items } = detectSubscriptions(
      monthlyNetflix([15.49, 15.49, 17.49]),
      { now: NOW },
    );
    expect(items[0].priceIncrease).toEqual({ from: 15.49, to: 17.49, pct: 13 });
  });

  it("does not flag a $0.10 change", () => {
    const { items } = detectSubscriptions(
      monthlyNetflix([15.49, 15.49, 15.59]),
      { now: NOW },
    );
    expect(items[0].priceIncrease).toBeNull();
  });

  it("detects a yearly cadence from two charges", () => {
    const rows = [
      tx("2025-09-10", "AMAZON PRIME", 139),
      tx("2026-09-10", "AMAZON PRIME", 139),
    ];
    const { items, monthlyTotal, yearlyTotal } = detectSubscriptions(rows, {
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      cadence: "yearly",
      monthlyEquivalent: 11.58,
      nextExpected: "2027-09-10",
      active: true,
    });
    expect(monthlyTotal).toBe(11.58);
    expect(yearlyTotal).toBe(139);
  });

  it("detects a weekly cadence from four charges", () => {
    const rows = ["2026-09-05", "2026-09-12", "2026-09-19", "2026-09-26"].map(
      (d) => tx(d, "CAR WASH CLUB", 12),
    );
    const { items } = detectSubscriptions(rows, { now: NOW });
    expect(items[0]).toMatchObject({
      cadence: "weekly",
      monthlyEquivalent: 52,
      nextExpected: "2026-10-03",
    });
  });

  it("ignores refunds, credits and transfers", () => {
    const credits = monthlyNetflix([15.49, 15.49, 15.49]).map((t) => ({
      ...t,
      type: "credit",
    }));
    expect(detectSubscriptions(credits, { now: NOW }).items).toEqual([]);
    const transfers = monthlyNetflix([500, 500, 500]).map((t) => ({
      ...t,
      category: "Transfer",
    }));
    expect(detectSubscriptions(transfers, { now: NOW }).items).toEqual([]);
    const withRefund = [
      ...monthlyNetflix([15.49, 15.49, 15.49]),
      { ...tx("2026-09-30", "NETFLIX.COM", 15.49), type: "credit" },
    ];
    expect(
      detectSubscriptions(withRefund, { now: NOW }).items[0].occurrences,
    ).toBe(3);
  });

  it("clamps the next monthly date to the end of a short month", () => {
    const rows = [
      tx("2026-11-30", "CLOUD BOX", 5),
      tx("2026-12-31", "CLOUD BOX", 5),
      tx("2027-01-31", "CLOUD BOX", 5),
    ];
    const { items } = detectSubscriptions(rows, { now: new Date(2027, 1, 5) });
    expect(items[0].nextExpected).toBe("2027-02-28");
  });

  it("totals only active subscriptions and lists them first", () => {
    const stale = [
      tx("2025-10-15", "OLD APP", 20),
      tx("2025-11-15", "OLD APP", 20),
      tx("2025-12-15", "OLD APP", 20),
    ];
    const live = monthlyNetflix([15.49, 15.49, 15.49]);
    const result = detectSubscriptions([...stale, ...live], { now: NOW });
    expect(result.items.map((i) => i.active)).toEqual([true, false]);
    expect(result.activeCount).toBe(1);
    expect(result.monthlyTotal).toBe(15.49);
    expect(result.yearlyTotal).toBe(185.88);
  });
});
