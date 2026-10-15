import { useCallback, useEffect, useState } from 'react';

let csrfToken = '';
export class RequestError extends Error {}

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : {
        'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken,
      },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new RequestError('NETWORK_ERROR');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new RequestError('SERVER_ERROR');
  }
  const data = await response.json();
  if (!response.ok) throw new RequestError(data.error || 'SERVER_ERROR');
  if (typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
  return data as T;
}

export function usePolling<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    let failures = 0;
    let first = true;
    let loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (!active || loading) return;
      clearTimeout(timeout);
      const started = Date.now();
      if (first || document.visibilityState !== 'hidden') {
        first = false;
        loading = true;
        try {
          const result = await api<T>(path, undefined, controller.signal);
          if (!active) return;
          setData(result);
          setError('');
          failures = 0;
        } catch (error) {
          if (!active) return;
          setError(error instanceof Error ? error.message : 'SERVER_ERROR');
          failures += 1;
        } finally {
          loading = false;
        }
      }
      const delay = Math.min(3000 * 2 ** failures, 30000);
      if (active) timeout = setTimeout(load, Math.max(100, delay - (Date.now() - started)));
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    void load();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [path, revision]);
  return { data, error, refresh };
}
