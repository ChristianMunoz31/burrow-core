// Test-only preload for the visual project: shifts `Date` and `Date.now` in the server by a
// constant offset so "today" is BURROW_E2E_FIXED_NOW. Time still advances normally afterwards.
// No product code change; when the variable is unset this is a no-op.
const RealDate = Date;
const raw = globalThis.process?.env?.BURROW_E2E_FIXED_NOW;
const fixed = raw ? new RealDate(raw).getTime() : NaN;

if (Number.isFinite(fixed)) {
  const offset = fixed - RealDate.now();
  const shiftedNow = () => RealDate.now() + offset;

  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(shiftedNow());
      else super(...args);
    }

    static now() {
      return shiftedNow();
    }
  }
  globalThis.Date = ShiftedDate;
}
