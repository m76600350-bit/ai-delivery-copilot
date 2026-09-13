import React from 'react';

// Shared between the Спринты screen and the Dashboard's "Burndown спринта"
// widget so the two can never render the same sprint's burndown differently.
export default function BurndownChart({ data, lagSp }) {
  if (!data.length) {
    return <p className="text-xs text-gray-400 py-8 text-center">Нет данных по спринту</p>;
  }
  const width = 560;
  const height = 200;
  const padding = 32;
  // actualSp is null for days beyond today (the sprint's timeline always
  // spans the whole start_date..end_date range, but there's no fact yet for
  // days that haven't happened) — excluded from both the Y scale and the
  // "факт" line, which simply stops at the last known day instead of
  // dropping to 0.
  const maxY = Math.max(1, ...data.map((d) => d.idealSp), ...data.filter((d) => d.actualSp != null).map((d) => d.actualSp));
  const n = data.length;
  const x = (i) => padding + (n > 1 ? (i / (n - 1)) * (width - padding * 2) : 0);
  const y = (v) => height - padding - (v / maxY) * (height - padding * 2);
  const actualPoints = data
    .map((d, i) => (d.actualSp == null ? null : `${x(i)},${y(d.actualSp)}`))
    .filter(Boolean)
    .join(' ');
  const idealPoints = data.map((d, i) => `${x(i)},${y(d.idealSp)}`).join(' ');

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#e5e7eb" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#e5e7eb" />
        <text x={padding - 6} y={padding + 4} textAnchor="end" fontSize="10" className="fill-gray-400">{Math.round(maxY)}</text>
        <text x={padding - 6} y={height - padding} textAnchor="end" fontSize="10" className="fill-gray-400">0</text>
        <text x={padding} y={height - padding + 16} fontSize="10" className="fill-gray-400">д{data[0].dayIndex}</text>
        <text x={width - padding} y={height - padding + 16} textAnchor="end" fontSize="10" className="fill-gray-400">д{data[n - 1].dayIndex}</text>
        <polyline points={idealPoints} fill="none" stroke="#9ca3af" strokeDasharray="4 3" strokeWidth="1.5" />
        <polyline points={actualPoints} fill="none" stroke="#2563eb" strokeWidth="2" />
      </svg>
      <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-blue-600" /> факт</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-gray-400" style={{ borderTop: '1px dashed' }} /> идеал</span>
        {lagSp != null && lagSp > 0 && <span className="text-red-600 font-medium">отставание {lagSp} SP</span>}
      </div>
    </div>
  );
}
