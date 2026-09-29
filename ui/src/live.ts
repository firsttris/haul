import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export interface LiveProgress {
  bytesDone: number;
  size: number | null;
  speed: number;
}

type Snapshot = {
  items: Map<number, LiveProgress>;
  totalSpeed: number;
  connected: boolean;
  /** Extraction progress in percent per package id. */
  extract: Map<number, number>;
};

let snapshot: Snapshot = { items: new Map(), totalSpeed: 0, connected: false, extract: new Map() };
const listeners = new Set<() => void>();

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Live byte counters and total speed from the SSE stream. */
export function useLive(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

const topicKeys: Record<string, string[][]> = {
  downloads: [['packages'], ['stats']],
  accounts: [['accounts'], ['stats']],
  plugins: [['plugins']],
  settings: [['settings'], ['stats']],
};

/** Opens the SSE connection once and turns events into query invalidations. */
export function useLiveEvents(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    let flush: ReturnType<typeof setTimeout> | undefined;

    const invalidate = (topic: string) => {
      pending.add(topic);
      if (flush) return;
      // Coalesce bursts (e.g. many downloads changing at once) into one refetch.
      flush = setTimeout(() => {
        flush = undefined;
        for (const t of pending) for (const key of topicKeys[t] ?? []) qc.invalidateQueries({ queryKey: key });
        pending.clear();
      }, 250);
    };

    const connect = () => {
      es = new EventSource('/api/events');
      es.onopen = () => {
        publish({ connected: true });
        invalidate('downloads');
      };
      es.onerror = () => {
        publish({ connected: false });
        es?.close();
        retry = setTimeout(connect, 3000);
      };
      es.onmessage = (msg) => {
        const e = JSON.parse(msg.data);
        if (e.type === 'progress') {
          const items = new Map<number, LiveProgress>();
          for (const i of e.items) items.set(i.id, { bytesDone: i.bytesDone, size: i.size, speed: i.speed });
          const finished = [...snapshot.items.keys()].some((id) => !items.has(id));
          const extract = new Map<number, number>();
          for (const x of e.extract ?? []) extract.set(x.packageId, x.percent);
          publish({ items, totalSpeed: e.totalSpeed, extract });
          if (finished) invalidate('downloads');
        } else if (e.type === 'changed') {
          invalidate(e.topic);
        }
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      clearTimeout(flush);
      es?.close();
      publish({ connected: false });
    };
  }, [enabled, qc]);
}
