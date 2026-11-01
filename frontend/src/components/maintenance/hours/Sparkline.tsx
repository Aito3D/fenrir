import type { HourPoint } from '../../../utils/hoursSeries';
import { dayNumber } from '../../../utils/hoursSeries';

interface SparklineProps {
  points: HourPoint[];
  color: string;
  width?: number;
  height?: number;
}

const PAD = 2;

/** A machine's own series on its own scale: x first→last date, y 0→max×1.05. */
export function Sparkline({ points, color, width = 70, height = 20 }: SparklineProps) {
  const svgProps = {
    'data-testid': 'sparkline',
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    'aria-hidden': true as const,
    className: 'shrink-0',
  };
  if (points.length === 0) return <svg {...svgProps} />;

  const x0 = dayNumber(points[0].date);
  const span = dayNumber(points[points.length - 1].date) - x0;
  const yMax = Math.max(...points.map((p) => p.hours)) * 1.05 || 1;
  const xy = points.map((p) => {
    const x = span > 0 ? PAD + ((dayNumber(p.date) - x0) / span) * (width - 2 * PAD) : width / 2;
    const y = height - PAD - (p.hours / yMax) * (height - 2 * PAD);
    return [x, y] as const;
  });
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg {...svgProps}>
      {xy.length > 1 && (
        <polyline
          points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      <circle cx={lx} cy={ly} r={2} fill={color} />
    </svg>
  );
}
