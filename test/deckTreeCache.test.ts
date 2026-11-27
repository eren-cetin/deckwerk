/**
 * The cached shape of the decks root: what counts as a deck or a folder, and
 * the two ways the cache stays honest — changes made behind its back are
 * picked up by the walk every read starts, and a slow walk never holds a
 * read hostage once there is a previous answer to give.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeckTreeCache, type DeckTreeNode } from '../src/server/deckTreeCache.js';

const flatten = (nodes: DeckTreeNode[]): string[] => nodes.flatMap((node) => [
  `${node.isDeck ? 'deck' : 'folder'}:${node.id}`,
  ...flatten(node.children),
]).sort();

describe('deck tree cache', () => {
  let rootDir: string;

  const seedDeck = async (id: string) => {
    await mkdir(join(rootDir, id, 'assets'), { recursive: true });
    await writeFile(join(rootDir, id, 'deck.json'), '{}', 'utf8');
  };

  const cacheOf = (overrides: Partial<ConstructorParameters<typeof DeckTreeCache>[0]> = {}) => new DeckTreeCache({
    rootDir,
    maxDepth: 8,
    descend: (id) => !id.split('/').some((segment) => segment.startsWith('.')),
    ...overrides,
  });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'deck-tree-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('tells decks from folders and never looks inside a deck', async () => {
    await seedDeck('talk');
    await seedDeck('clients/acme/pitch');
    await mkdir(join(rootDir, 'empty'));
    await writeFile(join(rootDir, 'notes.txt'), 'not a directory', 'utf8');

    expect(flatten(await cacheOf().read())).toEqual([
      'deck:clients/acme/pitch',
      'deck:talk',
      'folder:clients',
      'folder:clients/acme',
      'folder:empty',
    ]);
  });

  it('finds a deck it may not walk as a folder, but nothing below one', async () => {
    await seedDeck('.hidden');
    await seedDeck('.stash/inner');
    await seedDeck('a/b/deep');

    expect(flatten(await cacheOf({ maxDepth: 1 }).read())).toEqual(['deck:.hidden', 'folder:a']);
  });

  it('picks up a change made behind its back on the next read', async () => {
    await seedDeck('one');
    const cache = cacheOf();
    expect(flatten(await cache.read())).toEqual(['deck:one']);

    await seedDeck('filed/two');
    await rm(join(rootDir, 'one'), { recursive: true });
    expect(flatten(await cache.read())).toEqual(['deck:filed/two', 'folder:filed']);
  });

  it('answers from the last walk when a new one is slow, and waits when invalidated', async () => {
    await seedDeck('one');
    let release: (() => void) | null = null;
    let held: Promise<void> | null = null;
    const cache = cacheOf({ graceMs: 20 });
    expect(flatten(await cache.read())).toEqual(['deck:one']);

    // A root that takes "forever" to list: swap in a walk that cannot finish.
    const slow = cache as unknown as { walkFolder: (...args: unknown[]) => Promise<DeckTreeNode[]> };
    const realWalk = slow.walkFolder.bind(cache);
    slow.walkFolder = async (...args) => {
      await held;
      return realWalk(...args);
    };
    held = new Promise<void>((resolve) => { release = resolve; });
    await seedDeck('two');

    expect(flatten(await cache.read())).toEqual(['deck:one']);

    // The server's own change must not be answered from the old shape.
    cache.invalidate();
    let settled = false;
    const fresh = cache.read().then((tree) => {
      settled = true;
      return tree;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);

    release!();
    expect(flatten(await fresh)).toEqual(['deck:one', 'deck:two']);
  });
});
