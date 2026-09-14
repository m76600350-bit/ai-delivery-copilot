import React from 'react';

// Used only by SprintBurndownWidget when 2+ sprints are selected for
// comparison. Sprints being compared can differ in both length and total SP,
// so plotting raw "факт" SP (as the single-sprint BurndownChart does) would
// visually mislead — a big sprint's line would tower over a small one even
// if both are equally on/off track. Normalizing each sprint's own "факт" to
// % of its own taken SP remaining makes the shapes directly comparable.
//
// No idealSp/idealPct line is drawn here (see SprintBurndownWidget's own
// comment for why — sprints of different length can't share one straight
// reference line against a shared relative-day x-axis without becoming
// inaccurate for at least one of them). X-axis is each sprint's own relative
// day index (д1, д2, ...), not a calendar date, so sprints starting on
// different dates still line up.
export default function MultiSprintBurndownChart({ series }) {
  const withPoints = series.filter((s) => s.points.length > 0);
  if (!withPoints.length) {
    return <p className="text-xs text-gray-400 py-8 text-center">Нет данных по выбранным спринтам</p>;
  }

  const width = 560;
  const height = 200;
  const padding = 32;
  const maxDayIndex = Math.max(1, ...withPoints.flatMap((s) => s.points.map((p) => p.dayIndex)));

  const x = (dayIndex) => padding + (maxDayIndex > 1 ? ((dayIndex - 1) / (maxDayIndex - 1)) * (width - padding * 2) : 0);
  const y = (pct) => height - padding - (Math.max(0, Math.min(100, pct)) / 100) * (height - padding * 2);

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#e5e7eb" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#e5e7eb" />
        <text x={padding - 6} y={padding + 4} textAnchor="end" fontSize="10" className="fill-gray-400">100%</text>
        <text x={padding - 6} y={height - padding} textAnchor="end" fontSize="10" className="fill-gray-400">0%</text>
        <text x={padding} y={height - padding + 16} fontSize="10" className="fill-gray-400">д1</text>
        <text x={width - padding} y={height - padding + 16} textAnchor="end" fontSize="10" className="fill-gray-400">
          д{maxDayIndex}
        </text>
        {withPoints.map((s) => {
          const linePoints = s.points
            .filter((p) => p.pct != null)
            .map((p) => `${x(p.dayIndex)},${y(p.pct)}`)
            .join(' ');
          return <polyline key={s.sprintId} points={linePoints} fill="none" stroke={s.color} strokeWidth="2" />;
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
        {series.map((s) => (
          <span key={s.sprintId} className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      <p className="text-[11px] text-gray-400 mt-1">
        % оставшихся SP от объёма, взятого в каждый спринт · без идеальной линии — при сравнении спринтов разной длины/объёма единая
        референсная линия была бы некорректной для части из них
      </p>
    </div>
  );
}
