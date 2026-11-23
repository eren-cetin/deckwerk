/**
 * A collab session moving its deck folder while it stays live (a rename with
 * people in the room). Edits keep applying in memory during the move; every
 * write must land in the folder that exists afterwards — never in the old
 * one, which `saveDeck` would quietly recreate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';

/** Lets a test hold a deck save half-way, as a slow disk would. */
const saveHold = vi.hoisted(() => ({ next: null as Promise<void> | null, started: 0 }));

vi.mock('../src/main/deckStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/deckStore.js')>();
  return {
    ...actual,
    saveDeck: async (dir: string, deck: Parameters<typeof actual.saveDeck>[1]) => {
      saveHold.started += 1;
      const hold = saveHold.next;
      saveHold.next = null;
      if (hold) await hold;
      return actual.saveDeck(dir, deck);
    },
  };
});

const { saveDeck } = await import('../src/main/deckStore.js');
const { CollabSession } = await import('../src/server/collabSession.js');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const title = async (dir: string) => JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')).title as string;

describe('CollabSession.relocate', () => {
  let root: string;
  let from: string;
  let to: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'collab-session-'));
    from = join(root, 'talk');
    to = join(root, 'Big Talk');
    await saveDeck(from, parseDeck({ ...emptyDeck('talk'), slides: [{ id: 's1', name: 'One' }] }));
    await writeFile(join(from, 'theme.css'), '/* t */\n', 'utf8');
    saveHold.next = null;
    saveHold.started = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes an edit made during the move to the new folder and never recreates the old one', async () => {
    const session = await CollabSession.open(from);
    session.watch({ onExternalDeck: () => {}, onExternalTheme: () => {} });
    session.applyOps([{ op: 'updateDeck', title: 'before the move' }]);
    await session.relocate(to, async (a, b) => {
      await rename(a, b);
      // Mid-move — the folder has gone but the session has not switched to
      // its new path yet: a peer's edit arrives, and its debounced save comes
      // due before the move finishes.
      session.applyOps([{ op: 'updateDeck', title: 'during the move' }]);
      session.saveThemeCss('/* during */\n');
      await delay(1000);
      expect(existsSync(a)).toBe(false);
    });
    expect(session.dir).toBe(to);
    await session.flush();
    expect(await title(to)).toBe('during the move');
    expect(await readFile(join(to, 'theme.css'), 'utf8')).toBe('/* during */\n');
    expect(existsSync(from)).toBe(false);
    session.applyOps([{ op: 'updateDeck', title: 'after the move' }]);
    await session.close();
    expect(await title(to)).toBe('after the move');
    expect(existsSync(from)).toBe(false);
  });

  it('lets a save that is already running finish in the old folder before moving it', async () => {
    const session = await CollabSession.open(from);
    session.applyOps([{ op: 'updateDeck', title: 'saved while moving' }]);
    let releaseSave!: () => void;
    saveHold.next = new Promise<void>((resolve) => { releaseSave = resolve; });
    // Start the save now and hold it half-way, as a slow disk would.
    const flushing = session.flush();
    expect(saveHold.started).toBe(1);
    let moved = false;
    const relocating = session.relocate(to, async (a, b) => {
      moved = true;
      await rename(a, b);
    });
    await delay(50);
    expect(moved).toBe(false);
    releaseSave();
    await Promise.all([flushing, relocating]);
    expect(moved).toBe(true);
    expect(await title(to)).toBe('saved while moving');
    expect(existsSync(from)).toBe(false);
    await session.close();
  });

  it('watches the new folder for external edits once it has moved', async () => {
    const session = await CollabSession.open(from);
    const seen: string[] = [];
    session.watch({ onExternalDeck: (deck) => seen.push(deck.title), onExternalTheme: () => {} });
    await session.relocate(to, (a, b) => rename(a, b));
    await delay(100);
    const deck = JSON.parse(await readFile(join(to, 'deck.json'), 'utf8'));
    await writeFile(join(to, 'deck.json'), JSON.stringify({ ...deck, title: 'edited by hand' }, null, 2), 'utf8');
    await vi.waitFor(() => expect(seen).toEqual(['edited by hand']), { timeout: 3000 });
    await session.close();
  });

  it('stays at the old folder when the move fails', async () => {
    const session = await CollabSession.open(from);
    await expect(session.relocate(to, async () => {
      throw new Error('disk said no');
    })).rejects.toThrow('disk said no');
    expect(session.dir).toBe(from);
    session.applyOps([{ op: 'updateDeck', title: 'still here' }]);
    await session.close();
    expect(await title(from)).toBe('still here');
    expect(existsSync(to)).toBe(false);
  });
});
