import { useMemo } from 'react';
import { useTheme } from '../contexts/ThemeContext';

/**
 * Theme-aware colors for Recharts axis ticks, legends, and tooltip labels.
 *
 * Recharts applies many of these as SVG presentation attributes (e.g.
 * `tick={{ fill }}`, `stroke`) where CSS `var()` does not resolve reliably, so
 * we return concrete `rgb(...)` strings chosen per theme. In dark mode they
 * mirror the warm slate scale (muted slate-400 ticks, slate-300 for the stronger
 * y-axis / legend / tooltip text); in light mode they are the neutral gray ramp
 * (gray-500 ticks, gray-700 strong text) so they stay legible on white charts.
 * `grid` is the recessive gridline stroke and `cursor` the bar-hover highlight.
 */
export function useChartColors() {
  const { theme } = useTheme();
  return useMemo(() => {
    const light = theme === 'light';
    const tick = light ? 'rgb(107, 114, 128)' : 'rgb(171, 158, 140)';
    const tickStrong = light ? 'rgb(55, 65, 81)' : 'rgb(214, 203, 186)';
    return {
      axisTick: tick,
      tickStrong,
      legend: tickStrong,
      tooltipLabel: tickStrong,
      grid: light ? 'rgb(229, 231, 235)' : 'rgba(171, 158, 140, 0.18)',
      cursor: light ? 'rgba(100, 116, 139, 0.12)' : 'rgba(171, 158, 140, 0.12)',
    };
  }, [theme]);
}

export default useChartColors;
