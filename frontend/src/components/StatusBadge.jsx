import React from 'react';

// statusCategory here is Jira's category *key* ("new"/"indeterminate"/
// "done") as stored by the backend — never the category *name*, which is
// localized per Jira account (e.g. "Готово" instead of "Done") and would
// silently fail to match on any non-English site.
// Blocked is called out regardless of category (Jira usually files it under
// "indeterminate"); everything else follows the standard three categories.
function statusBadgeClasses(status, statusCategory) {
  const normalized = (status || '').toLowerCase();
  if (normalized.includes('block')) return 'bg-red-100 text-red-700';
  if (statusCategory === 'done') return 'bg-green-100 text-green-700';
  if (statusCategory === 'indeterminate') return 'bg-blue-100 text-blue-700';
  return 'bg-gray-100 text-gray-700';
}

export default function StatusBadge({ status, statusCategory }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${statusBadgeClasses(status, statusCategory)}`}
    >
      {status}
    </span>
  );
}
