'use client';

import { useEffect, useRef, useState } from 'react';
import type { ServerMessage } from '@pulse/shared';
import { useAuth } from '@/lib/auth-context';
import { INGEST_WS_URL } from '@/lib/constants';

type ConnectionState = 'connecting' | 'live' | 'offline';

/**
 * "Active right now", pushed over a WebSocket.
 *
 * The client half of the lifecycle contract the server enforces:
 *   - the socket is closed on unmount, and a reconnect timer is cleared with
 *     it, so navigating between projects cannot leave a socket (or a pending
 *     timer) behind;
 *   - reconnects back off exponentially and are capped, so a server restart
 *     does not turn every open dashboard into a reconnect storm;
 *   - `initialCount` comes from a REST call, so the number is correct
 *     immediately rather than blank until the first 10-second broadcast tick.
 */
export function LiveCounter({
  projectId,
  initialCount = null,
}: {
  projectId: string;
  initialCount?: number | null;
}) {
  const { getToken } = useAuth();
  const [count, setCount] = useState<number | null>(initialCount);
  const [connection, setConnection] = useState<ConnectionState>('connecting');

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);

  useEffect(() => {
    // Guards against a late reconnect firing after the effect has been torn
    // down — React 18 strict mode mounts twice, which is exactly the case
    // that surfaces this bug.
    let disposed = false;

    const connect = async (): Promise<void> => {
      if (disposed) return;

      const token = await getToken();
      if (!token || disposed) return;

      const socket = new WebSocket(INGEST_WS_URL);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (disposed) {
          socket.close();
          return;
        }
        attemptsRef.current = 0;
        setConnection('live');
        // The token goes in the first frame: a WebSocket carries no
        // Authorization header past the upgrade.
        socket.send(JSON.stringify({ type: 'subscribe', token, projectId }));
      });

      socket.addEventListener('message', (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'active_visitors' && message.projectId === projectId) {
          setCount(message.count);
        } else if (message.type === 'error') {
          setConnection('offline');
        }
      });

      socket.addEventListener('close', () => {
        if (disposed) return;
        setConnection('offline');
        // 1s, 2s, 4s … capped at 30s. Unbounded retries at a fixed interval
        // are how a restarting server gets hammered by its own dashboards.
        const delay = Math.min(30_000, 1000 * 2 ** attemptsRef.current);
        attemptsRef.current += 1;
        reconnectTimerRef.current = setTimeout(() => void connect(), delay);
      });

      socket.addEventListener('error', () => setConnection('offline'));
    };

    void connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [projectId, getToken]);

  return (
    <div
      className="flex items-center gap-2 rounded-lg border px-3 py-1.5"
      style={{ backgroundColor: 'var(--surface-raised)', borderColor: 'var(--border)' }}
    >
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full"
        style={{
          backgroundColor: connection === 'live' ? 'var(--positive)' : 'var(--ink-subtle)',
        }}
      />
      {/* Polite, not assertive: a visitor count changing every 10 seconds must
          not interrupt whatever a screen-reader user is currently reading. */}
      <span className="text-xs tabular-nums" style={{ color: 'var(--ink-muted)' }} aria-live="polite">
        <strong style={{ color: 'var(--ink)' }}>{count ?? '—'}</strong> active now
      </span>
      {connection === 'offline' ? (
        <span className="text-xs" style={{ color: 'var(--ink-subtle)' }}>
          (reconnecting)
        </span>
      ) : null}
    </div>
  );
}
