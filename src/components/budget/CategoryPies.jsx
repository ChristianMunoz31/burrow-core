import { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatCurrency, formatCurrencyCompact } from '../../utils/budgetAggregate';
import { useChartColors } from '../../hooks/useChartColors';
import { getSeriesColors, getTooltipStyle } from '../../utils/chartColors';

const START_ANGLE = 90;
const END_ANGLE = -270;
// Keeps very small slices visible; shared by both rings so they stay aligned.
const MIN_ANGLE = 2;
const PAD_ANGLE = 1;
// Index of the red series color in getSeriesColors(); red only means over budget.
const RED_SERIES_INDEX = 5;

// Whole percent, except one decimal near 100 so 100.4% never reads "100%" beside
// an Over badge and 99.6% never reads "100%" when under budget.
const pctLabel = (pctUsed) => {
  if (pctUsed === null) return 'no budget';
  if (pctUsed >= 99 && pctUsed <= 101 && pctUsed !== 100) return `${pctUsed.toFixed(1)}%`;
  return `${Math.round(pctUsed)}%`;
};

function ringSummary(pie) {
  if (pie.items.length === 0) return `${pie.name}: no budget or spending this month`;
  const lines = pie.items
    .map((i) =>
      pie.unbudgeted || i.budgeted <= 0
        ? `${i.name} spent ${formatCurrency(i.spent)}`
        : `${i.name} spent ${formatCurrency(i.spent)} of ${formatCurrency(i.budgeted)}`,
    )
    .join(', ');
  if (pie.unbudgeted) return `${pie.name}: ${formatCurrency(pie.spent)} unbudgeted. ${lines}`;
  const status = pie.over
    ? `over by ${formatCurrency(pie.spent - pie.budgeted)}`
    : `${formatCurrency(pie.remaining)} remaining`;
  return `${pie.name}: spent ${formatCurrency(pie.spent)} of ${formatCurrency(pie.budgeted)}, ${status}. ${lines}`;
}

function SliceTooltip({ active, payload, tooltipStyle, textColor }) {
  const slice = active && payload && payload[0] ? payload[0].payload : null;
  if (!slice) return null;
  const rows = slice.isFiller
    ? [[slice.kind === 'over' ? 'Over by' : 'Remaining', formatCurrency(slice.value)]]
    : [
        ['Budgeted', formatCurrency(slice.budgeted)],
        ['Spent', formatCurrency(slice.spent)],
        slice.over
          ? ['Over by', formatCurrency(slice.spent - slice.budgeted)]
          : ['Remaining', formatCurrency(slice.remaining)],
      ];
  return (
    <div style={{ ...tooltipStyle, padding: '6px 10px', color: textColor }}>
      {!slice.isFiller && <div style={{ fontWeight: 600, marginBottom: 2 }}>{slice.name}</div>}
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span>{label}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function PieCard({ large, pie, accent, colors, otherColor, trackColor, chart, tooltipStyle }) {
  const { name, items, outer, inner, budgeted, spent, over, unbudgeted, pctUsed } = pie;
  // Colors follow the item's colorIndex, so both rings and the legend agree even
  // when two items share a label.
  const colorFor = (item) => (item.isOther ? otherColor : colors[item.colorIndex % colors.length]);
  const sliceFill = (s) => (s.isFiller ? trackColor : colorFor(s));
  const warn = over || unbudgeted;
  const overBy = formatCurrency(spent - budgeted);

  return (
    <div className="glass-subtle rounded-xl p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-slate100">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${accent}`} aria-hidden="true" />
          <span className="truncate">{name}</span>
        </h4>
        <span
          className={`text-sm font-semibold tabular-nums ${warn ? 'text-accent-red' : 'text-slate-slate200'}`}
        >
          {unbudgeted
            ? `${formatCurrency(spent)} unbudgeted`
            : over
              ? `Over by ${overBy}`
              : `${formatCurrency(spent)} / ${formatCurrency(budgeted)}`}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-slate300">
          No budget or spending this month
        </p>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <div role="img" aria-label={ringSummary(pie)} className={`relative shrink-0 ${large ? 'h-56 w-56' : 'h-40 w-40'}`}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart accessibilityLayer={false}>
                {outer.length > 0 && (
                  <Pie
                    data={outer}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="76%"
                    outerRadius="100%"
                    startAngle={START_ANGLE}
                    endAngle={END_ANGLE}
                    paddingAngle={PAD_ANGLE}
                    minAngle={MIN_ANGLE}
                    stroke="none"
                    isAnimationActive={false}
                  >
                    {outer.map((s, i) => (
                      <Cell key={`o-${s.key ?? s.kind}-${i}`} fill={sliceFill(s)} />
                    ))}
                  </Pie>
                )}
                <Pie
                  data={inner}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="56%"
                  outerRadius="72%"
                  startAngle={START_ANGLE}
                  endAngle={END_ANGLE}
                  paddingAngle={PAD_ANGLE}
                  minAngle={MIN_ANGLE}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {inner.map((s, i) => (
                    <Cell key={`i-${s.key ?? s.kind}-${i}`} fill={sliceFill(s)} />
                  ))}
                </Pie>
                <Tooltip
                  content={<SliceTooltip tooltipStyle={tooltipStyle} textColor={chart.tickStrong} />}
                />
              </PieChart>
            </ResponsiveContainer>
            <div
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center leading-tight"
              aria-hidden="true"
            >
              {over && !unbudgeted && pctUsed !== null ? (
                <>
                  <span className="text-sm font-semibold uppercase text-accent-red">Over</span>
                  <span className="text-sm font-semibold tabular-nums text-accent-red">
                    {pctLabel(pctUsed)}
                  </span>
                </>
              ) : (
                <>
                  <span
                    className={`text-sm font-semibold tabular-nums ${warn ? 'text-accent-red' : 'text-slate-slate100'}`}
                  >
                    {formatCurrencyCompact(spent)}
                  </span>
                  <span className="text-sm tabular-nums text-slate-slate300">
                    {unbudgeted
                      ? 'unbudgeted'
                      : budgeted > 0
                        ? `of ${formatCurrencyCompact(budgeted)}`
                        : 'no budget'}
                  </span>
                </>
              )}
            </div>
          </div>

          <ul className="w-full min-w-0 space-y-2">
            {items.map((item) => {
              const itemOver = item.over && !unbudgeted;
              return (
                <li key={item.key} className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: colorFor(item) }}
                      aria-hidden="true"
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-sm text-slate-slate200"
                      title={item.name}
                    >
                      {item.name}
                    </span>
                    {itemOver && (
                      <span className="shrink-0 rounded bg-accent-red/15 px-1 text-sm font-semibold uppercase text-accent-red">
                        <span aria-hidden="true">▲ </span>
                        Over
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline justify-end gap-2 pl-4 text-sm tabular-nums">
                    <span
                      className={`whitespace-nowrap ${itemOver ? 'text-accent-red' : 'text-slate-slate100'}`}
                    >
                      {item.budgeted > 0
                        ? `${formatCurrency(item.spent)} / ${formatCurrency(item.budgeted)}`
                        : formatCurrency(item.spent)}
                    </span>
                    <span
                      className={`whitespace-nowrap ${itemOver ? 'text-accent-red' : 'text-slate-slate300'}`}
                    >
                      {pctLabel(item.pctUsed)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * One two-ring donut + legend per budget bucket for the selected month: the
 * outer ring is budgeted, the inner ring is spent, both by subcategory on one
 * shared scale (gaps are neutral track slices).
 *
 * Pie ids are budget group ids; `buckets` (the static BUCKETS) supplies the
 * accent swatch by `groupId`, with a neutral fallback for custom/unassigned.
 *
 * @param {{pies: Array, buckets: Array<{groupId: string, accent: string}>, large?: boolean}} props
 */
export default function CategoryPies({ pies, buckets, large = false }) {
  const chart = useChartColors();
  // Re-read CSS variables when the theme flips (useChartColors returns a new
  // object then). Red is dropped so it only ever means over budget.
  // `chart` is the theme key: the getters read the DOM, not React state.
  /* eslint-disable react-hooks/exhaustive-deps */
  const colors = useMemo(
    () => getSeriesColors().filter((_, i) => i !== RED_SERIES_INDEX),
    [chart],
  );
  /* eslint-enable react-hooks/exhaustive-deps */
  const tooltipStyle = getTooltipStyle();
  const accentById = new Map(buckets.map((b) => [b.groupId, b.accent]));

  if (!pies.length) {
    return <p className="py-8 text-center text-sm text-slate-slate400">No category groups</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {pies.map((p) => (
        <PieCard
          key={p.id}
          large={large}
          pie={p}
          accent={accentById.get(p.id) ?? 'bg-slate-slate500'}
          colors={colors}
          otherColor={chart.axisTick}
          trackColor={chart.grid}
          chart={chart}
          tooltipStyle={tooltipStyle}
        />
      ))}
    </div>
  );
}
