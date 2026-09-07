'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth-context';
import { ApiClientError, apiRequest, type RequestOptions } from './api';

/**
 * Data fetching for authenticated endpoints.
 *
 * Deliberately hand-rolled rather than pulling in a data-fetching library: the
 * dashboard has four read endpoints and no cross-component cache invalidation
 * to speak of, so a library would be more configuration than code.
 *
 * The two things it does get right, because both are easy to get wrong:
 *   - every request is aborted when the component unmounts or the key changes,
 *     so a slow response cannot resolve into an unmounted tree or overwrite a
 *     newer result with an older one;
 *   - loading/error/data are a single state object, so there is no window
 *     where `loading` and `error` are both true.
 */

export type ApiState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: null; error: ApiClientError };

export interface UseApiResult<T> {
  state: ApiState<T>;
  /** Convenience accessors, so components need not destructure the union. */
  data: T | null;
  error: ApiClientError | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useApi<T>(
  path: string | null,
  options: Omit<RequestOptions, 'token' | 'signal'> = {},
  /** Extra values that should trigger a refetch when they change. */
  deps: unknown[] = [],
): UseApiResult<T> {
  const { getToken, loading: authLoading } = useAuth();
  const [state, setState] = useState<ApiState<T>>({ status: 'loading', data: null, error: null });
  const [nonce, setNonce] = useState(0);

  // Options are usually an inline object literal, which would be a new
  // reference every render and re-run the effect forever. Keep them in a ref
  // and depend on the serialised query instead.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const querySignature = JSON.stringify(options.query ?? {});

  useEffect(() => {
    if (path === null || authLoading) return;

    const controller = new AbortController();
    let active = true;

    setState({ status: 'loading', data: null, error: null });

    void (async () => {
      try {
        const token = await getToken();
        const data = await apiRequest<T>(path, {
          ...optionsRef.current,
          token,
          signal: controller.signal,
        });
        if (active) setState({ status: 'success', data, error: null });
      } catch (err) {
        if (!active || controller.signal.aborted) return;
        setState({
          status: 'error',
          data: null,
          error:
            err instanceof ApiClientError
              ? err
              : new ApiClientError(0, 'internal', 'Something went wrong'),
        });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, querySignature, nonce, authLoading, getToken, ...deps]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return {
    state,
    data: state.data,
    error: state.error,
    isLoading: state.status === 'loading',
    refetch,
  };
}

/** Imperative counterpart for writes (create project, delete monitor, …). */
export function useApiMutation<TResult, TInput = unknown>(
  buildRequest: (input: TInput) => { path: string } & Omit<RequestOptions, 'token' | 'signal'>,
) {
  const { getToken } = useAuth();
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  const mutate = useCallback(
    async (input: TInput): Promise<TResult> => {
      setPending(true);
      setError(null);
      try {
        const { path, ...rest } = buildRequest(input);
        const token = await getToken();
        return await apiRequest<TResult>(path, { ...rest, token });
      } catch (err) {
        const apiError =
          err instanceof ApiClientError
            ? err
            : new ApiClientError(0, 'internal', 'Something went wrong');
        setError(apiError);
        throw apiError;
      } finally {
        setPending(false);
      }
    },
    [buildRequest, getToken],
  );

  return { mutate, isPending, error, reset: () => setError(null) };
}
