import { useEffect, useRef, useState } from 'react';
import { getSyncProgress } from './api.js';

// Polls GET /api/jira/sync/progress while `active` is true, so callers can
// show "получено N из M задач" instead of a plain spinner — sync fetches a
// Jira changelog per issue, so it can take a while for larger projects.
export default function useSyncProgress(active) {
  const [progress, setProgress] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!active) {
      setProgress(null);
      return undefined;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const data = await getSyncProgress();
        if (!cancelled) setProgress(data);
      } catch {
        // Progress is a nice-to-have — a failed poll just leaves the last
        // known value (or none) rather than interrupting the sync itself.
      }
      if (!cancelled) {
        timerRef.current = setTimeout(poll, 800);
      }
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
    };
  }, [active]);

  return progress;
}
