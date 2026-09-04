import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Project } from '@pulse/shared/models';
import type { ClientMessage, ServerMessage } from '@pulse/shared';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { getTokenVerifier } from '../firebase.js';
import { User } from '@pulse/shared/models';
import { countActiveSessionsMany } from './activeSessions.js';

const log = createLogger('ws');

/**
 * Realtime active-visitor broadcasting.
 *
 * The failure mode this file is written to avoid is leaked connections. A
 * WebSocket server accumulates state in three places — the socket set, the
 * per-socket subscription set, and the reverse project→sockets index — and a
 * connection that closes without all three being cleaned leaves the server
 * broadcasting to a dead socket forever, holding its memory and its entry in
 * every index. Under a load balancer that silently drops idle connections this
 * is not an edge case; it is the normal case.
 *
 * Three mechanisms together:
 *   1. `close` and `error` both route through one `cleanup()`. Never two paths.
 *   2. A heartbeat: ping every 30s, terminate any socket that did not pong.
 *      A half-open TCP connection (client's laptop lid closed, NAT timeout)
 *      never emits `close`, so without this it would live forever.
 *   3. `cleanup()` removes the project index entry when its last subscriber
 *      leaves, so the index does not grow without bound either.
 *
 * `wsServer.test.ts` asserts all three actually reclaim their state.
 */

interface SocketState {
  /** Projects this socket has successfully subscribed to. */
  subscriptions: Set<string>;
  /** Set false on ping, true on pong. A socket still false at the next tick is dead. */
  isAlive: boolean;
  userId: string | null;
}

export interface RealtimeServer {
  wss: WebSocketServer;
  /** Number of live sockets — exposed for the leak tests and /health. */
  connectionCount(): number;
  /** Number of projects with at least one subscriber. */
  subscribedProjectCount(): number;
  subscriberCount(projectId: string): number;
  broadcastActiveCounts(): Promise<void>;
  close(): Promise<void>;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

export function createRealtimeServer(server: HttpServer): RealtimeServer {
  const cfg = getConfig();

  // `path` scopes the upgrade so the HTTP server can serve everything else.
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

  const sockets = new Map<WebSocket, SocketState>();
  /** Reverse index so a broadcast does not scan every socket per project. */
  const projectSubscribers = new Map<string, Set<WebSocket>>();

  /**
   * The single teardown path. Idempotent: `close` after `error` (or a manual
   * terminate) must not double-remove or throw.
   */
  function cleanup(socket: WebSocket): void {
    const state = sockets.get(socket);
    if (!state) return;

    for (const projectId of state.subscriptions) {
      const subscribers = projectSubscribers.get(projectId);
      if (!subscribers) continue;
      subscribers.delete(socket);
      // Drop the whole entry when empty — otherwise the map retains one key per
      // project ever subscribed to, which is a slow leak with a long fuse.
      if (subscribers.size === 0) projectSubscribers.delete(projectId);
    }

    state.subscriptions.clear();
    sockets.delete(socket);

    log.debug('socket cleaned up', {
      connections: sockets.size,
      projects: projectSubscribers.size,
    });
  }

  async function handleSubscribe(socket: WebSocket, message: Extract<ClientMessage, { type: 'subscribe' }>) {
    const state = sockets.get(socket);
    if (!state) return;

    /*
     * The token is verified here, on the server, before any project data is
     * revealed — the same rule as the REST API. A WebSocket carries no
     * Authorization header after the upgrade, so the client sends the Firebase
     * ID token in the subscribe frame; it is still a signed token verified
     * against Firebase's keys, never a claimed identity.
     */
    let uid: string;
    try {
      const decoded = await getTokenVerifier().verify(message.token);
      uid = decoded.uid;
    } catch {
      send(socket, { type: 'error', code: 'unauthorized', message: 'Invalid or expired token' });
      return;
    }

    const user = await User.findOne({ firebaseUid: uid }, { _id: 1 }).lean();
    if (!user) {
      send(socket, { type: 'error', code: 'unauthorized', message: 'Unknown user' });
      return;
    }

    // Ownership checked in the query, so an unrelated project id is
    // indistinguishable from a nonexistent one.
    const project = await Project.findOne(
      { _id: message.projectId, ownerId: user._id },
      { _id: 1 },
    ).lean();
    if (!project) {
      send(socket, { type: 'error', code: 'forbidden', message: 'No access to that project' });
      return;
    }

    const projectId = String(project._id);
    state.userId = String(user._id);
    state.subscriptions.add(projectId);

    let subscribers = projectSubscribers.get(projectId);
    if (!subscribers) {
      subscribers = new Set();
      projectSubscribers.set(projectId, subscribers);
    }
    subscribers.add(socket);

    send(socket, { type: 'subscribed', projectId });
    log.debug('socket subscribed', { projectId, connections: sockets.size });
  }

  function handleUnsubscribe(socket: WebSocket, projectId: string): void {
    const state = sockets.get(socket);
    if (!state) return;
    state.subscriptions.delete(projectId);
    const subscribers = projectSubscribers.get(projectId);
    if (subscribers) {
      subscribers.delete(socket);
      if (subscribers.size === 0) projectSubscribers.delete(projectId);
    }
    send(socket, { type: 'unsubscribed', projectId });
  }

  wss.on('connection', (socket: WebSocket) => {
    sockets.set(socket, { subscriptions: new Set(), isAlive: true, userId: null });
    log.debug('socket connected', { connections: sockets.size });

    socket.on('pong', () => {
      const state = sockets.get(socket);
      if (state) state.isAlive = true;
    });

    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        send(socket, { type: 'error', code: 'bad_request', message: 'Malformed JSON' });
        return;
      }

      if (message?.type === 'subscribe' && typeof message.token === 'string' && typeof message.projectId === 'string') {
        // Errors inside the async handler must not become an unhandled
        // rejection that takes the process down.
        void handleSubscribe(socket, message).catch((err) => {
          log.error('subscribe failed', err);
          send(socket, { type: 'error', code: 'internal', message: 'Subscription failed' });
        });
      } else if (message?.type === 'unsubscribe' && typeof message.projectId === 'string') {
        handleUnsubscribe(socket, message.projectId);
      } else {
        send(socket, { type: 'error', code: 'bad_request', message: 'Unknown message type' });
      }
    });

    // Both paths converge on cleanup(). An 'error' is always followed by a
    // 'close' in ws, but relying on that ordering would be a latent bug —
    // cleanup() is idempotent precisely so we do not have to.
    socket.on('close', () => cleanup(socket));
    socket.on('error', (err) => {
      log.debug('socket error', { message: err.message });
      cleanup(socket);
    });
  });

  /**
   * Heartbeat. A socket that did not answer the previous ping is terminated —
   * `terminate()`, not `close()`, because a half-open connection will never
   * complete a closing handshake and `close()` would wait forever.
   */
  const heartbeat = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (!state.isAlive) {
        log.debug('terminating unresponsive socket');
        socket.terminate();
        // terminate() emits 'close', but call cleanup directly so state is gone
        // immediately even if the event is delayed.
        cleanup(socket);
        continue;
      }
      state.isAlive = false;
      socket.ping();
    }
  }, cfg.WS_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  /** Push the current active-visitor count to every subscriber. */
  async function broadcastActiveCounts(): Promise<void> {
    const projectIds = [...projectSubscribers.keys()];
    if (projectIds.length === 0) return;

    const counts = await countActiveSessionsMany(projectIds);
    const at = new Date().toISOString();

    for (const [projectId, subscribers] of projectSubscribers) {
      const message: ServerMessage = {
        type: 'active_visitors',
        projectId,
        count: counts.get(projectId) ?? 0,
        at,
      };
      const payload = JSON.stringify(message);
      for (const socket of subscribers) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }
  }

  const broadcaster = setInterval(() => {
    void broadcastActiveCounts().catch((err) => log.error('broadcast failed', err));
  }, cfg.WS_BROADCAST_INTERVAL_MS);
  broadcaster.unref?.();

  return {
    wss,
    connectionCount: () => sockets.size,
    subscribedProjectCount: () => projectSubscribers.size,
    subscriberCount: (projectId: string) => projectSubscribers.get(projectId)?.size ?? 0,
    broadcastActiveCounts,
    async close() {
      clearInterval(heartbeat);
      clearInterval(broadcaster);
      for (const socket of sockets.keys()) {
        socket.terminate();
        cleanup(socket);
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
