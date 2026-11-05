import { useState } from 'react';
import { Settings2, Check, RotateCcw } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import BudgetWidget from '../components/budget/BudgetWidget';
import SubscriptionsWidget from '../components/budget/SubscriptionsWidget';
import HealthWidget from '../components/health/HealthWidget';
import TodosWidget from '../components/todos/TodosWidget';
import CalendarWidget from '../components/calendar/CalendarWidget';
import HabitsWidget from '../components/habits/HabitsWidget';
import JournalWidget from '../components/journal/JournalWidget';
import NotesWidget from '../components/notes/NotesWidget';
import BookmarksWidget from '../components/bookmarks/BookmarksWidget';
import FocusWidget from '../components/focus/FocusWidget';
import CountdownsWidget from '../components/countdowns/CountdownsWidget';
import WidgetTile from '../components/home/WidgetTile';
import BackupHealthNotice from '../components/home/BackupHealthNotice';
import DataFolderWarning from '../components/settings/DataFolderWarning';
import DirectImportNotice from '../components/home/DirectImportNotice';
import CrossInsightsCard from '../components/home/CrossInsightsCard';
import JaviHomeCard from '../components/home/JaviHomeCard';
import { btnSecondary } from '../components/shared/formStyles';
import { useHomeLayout } from '../hooks/useHomeLayout';
import { useBriefing } from '../hooks/useBriefing';
import { useCachedWeatherReader } from '../hooks/useWeather';
import { usePageContext } from '../contexts/PageContextContext';
import { buildHomeContext } from '../utils/javiBuilders/home';

// One grid. The order only applies to a Home never customized and to Reset. The Javi card comes first (weather
// lives in it; there is no Weather card), also at the top of a layout saved before it existed.
const WIDGETS = [
  { key: 'javi', Component: JaviHomeCard },
  { key: 'budget', Component: BudgetWidget },
  { key: 'subscriptions', Component: SubscriptionsWidget },
  { key: 'todos', Component: TodosWidget },
  { key: 'journal', Component: JournalWidget },
  { key: 'habits', Component: HabitsWidget },
  { key: 'calendar', Component: CalendarWidget },
  { key: 'notes', Component: NotesWidget },
  { key: 'focus', Component: FocusWidget },
  { key: 'countdowns', Component: CountdownsWidget },
  { key: 'bookmarks', Component: BookmarksWidget },
  { key: 'health', Component: HealthWidget },
];
// Hidden while no layout is stored (in memory only); Customize shows them.
const DEFAULT_HIDDEN = ['notes', 'focus', 'countdowns', 'bookmarks', 'health'];
const LAYOUT_OPTIONS = { firstKeys: ['javi'], cardDefaults: { javi: { w: 2 } } };

const WIDGET_MAP = Object.fromEntries(WIDGETS.map((w) => [w.key, w]));
const WIDGET_KEYS = WIDGETS.map((w) => w.key);
const GRID_CLASS = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 auto-rows-[minmax(11rem,auto)]';
const BTN_CLASS = `${btnSecondary} inline-flex items-center gap-1.5`;

export default function Home() {
  const [editing, setEditing] = useState(false);
  const { ready, cardFor, orderKeys, cycleWidth, toggleHeight, toggleHidden, reorder, reset } =
    useHomeLayout(WIDGET_KEYS, DEFAULT_HIDDEN, LAYOUT_OPTIONS);

  const ordered = orderKeys(WIDGET_KEYS);
  // Edit mode shows every card (incl. hidden, dimmed) so they can be unhidden.
  const shown = editing ? ordered : ordered.filter((k) => !cardFor(k).hidden);

  const { briefing, alerts } = useBriefing();
  const readWeather = useCachedWeatherReader();
  // The Javi card is not data, so Javi is not told about it; the weather it shows is (local AI only).
  usePageContext('home', () =>
    buildHomeContext({ widgets: shown.filter((k) => k !== 'javi'), briefing, alerts, weather: readWeather() }),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = shown.indexOf(active.id);
    const newIndex = shown.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    reorder(arrayMove(shown, oldIndex, newIndex));
  };

  const tiles = shown.map((key) => (
    <WidgetTile
      key={key}
      id={key}
      Component={WIDGET_MAP[key].Component}
      card={cardFor(key)}
      editing={editing}
      onCycleWidth={() => cycleWidth(key)}
      onToggleHeight={() => toggleHeight(key)}
      onToggleHidden={() => toggleHidden(key)}
    />
  ));

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <DataFolderWarning />
      <DirectImportNotice />
      <BackupHealthNotice />
      <CrossInsightsCard />
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0 scroll-reveal">
          <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Overview</h2>
          <p className="text-sm text-slate-slate400 mt-1">
            {editing
              ? 'Drag to reorder, or use a card’s buttons to resize or hide it.'
              : 'Everything important at a glance.'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {editing && (
            <button type="button" onClick={reset} className={BTN_CLASS}>
              <RotateCcw size={14} aria-hidden="true" /> Reset
            </button>
          )}
          <button type="button" onClick={() => setEditing((v) => !v)} disabled={!ready && !editing} className={BTN_CLASS}>
            {editing ? (
              <>
                <Check size={14} aria-hidden="true" /> Done
              </>
            ) : (
              <>
                <Settings2 size={14} aria-hidden="true" /> Customize
              </>
            )}
          </button>
        </div>
      </div>

      {editing ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={shown} strategy={rectSortingStrategy}>
            <div className={GRID_CLASS}>{tiles}</div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className={GRID_CLASS}>{tiles}</div>
      )}
    </div>
  );
}
