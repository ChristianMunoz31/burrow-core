import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Skeleton } from '../shared/Skeleton';
import { useTableOverview } from '../../hooks/useDataBrowser';
import { useChartColors } from '../../hooks/useChartColors';
import { getAccentColor, getTooltipStyle } from '../../utils/chartColors';
import { formatCurrency } from '../../utils/dataFormat';
import { formatCurrencyCompact } from '../../utils/budgetAggregate';
import { BTN } from '../settings/pillStyles';

function formatPeriod(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) return String(period);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: 'short',
    year: '2-digit',
  });
}

function ChartCard({ title, summary, children, tableHead, tableRows }) {
  return (
    <section className="glass rounded-2xl p-5" aria-label={title}>
      <h3 className="mb-3 text-sm font-bold tracking-tight text-slate-slate100">{title}</h3>
      <div role="img" aria-label={summary}>
        {children}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            {tableHead.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tableRows.map((r) => (
            <tr key={r[0]}>
              {r.map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RowsChart({ data, chart }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <ChartCard
      title="Rows per month"
      summary={`Bar chart of rows per month: ${total.toLocaleString()} dated rows over ${data.length} months.`}
      tableHead={['Month', 'Rows']}
      tableRows={data.map((d) => [formatPeriod(d.period), d.count])}
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
          <XAxis
            dataKey="period"
            tickFormatter={formatPeriod}
            tick={{ fontSize: 11, fill: chart.axisTick }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: chart.axisTick }} width={40} />
          <Tooltip
            cursor={{ fill: chart.cursor }}
            formatter={(value) => [Number(value).toLocaleString(), 'Rows']}
            labelFormatter={formatPeriod}
            contentStyle={getTooltipStyle()}
            itemStyle={{ color: 'var(--tooltip-text)' }}
            labelStyle={{ color: chart.tickStrong }}
          />
          <Bar dataKey="count" name="Rows" fill={getAccentColor('blue')} radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function AmountChart({ data, chart }) {
  return (
    <ChartCard
      title="Monthly totals"
      summary={`Chart of monthly income, expenses and net over ${data.length} months.`}
      tableHead={['Month', 'Income', 'Expenses', 'Net']}
      tableRows={data.map((d) => [
        formatPeriod(d.period),
        formatCurrency(d.income),
        formatCurrency(d.expenses),
        formatCurrency(d.net),
      ])}
    >
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
          <XAxis
            dataKey="period"
            tickFormatter={formatPeriod}
            tick={{ fontSize: 11, fill: chart.axisTick }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis tickFormatter={formatCurrencyCompact} tick={{ fontSize: 11, fill: chart.axisTick }} width={56} />
          <Tooltip
            cursor={{ fill: chart.cursor }}
            formatter={(value, name) => [formatCurrency(value), name]}
            labelFormatter={formatPeriod}
            contentStyle={getTooltipStyle()}
            itemStyle={{ color: 'var(--tooltip-text)' }}
            labelStyle={{ color: chart.tickStrong }}
          />
          <Legend wrapperStyle={{ fontSize: '11px', color: chart.tickStrong }} />
          <Bar dataKey="income" name="Income" fill={getAccentColor('blue')} radius={[4, 4, 0, 0]} maxBarSize={20} />
          <Bar
            dataKey="expenses"
            name="Expenses"
            fill={getAccentColor('orange')}
            fillOpacity={0.6}
            stroke={getAccentColor('orange')}
            radius={[4, 4, 0, 0]}
            maxBarSize={20}
          />
          <Line
            type="monotone"
            dataKey="net"
            name="Net"
            stroke={chart.tickStrong}
            strokeWidth={2}
            strokeDasharray="5 3"
            dot={{ r: 2 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export default function TableOverview({ table }) {
  const chart = useChartColors();
  const { data, isPending, error, refetch } = useTableOverview(table);

  if (isPending) {
    return (
      <div role="status" aria-label="Loading overview" className="glass space-y-3 rounded-2xl p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  // A failed background refetch keeps the loaded charts; the full panel is only for "nothing to show".
  if (error && !data) {
    return (
      <div className="glass rounded-2xl p-5">
        <p role="alert" className="text-sm text-accent-amber">
          Couldn&apos;t load the overview.
        </p>
        <button type="button" onClick={() => refetch()} className={`${BTN} mt-3`}>
          Retry
        </button>
      </div>
    );
  }

  const rows = data.rowsOverTime ?? [];
  const amounts = data.amountByMonth ?? [];
  const banner = error && (
    <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="text-sm text-accent-amber">
        Couldn&apos;t refresh. Showing last loaded overview.
      </p>
      <button type="button" onClick={() => refetch()} className={BTN}>
        Retry
      </button>
    </div>
  );
  if (rows.length === 0) {
    return (
      <div className="min-w-0 space-y-4">
        {banner}
        <p className="glass rounded-2xl p-5 text-sm text-slate-slate400">No dated rows to chart.</p>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {banner}
      <RowsChart data={rows} chart={chart} />
      {amounts.length > 0 && <AmountChart data={amounts} chart={chart} />}
      <p className="text-xs text-slate-slate400">
        {data.truncated && 'Showing the most recent 20,000 rows. '}
        {data.undated > 0 && `${data.undated.toLocaleString()} rows have no date and are not charted.`}
      </p>
    </div>
  );
}
