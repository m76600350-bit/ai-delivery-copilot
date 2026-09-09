import { useCallback, useState } from 'react';
import { EMPTY_FILTERS } from './components/FilterBar.jsx';

// Shared across the Дашборд and Задачи screens (App.jsx holds the single
// instance and passes it to both) and persisted to localStorage so it also
// survives a page reload. Wrapped in try/catch — localStorage can throw in
// private-browsing/blocked-storage contexts, and a filter that fails to
// persist shouldn't break the app.
const STORAGE_KEY = 'delivery-board:filters';

function loadFilters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_FILTERS;
    return { ...EMPTY_FILTERS, ...JSON.parse(raw) };
  } catch {
    return EMPTY_FILTERS;
  }
}

function persist(filters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Non-fatal — filters just won't survive a reload this time.
  }
}

export default function useSharedFilters() {
  const [filters, setFilters] = useState(loadFilters);

  const updateFilter = useCallback((field, value) => {
    setFilters((prev) => {
      const next = { ...prev, [field]: value };
      persist(next);
      return next;
    });
  }, []);

  // Used by dashboard widget drill-down clicks, which pass a whole new
  // filter set (e.g. { team: ['Alpha'] }) rather than one field at a time.
  const replaceFilters = useCallback((partial) => {
    const next = { ...EMPTY_FILTERS, ...partial };
    setFilters(next);
    persist(next);
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Non-fatal.
    }
  }, []);

  return { filters, updateFilter, replaceFilters, resetFilters };
}
