/**
 * Deck templates over the collab server: the browser editor's route to the
 * same library the desktop app keeps (main/templateStore.ts). Saving reads
 * the live room, taking copies the template's files into the deck, a new deck
 * can start from one, and the routes follow the server's permission rules —
 * hosted sessions have none, view-only participants cannot save or take, and
 * with --access only the admin replaces or deletes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ServerMessage } from '../src/shared/collab.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

const ADMIN = 'vincent@tailnet.example';
const ALICE = 'alice@tailnet.example';
const BOB = 'bob@tailnet.example';

const asUser = (login: string): Record<string, string> => ({ 'tailscale-user-login': login });

describe('collab server templates', () => {
  let rootDir: string;
  let templatesDir: string;
  let previousTemplatesDir: string | undefined;
  let server: RunningCollabServer;
  let base: string;
  let sockets: WebSocket[] = [];

  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, init);
    const body = await response.json().catch(() => null);
    return { status: response.status, body: body as any };
  };
  const post = (path: string, headers: Record<string, string> = {}) => api(path, { method: 'POST', headers });

  const seedDeck = async (id: string, title: string, access?: unknown) => {
    const dir = join(rootDir, id);
    await mkdir(join(dir, 'assets'), { recursive: true });
    await saveDeck(dir, parseDeck({ ...emptyDeck(title), slides: [{ id: 's1', name: 'One' }] }));
    await writeFile(join(dir, 'theme.css'), '/* t */\n', 'utf8');
    if (access) await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
    return dir;
  };

  const start = async (options: { hostedDeckId?: string; access?: boolean } = {}) => {
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      ...(options.hostedDeckId ? { hostedDeckId: options.hostedDeckId } : {}),
      ...(options.access ? { accessControl: { admin: ADMIN } } : {}),
    });
    base = `http://127.0.0.1:${server.port}`;
  };

  /** Join a deck as a peer; resolves once welcomed, with a way to await the next message of a kind. */
  const join_ = async (deckId: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?deck=${encodeURIComponent(deckId)}`);
    sockets.push(socket);
    const queue: ServerMessage[] = [];
    const waiters: Array<() => void> = [];
    socket.on('message', (raw) => {
      queue.push(ServerMessageSchema.parse(JSON.parse(String(raw))));
      waiters.splice(0).forEach((wake) => wake());
    });
    const nextOfKind = async (kind: ServerMessage['kind']): Promise<ServerMessage> => {
      const deadline = Date.now() + 4000;
      for (;;) {
        const index = queue.findIndex((message) => message.kind === kind);
        if (index !== -1) return queue.splice(index, 1)[0];
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${kind}`);
        await new Promise<void>((wake) => {
          waiters.push(wake);
          setTimeout(wake, 100);
        });
      }
    };
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name: 'A' }));
    await nextOfKind('welcome');
    return { socket, nextOfKind };
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-templates-'));
    templatesDir = await mkdtemp(join(tmpdir(), 'collab-template-library-'));
    previousTemplatesDir = process.env.DECKWERK_TEMPLATES_DIR;
    process.env.DECKWERK_TEMPLATES_DIR = templatesDir;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets = [];
    await server?.close();
    if (previousTemplatesDir === undefined) delete process.env.DECKWERK_TEMPLATES_DIR;
    else process.env.DECKWERK_TEMPLATES_DIR = previousTemplatesDir;
    await rm(rootDir, { recursive: true, force: true });
    await rm(templatesDir, { recursive: true, force: true });
  });

  it('saves the live session, takes it into a deck and starts a new deck from it', async () => {
    const sourceDir = await seedDeck('source', 'Source talk');
    await writeFile(join(sourceDir, 'assets', 'ground.png'), 'png bytes');
    const targetDir = await seedDeck('target', 'Target talk');
    await start();

    expect((await api('/api/config')).body.templates).toEqual({ canManage: true });
    expect((await api('/api/templates')).body).toEqual([]);

    // Edits that have reached the room but not the disk belong in the design.
    const peer = await join_('source');
    peer.socket.send(JSON.stringify({ kind: 'theme', css: '.live { background: url(assets/ground.png); }\n' }));
    peer.socket.send(JSON.stringify({
      kind: 'txn', txnId: 't1', baseSeq: 0, label: 'colour',
      ops: [{ op: 'updateDeck', recentColors: ['#123456'] }],
    }));
    await peer.nextOfKind('txn');
    // deck.json is written on a debounce, so the disk does not have the colour yet.
    expect(JSON.parse(await readFile(join(sourceDir, 'deck.json'), 'utf8')).recentColors ?? []).toEqual([]);

    const saved = await post('/api/templates?deck=source&name=Looped%20Talk');
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ status: 'saved', template: { id: 'looped-talk', name: 'Looped Talk', source: 'Source talk' } });
    const onDisk = JSON.parse(await readFile(join(templatesDir, 'looped-talk', 'template.json'), 'utf8'));
    expect(onDisk.design.recentColors).toEqual(['#123456']);
    expect(onDisk.css).toContain('.live');
    expect(onDisk.assets).toEqual(['assets/ground.png']);
    expect((await api('/api/templates')).body.map((t: { id: string }) => t.id)).toEqual(['looped-talk']);

    // The same name again asks first, and replaces when told to.
    expect((await post('/api/templates?deck=source&name=Looped%20Talk')).body)
      .toEqual({ status: 'exists', id: 'looped-talk' });
    expect((await post('/api/templates?deck=source&name=Looped%20Talk&replace=1')).body.status).toBe('saved');

    // Taking brings the files along and hands the template over to apply.
    const taken = await post('/api/templates/take?deck=target&id=looped-talk');
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ id: 'looped-talk', css: expect.stringContaining('.live') });
    expect(await readFile(join(targetDir, 'assets', 'ground.png'), 'utf8')).toBe('png bytes');
    expect((await post('/api/templates/take?deck=target&id=nope')).status).toBe(404);
    expect((await post('/api/templates/take?deck=target&id=../x')).status).toBe(400);

    // A new deck can start wearing it.
    const created = await post('/api/decks?name=fresh&template=looped-talk');
    expect(created.body).toEqual({ id: 'fresh' });
    expect(await readFile(join(rootDir, 'fresh', 'theme.css'), 'utf8')).toContain('.live');
    expect(existsSync(join(rootDir, 'fresh', 'assets', 'ground.png'))).toBe(true);
    const fresh = parseDeck(JSON.parse(await readFile(join(rootDir, 'fresh', 'deck.json'), 'utf8')));
    expect(fresh.title).toBe('fresh');
    expect(fresh.recentColors).toEqual(['#123456']);
    expect((await post('/api/decks?name=other&template=missing')).status).toBe(404);
    expect(existsSync(join(rootDir, 'other'))).toBe(false);

    expect((await api('/api/templates?id=looped-talk', { method: 'DELETE' })).status).toBe(200);
    expect((await api('/api/templates')).body).toEqual([]);
  });

  it('offers no templates in a hosted session', async () => {
    await seedDeck('shared', 'Shared');
    await start({ hostedDeckId: 'shared' });
    expect((await api('/api/config')).body.templates).toBeNull();
    expect((await api('/api/templates')).status).toBe(403);
    expect((await post('/api/templates?deck=shared&name=X')).status).toBe(403);
    expect((await post('/api/templates/take?deck=shared&id=x')).status).toBe(403);
    expect((await api('/api/templates?id=x', { method: 'DELETE' })).status).toBe(403);
    expect(existsSync(join(templatesDir, 'x'))).toBe(false);
  });

  it('with --access, lets editors save and take but only the admin replace or delete', async () => {
    await seedDeck('alices', 'Alice deck', { owner: ALICE, visibility: 'public', publicRole: 'view', sharedWith: [] });
    await start({ access: true });

    expect((await api('/api/config', { headers: asUser(ALICE) })).body.templates).toEqual({ canManage: false });
    expect((await api('/api/config')).body.templates).toEqual({ canManage: true });

    // A viewer can list the library but neither save from nor apply to the deck.
    expect((await api('/api/templates', { headers: asUser(BOB) })).status).toBe(200);
    expect((await post('/api/templates?deck=alices&name=Mine', asUser(BOB))).status).toBe(403);

    expect((await post('/api/templates?deck=alices&name=Mine', asUser(ALICE))).body.status).toBe('saved');
    expect((await post('/api/templates/take?deck=alices&id=mine', asUser(BOB))).status).toBe(403);
    expect((await post('/api/templates/take?deck=alices&id=mine', asUser(ALICE))).status).toBe(200);
    expect((await post('/api/templates?deck=alices&name=Mine', asUser(ALICE))).body.status).toBe('exists');
    expect((await post('/api/templates?deck=alices&name=Mine&replace=1', asUser(ALICE))).status).toBe(403);
    expect((await api('/api/templates?id=mine', { method: 'DELETE', headers: asUser(ALICE) })).status).toBe(403);
    expect(existsSync(join(templatesDir, 'mine', 'template.json'))).toBe(true);

    // The admin (bare loopback) manages the library.
    expect((await post('/api/templates?deck=alices&name=Mine&replace=1')).body.status).toBe('saved');
    expect((await api('/api/templates?id=mine', { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(templatesDir, 'mine'))).toBe(false);
  });
});
