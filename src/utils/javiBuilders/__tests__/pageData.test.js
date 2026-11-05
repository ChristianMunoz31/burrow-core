// Javi's current-page notice: the data signal each page registers through usePageContext's third argument (falsy
// without user records, else a value whose identity changes with the data).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hasBudget } from '../budget';

describe('Javi page data signals', () => {
  it('budget counts real transactions or a saved target or payee, never the sample dashboard alone', () => {
    expect(hasBudget('transactions', {}, [])).toBe(true);
    expect(hasBudget('sample', { '2026-10:food': 100 }, [])).toBe(true);
    expect(hasBudget('sample', {}, [{ name: 'Pay' }])).toBe(true);
    expect(hasBudget('sample', {}, [])).toBe(false);
    expect(hasBudget('error', {}, [])).toBe(false);
  });

  // The rule per page. Home, Settings and the data browser register no signal; Calendar ignores the weather.
  it.each([
    ['budget/BudgetDashboard.jsx', 'budget', 'hasBudget(source, targets, payees) && plan'],
    ['budget/BudgetPlanner.jsx', 'budget-planner', 'hasBudget(source, targets, payees) && plan'],
    ['budget/SubscriptionsView.jsx', 'subscriptions', 'result.items.length > 0 && result'],
    ['todos/TodosPage.jsx', 'todos', 'todos.length > 0 && todos'],
    ['habits/HabitsPage.jsx', 'habits', 'habits.length > 0 && habits'],
    ['focus/FocusPage.jsx', 'focus', 'sessions.length > 0 && sessions'],
    ['countdowns/CountdownsPage.jsx', 'countdowns', 'countdowns.length > 0 && countdowns'],
    ['calendar/CalendarPage.jsx', 'calendar', 'events.length > 0 && events'],
    ['journal/JournalPage.jsx', 'journal', 'entries.length > 0 && entries'],
    ['notes/NotesPage.jsx', 'notes', 'notes.length > 0 && notes'],
    ['bookmarks/BookmarksPage.jsx', 'bookmarks', 'bookmarks.length > 0 && bookmarks'],
    ['health/HealthPage.jsx', 'health', 'days.length > 0 && days'],
  ])('%s registers %s with %s', (file, key, signal) => {
    const src = readFileSync(`src/components/${file}`, 'utf8');
    const start = src.search(new RegExp(`usePageContext\\(\\s*'${key}'`));
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, start + 400)).toContain(signal);
  });
});
