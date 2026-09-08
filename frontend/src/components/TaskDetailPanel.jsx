import React from 'react';
import StatusBadge from './StatusBadge.jsx';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

function Field({ label, children }) {
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-sm text-gray-800 mt-0.5">{children ?? '—'}</p>
    </div>
  );
}

export default function TaskDetailPanel({ task, siteUrl, onClose }) {
  if (!task) return null;

  const jiraUrl = siteUrl ? `${siteUrl.replace(/\/$/, '')}/browse/${task.issueKey}` : null;

  return (
    <div className="fixed inset-0 z-20 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white h-full shadow-xl overflow-y-auto p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-gray-400">{task.issueKey}</p>
            <h2 className="text-lg font-semibold text-gray-800 mt-0.5">{task.summary}</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ×
          </button>
        </div>

        <div>
          <StatusBadge status={task.status} statusCategory={task.statusCategory} />
        </div>

        {jiraUrl && (
          <a
            href={jiraUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-sm text-blue-600 hover:underline"
          >
            Открыть в Jira →
          </a>
        )}

        <div className="grid grid-cols-2 gap-4 border-t border-gray-100 pt-4">
          <Field label="Проект">{task.project}</Field>
          <Field label="Тип">{task.issueType}</Field>
          <Field label="Команда">{task.team}</Field>
          <Field label="Исполнитель">{task.assignee || 'не назначен'}</Field>
          <Field label="Приоритет">{task.priority}</Field>
          <Field label="Спринт">{task.sprint}</Field>
          <Field label="Story Points">{task.storyPoints}</Field>
          <Field label="Дней в статусе">{task.daysInStatus == null ? '—' : `${task.daysInStatus} д`}</Field>
          <Field label="Cycle time">{task.cycleTime == null ? '—' : `${task.cycleTime} дн`}</Field>
          <Field label="Lead time">{task.leadTimeDays == null ? '—' : `${task.leadTimeDays} дн`}</Field>
          <Field label="Возвратов из Done">{task.reopenCount ?? 0}</Field>
          <Field label="Метки">{task.labels || '—'}</Field>
        </div>

        <div className="grid grid-cols-2 gap-4 border-t border-gray-100 pt-4">
          <Field label="Создана">{formatDate(task.createdAt)}</Field>
          <Field label="Обновлена">{formatDate(task.updatedAt)}</Field>
          <Field label="Начата">{formatDate(task.startedAt)}</Field>
          <Field label="Завершена">{formatDate(task.resolvedAt)}</Field>
          <Field label="Последняя синхронизация">{formatDate(task.lastSyncedAt)}</Field>
        </div>
      </div>
    </div>
  );
}
