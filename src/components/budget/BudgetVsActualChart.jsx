import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency, formatCurrencyCompact } from '../../utils/budgetAggregate';
import { useChartColors } from '../../hooks/useChartColors';
import { getAccentColor, getTooltipStyle } from '../../utils/chartColors';

export default function BudgetVsActualChart({ data, height = 320 }) {
  const chart = useChartColors();
  if (!data.length) {
    return (
      <p className="text-center py-8 text-slate-slate400">
        No budgeted categories this month
      </p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
        <XAxis
          dataKey="name"
          angle={-35}
          textAnchor="end"
          interval={0}
          height={90}
          tick={{ fontSize: 11, fill: chart.axisTick }}
        />
        <YAxis tickFormatter={formatCurrencyCompact} tick={{ fontSize: 11, fill: chart.axisTick }} width={56} />
        <Tooltip
          cursor={{ fill: chart.cursor }}
          formatter={(value, name) => [formatCurrency(value), name]}
          contentStyle={getTooltipStyle()}
          itemStyle={{ color: 'var(--tooltip-text)' }}
          labelStyle={{ color: chart.tickStrong }}
        />
        <Legend verticalAlign="top" wrapperStyle={{ fontSize: '11px', color: chart.tickStrong, paddingBottom: '4px' }} />
        <Bar dataKey="budgeted" name="Budgeted" fill={getAccentColor('cyan')} radius={[3, 3, 0, 0]} />
        <Bar dataKey="spent" name="Spent" fill={getAccentColor('red')} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
