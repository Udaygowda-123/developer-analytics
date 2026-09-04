import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import RedisMock from 'ioredis-mock';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import type { ServerMessage } from '@pulse/shared';
import { clearTestMongo, startTestMongo, stopTestMongo } from '../../test/mongo.js';
import { createTestProject, createTestUser } from '../../test/fixtures.js';
import { setTokenVerifierForTesting } from '../firebase.js';
import { setRedisForTesting, type RedisClient } from '../redis.js';
import { loadConfig, setConfigForTesting } from '../config.js';
import { createRealtimeServer, type RealtimeServer } from './wsServer.js';
import { touchSession } from './activeSessions.js';

/**
 * Connection-lifecycle tests.
 *
 * The assertions that matter are the ones about state *after* a disconnect:
 * a WebSocket server that keeps a closed socket in its subscriber index will
 * pass every functional test and still exhaust memory in production.
 */

let server: Server;
let realtime: RealtimeServer;
let port: number;
let projectId: string;
let otherProjectId: string;
const FIREBASE_UID = 'test-uid-1';

beforeAll(async () => {
  await startTestMongo();
  // Short intervals so heartbeat behaviour is observable without long waits.
  setConfigForTesting(
    loadConfig({
      ...process.env,
      WS_HEARTBEAT_INTERVAL_MS: '150',
      WS_BROADCAST_INTERVAL_MS: '100',
      ACTIVE_WINDOW_MINUTES: '5',
    } as NodeJS.ProcessEnv),
  );
});

afterAll(async () => {
  setConfigForTesting(null);
  setTokenVerifierForTesting(null);
  await stopTestMongo();
});

beforeEach(async () => {
  await clearTestMongo();
  setRedisForTesting(new RedisMock() as unknown as RedisClient);

  // Stub the verifier: these tests are about socket lifecycle, and a real
  // Firebase project would make them a network test.
  setTokenVerifierForTesting({
    async verify(token: string) {
      if (token !== 'valid-token') throw new Error('invalid token');
      return { uid: FIREBASE_UID, email: 'owner@example.com' } as never;
    },
  });

  const user = await createTestUser({ firebaseUid: FIREBASE_UID, email: 'owner@example.com' });
  const project = await createTestProject(user._id as Types.ObjectId);
  projectId = String(project._id);

  const stranger = await createTestUser({ firebaseUid: 'someone-else' });
  const strangerProject = await createTestProject(stranger._id as Types.ObjectId);
  otherProjectId = String(strangerProject._id);

  server = createServer();
  realtime = createRealtimeServer(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket: WebSocket, predicate?: (m: ServerMessage) => boolean): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), 5_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      if (predicate && !predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function subscribe(socket: WebSocket, id = projectId): Promise<ServerMessage> {
  const waiting = nextMessage(socket);
  socket.send(JSON.stringify({ type: 'subscribe', token: 'valid-token', projectId: id }));
  return waiting;
}

/** Poll until a condition holds, so tests do not depend on event ordering. */
async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition never became true');
}

describe('authentication', () => {
  it('subscribes with a valid token', async () => {
    const socket = await connect();
    const reply = await subscribe(socket);
    expect(reply).toEqual({ type: 'subscribed', projectId });
    socket.close();
  });

  it('rejects an invalid token without revealing anything about the project', async () => {
    const socket = await connect();
    const waiting = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'subscribe', token: 'nope', projectId }));
    const reply = await waiting;

    expect(reply).toMatchObject({ type: 'error', code: 'unauthorized' });
    expect(realtime.subscriberCount(projectId)).toBe(0);
    socket.close();
  });

  it("refuses to subscribe to another user's project", async () => {
    const socket = await connect();
    const waiting = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'subscribe', token: 'valid-token', projectId: otherProjectId }));
    const reply = await waiting;

    expect(reply).toMatchObject({ type: 'error', code: 'forbidden' });
    expect(realtime.subscriberCount(otherProjectId)).toBe(0);
    socket.close();
  });

  it('rejects malformed JSON without dropping the connection', async () => {
    const socket = await connect();
    const waiting = nextMessage(socket);
    socket.send('{not json');
    expect(await waiting).toMatchObject({ type: 'error', code: 'bad_request' });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});

describe('connection leaks', () => {
  it('releases all state when a client disconnects cleanly', async () => {
    const socket = await connect();
    await subscribe(socket);

    expect(realtime.connectionCount()).toBe(1);
    expect(realtime.subscribedProjectCount()).toBe(1);
    expect(realtime.subscriberCount(projectId)).toBe(1);

    socket.close();

    await eventually(() => realtime.connectionCount() === 0);
    // The socket set, the project index, and the per-project subscriber set
    // must ALL be empty — a leak in any one of the three is a leak.
    expect(realtime.connectionCount()).toBe(0);
    expect(realtime.subscribedProjectCount()).toBe(0);
    expect(realtime.subscriberCount(projectId)).toBe(0);
  });

  it('releases state when a client vanishes without a close handshake', async () => {
    const socket = await connect();
    await subscribe(socket);
    expect(realtime.connectionCount()).toBe(1);

    // terminate() destroys the socket without the closing handshake — what a
    // crashed browser tab or a killed process actually does.
    socket.terminate();

    await eventually(() => realtime.connectionCount() === 0);
    expect(realtime.subscribedProjectCount()).toBe(0);
  });

  it('does not leak across many connect/disconnect cycles', async () => {
    for (let cycle = 0; cycle < 20; cycle++) {
      const socket = await connect();
      await subscribe(socket);
      socket.close();
      await eventually(() => realtime.connectionCount() === 0);
    }

    expect(realtime.connectionCount()).toBe(0);
    expect(realtime.subscribedProjectCount()).toBe(0);
  });

  it('keeps the project entry while other subscribers remain, and drops it at the last', async () => {
    const a = await connect();
    const b = await connect();
    await subscribe(a);
    await subscribe(b);
    expect(realtime.subscriberCount(projectId)).toBe(2);

    a.close();
    await eventually(() => realtime.subscriberCount(projectId) === 1);
    // Still one subscriber, so the index entry must survive.
    expect(realtime.subscribedProjectCount()).toBe(1);

    b.close();
    await eventually(() => realtime.subscribedProjectCount() === 0);
  });

  it('cleans up a socket that never subscribed', async () => {
    const socket = await connect();
    await eventually(() => realtime.connectionCount() === 1);
    socket.close();
    await eventually(() => realtime.connectionCount() === 0);
  });

  it('removes the project index entry on unsubscribe', async () => {
    const socket = await connect();
    await subscribe(socket);

    const waiting = nextMessage(socket, (m) => m.type === 'unsubscribed');
    socket.send(JSON.stringify({ type: 'unsubscribe', projectId }));
    await waiting;

    expect(realtime.subscriberCount(projectId)).toBe(0);
    expect(realtime.subscribedProjectCount()).toBe(0);
    // The connection itself is still alive — unsubscribe is not disconnect.
    expect(realtime.connectionCount()).toBe(1);
    socket.close();
  });
});

describe('heartbeat', () => {
  it('terminates a socket that stops answering pings', async () => {
    const socket = await connect();
    await subscribe(socket);
    expect(realtime.connectionCount()).toBe(1);

    // Suppress the automatic pong so the socket looks half-open — a laptop
    // lid closing, or a NAT dropping the flow, which never emits 'close'.
    socket.pong = () => {};

    // Two heartbeat intervals: the first pings, the second finds no pong.
    await eventually(() => realtime.connectionCount() === 0, 3_000);
    expect(realtime.subscribedProjectCount()).toBe(0);
    socket.terminate();
  });

  it('keeps a responsive socket alive across several heartbeats', async () => {
    const socket = await connect();
    await subscribe(socket);

    // ws auto-pongs, so this connection should survive multiple intervals.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(realtime.connectionCount()).toBe(1);
    socket.close();
  });
});

describe('broadcasting', () => {
  it('pushes the active-visitor count to subscribers', async () => {
    await touchSession(projectId, 'session-a');
    await touchSession(projectId, 'session-b');

    const socket = await connect();
    await subscribe(socket);

    const message = await nextMessage(socket, (m) => m.type === 'active_visitors');
    expect(message).toMatchObject({ type: 'active_visitors', projectId, count: 2 });
    socket.close();
  });

  it('does not send one project’s counts to another project’s subscribers', async () => {
    await touchSession(otherProjectId, 'session-x');

    const socket = await connect();
    await subscribe(socket);

    const message = await nextMessage(socket, (m) => m.type === 'active_visitors');
    expect(message).toMatchObject({ projectId, count: 0 });
    socket.close();
  });

  it('counts a returning session once, not twice', async () => {
    await touchSession(projectId, 'session-a');
    await touchSession(projectId, 'session-a');

    const socket = await connect();
    await subscribe(socket);

    const message = await nextMessage(socket, (m) => m.type === 'active_visitors');
    expect(message).toMatchObject({ count: 1 });
    socket.close();
  });

  it('excludes sessions outside the active window', async () => {
    const sixMinutesAgo = Date.now() - 6 * 60_000;
    await touchSession(projectId, 'stale', sixMinutesAgo);
    await touchSession(projectId, 'fresh');

    const socket = await connect();
    await subscribe(socket);

    const message = await nextMessage(socket, (m) => m.type === 'active_visitors');
    expect(message).toMatchObject({ count: 1 });
    socket.close();
  });

  it('is a no-op with no subscribers', async () => {
    await expect(realtime.broadcastActiveCounts()).resolves.toBeUndefined();
  });
});

describe('shutdown', () => {
  it('closes every connection and clears all state', async () => {
    const a = await connect();
    const b = await connect();
    await subscribe(a);
    await subscribe(b);
    expect(realtime.connectionCount()).toBe(2);

    await realtime.close();

    expect(realtime.connectionCount()).toBe(0);
    expect(realtime.subscribedProjectCount()).toBe(0);
  });
});
