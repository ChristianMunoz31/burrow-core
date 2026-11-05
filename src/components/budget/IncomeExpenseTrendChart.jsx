import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency, formatCurrencyCompact, formatMonthLong, formatMonthShort } from '../../utils/budgetAggregate';
import { useChartColors } from '../../hooks/useChartColors';
import { getAccentColor, getTooltipStyle } from '../../utils/chartColors';

export default function IncomeExpenseTrendChart({ data, height = 300 }) {
  const chart = useChartColors();
  if (!data.length) {
    return (
      <p className="text-center py-8 text-slate-slate400">No trend data available</p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={formatMonthShort}
          tick={{ fontSize: 11, fill: chart.axisTick }}
        />
        <YAxis tickFormatter={formatCurrencyCompact} tick={{ fontSize: 11, fill: chart.axisTick }} width={56} />
        <Tooltip
          cursor={{ stroke: chart.grid }}
          formatter={(value, name) => [formatCurrency(value), name]}
          labelFormatter={(label) => formatMonthLong(label)}
          contentStyle={getTooltipStyle()}
          itemStyle={{ color: 'var(--tooltip-text)' }}
          labelStyle={{ color: chart.tickStrong }}
        />
        <Legend wrapperStyle={{ fontSize: '11px', color: chart.tickStrong }} />
        <Line type="monotone" dataKey="income" name="Income" stroke={getAccentColor('green')} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="expense" name="Expenses" stroke={getAccentColor('red')} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
