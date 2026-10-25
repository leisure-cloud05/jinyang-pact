/** Session state + SSE subscription, and a small fetch-on-change resource hook. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StateView, ViewMode } from '../../src/server/api-types';
import { errorText, getJson, sessionUrl, viewParam } from './api';

const SSE_TYPES = ['control', 'phase', 'round', 'pause', 'decision', 'narration', 'interrupt', 'suspended', 'terminal', 'outcome', 'progress', 'error'];

export interface LiveSession {
  state: StateView | null;
  error: string | null;
  /** Increments whenever the engine reported progress (panels refetch on change). */
  tick: number;
  refresh: () => void;
  connected: boolean;
  lastEvent: string | null;
}

export function useLiveSession(sessionId: string | null, view: ViewMode): LiveSession {
  const [state, setState] = useState<StateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const mine = ++seq.current;
    try {
      const s = await getJson<StateView>(sessionUrl(sessionId, 'state', { view: viewParam(view) }));
      if (mine === seq.current) {
        setState(s);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) setError(errorText(err));
    }
  }, [sessionId, view]);

  const refresh = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setTick((t) => t + 1);
      void load();
    }, 120);
  }, [load]);

  useEffect(() => {
    setState(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(sessionUrl(sessionId, 'stream'));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const onAny = (ev: MessageEvent<string>): void => {
      setLastEvent(ev.type);
      refresh();
    };
    for (const t of SSE_TYPES) es.addEventListener(t, onAny as EventListener);
    return () => {
      es.close();
      setConnected(false);
    };
  }, [sessionId, refresh]);

  return { state, error, tick, refresh, connected, lastEvent };
}

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useResource<T>(url: string | null, tick: number): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!url) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getJson<T>(url)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url, tick, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

/** Persisted UI preference (localStorage, best effort). */
export function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (window.localStorage.getItem(`jinyang.${key}`) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(`jinyang.${key}`, v);
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}
