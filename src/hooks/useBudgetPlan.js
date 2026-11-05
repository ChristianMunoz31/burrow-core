import { useMemo } from 'react';
import { useSyncedSetting } from './useSyncedSetting';
import {
  applySpentOverrides,
  buildPlan,
  payeeIncomeForMonth,
  resolveStructure,
  withDerivedIncome,
} from '../utils/budgetPlan';

// Stable fallbacks (a fresh literal each render would defeat the memos).
const EMPTY_OBJ = Object.freeze({});
const EMPTY_ARR = Object.freeze([]);

/**
 * The month plan the Budget Dashboard, the Budget Planner and the Home Budget card share.
 * Every number comes from buildPlan, computed in code.
 * @param {string} month Month key, for example '2026-10'.
 * @param {object[]} categories Actual spend rows per category and month.
 * @returns {{ plan: object, resolved: object, augCats: object[], ready: boolean,
 *   targets: object, setTargets: Function, payees: object[], setPayees: Function,
 *   spentOv: object, setSpentOv: Function, structure: object, setStructure: Function,
 *   defaults: object, setDefaults: Function }}
 *   ready: every one of the five settings has been fetched once.
 */
export function useBudgetPlan(month, categories) {
  const [targets, setTargets, m1] = useSyncedSetting('budget:targets', EMPTY_OBJ);
  const [payees, setPayees, m2] = useSyncedSetting('budget:payees', EMPTY_ARR);
  const [spentOv, setSpentOv, m3] = useSyncedSetting('budget:spent', EMPTY_OBJ);
  const [structure, setStructure, m4] = useSyncedSetting('budget:structure', EMPTY_OBJ);
  const [defaults, setDefaults, m5] = useSyncedSetting('budget:defaults', EMPTY_OBJ);
  const resolved = useMemo(() => resolveStructure(structure), [structure]);
  const augCats = useMemo(
    () => applySpentOverrides(categories, month, spentOv, resolved.categories),
    [categories, month, spentOv, resolved],
  );
  const plan = useMemo(
    () =>
      buildPlan(month, withDerivedIncome(targets, month, payeeIncomeForMonth(payees, month)), augCats, resolved, defaults),
    [month, targets, payees, augCats, resolved, defaults],
  );
  const ready = [m1, m2, m3, m4, m5].every((m) => m?.isFetched === true);
  return {
    plan,
    resolved,
    augCats,
    ready,
    targets,
    setTargets,
    payees,
    setPayees,
    spentOv,
    setSpentOv,
    structure,
    setStructure,
    defaults,
    setDefaults,
  };
}
