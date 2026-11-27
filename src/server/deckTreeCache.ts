/**
 * The shape of the decks root — which directories are decks, which are
 * folders — remembered between listings.
 *
 * Listing decks used to walk the whole root on every request. That is free on
 * a local disk and ruinous on a network mount (rclone, NFS, sshfs), where
 * every directory is a round-trip: a root with a thousand folders took over a
 * minute to list, and the synchronous `deck.json` probes froze the server
 * while it did.
 *
 * Only the shape is cached. Titles, slide counts, edit times and permissions
 * are still read per request from the handful of decks the shape names, so
 * they are never stale.
 *
 * Freshness comes from two directions:
 *  - the server's own structural changes (new deck, move, rename, folder
 *    edits) call `invalidate()`, and the next read waits for a fresh walk;
 *  - changes made behind the server's back (another machine syncing into the
 *    mount, a person in a terminal) are picked up because every read starts
 *    a new walk. The read waits briefly for it, which on a local disk is
 *    always long enough to answer fresh, and otherwise answers from the last
 *    walk while the new one finishes in the background.
 */
import type { Dirent } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** One directory under the root: a deck, or a folder and what it holds. */
export interface DeckTreeNode {
  /** Path below the root, "/"-separated. */
  id: string;
  name: string;
  isDeck: boolean;
  /** Always empty for a deck: its subdirectories are part of the deck. */
  children: DeckTreeNode[];
}

export interface DeckTreeCacheOptions {
  rootDir: string;
  /** How many levels of folders to walk below the root; 0 walks none. */
  maxDepth: number;
  /** Whether a directory id may be walked as a folder. Decks are found either way. */
  descend: (id: string) => boolean;
  /**
   * How long a read waits for the walk it started before answering from the
   * previous one. Defaults to 300 ms.
   */
  graceMs?: number;
  /** Directory reads in flight at once. Defaults to 16. */
  concurrency?: number;
}

const DECK_FILE = 'deck.json';

type Limit = <T>(task: () => Promise<T>) => Promise<T>;

/** Cap concurrent tasks; a finishing task hands its slot to the next waiter. */
function createLimit(max: number): Limit {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }

    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export class DeckTreeCache {
  private readonly rootDir: string;
  private readonly maxDepth: number;
  private readonly descend: (id: string) => boolean;
  private readonly graceMs: number;
  private readonly concurrency: number;

  private tree: DeckTreeNode[] | null = null;
  /** Bumped by every structural change the server makes itself. */
  private generation = 0;
  /** The generation the cached tree was walked under. */
  private treeGeneration = -1;
  private inFlight: { generation: number; walk: Promise<DeckTreeNode[]> } | null = null;

  constructor(options: DeckTreeCacheOptions) {
    this.rootDir = options.rootDir;
    this.maxDepth = options.maxDepth;
    this.descend = options.descend;
    this.graceMs = options.graceMs ?? 300;
    this.concurrency = options.concurrency ?? 16;
  }

  /** Mark the cached shape as wrong: the next read waits for a fresh walk. */
  invalidate(): void {
    this.generation += 1;
  }

  /**
   * The directories directly under the root, each with its subtree.
   *
   * Callers must not mutate the result; it is shared between reads.
   */
  async read(): Promise<DeckTreeNode[]> {
    const walk = this.refresh();
    const cached = this.tree;
    if (!cached || this.treeGeneration !== this.generation) return walk;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const fallback = new Promise<DeckTreeNode[]>((resolve) => {
      timer = setTimeout(() => resolve(cached), this.graceMs);
    });
    try {
      // A failed walk is not this read's problem: it still has the last one.
      return await Promise.race([walk.catch(() => cached), fallback]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start a walk, or join the one already running for this generation. */
  private refresh(): Promise<DeckTreeNode[]> {
    if (this.inFlight && this.inFlight.generation === this.generation) return this.inFlight.walk;

    const generation = this.generation;
    const limit = createLimit(this.concurrency);
    const walk = this.walkFolder('', 0, limit).then((tree) => {
      // A slow walk can finish after a newer one; never step backwards.
      if (generation >= this.treeGeneration) {
        this.tree = tree;
        this.treeGeneration = generation;
      }

      return tree;
    }).finally(() => {
      if (this.inFlight?.walk === walk) this.inFlight = null;
    });
    // A walk nobody is waiting on any more must not become an unhandled rejection.
    walk.catch(() => undefined);
    this.inFlight = { generation, walk };
    return walk;
  }

  private async walkFolder(relative: string, depth: number, limit: Limit): Promise<DeckTreeNode[]> {
    const dir = relative ? join(this.rootDir, relative) : this.rootDir;
    let entries;
    try {
      entries = await limit(() => readdir(dir, { withFileTypes: true }));
    } catch {
      return [];
    }

    return this.expand(relative, entries, depth, limit);
  }

  /** Turn one directory's entries into nodes, walking each folder among them. */
  private async expand(
    relative: string,
    entries: Dirent[],
    depth: number,
    limit: Limit,
  ): Promise<DeckTreeNode[]> {
    const nodes = await Promise.all(entries.map(async (entry): Promise<DeckTreeNode | null> => {
      if (!entry.isDirectory()) return null;
      const id = relative ? `${relative}/${entry.name}` : entry.name;
      const dir = join(this.rootDir, id);
      if (depth + 1 > this.maxDepth || !this.descend(id)) {
        // Not walkable as a folder, but a deck here is still a deck.
        const isDeck = await limit(() => access(join(dir, DECK_FILE)).then(() => true, () => false));
        return isDeck ? { id, name: entry.name, isDeck: true, children: [] } : null;
      }

      // One directory read answers both "is this a deck" and "what is
      // inside", where probing for deck.json first would cost a second
      // round-trip.
      let inside: Dirent[];
      try {
        inside = await limit(() => readdir(dir, { withFileTypes: true }));
      } catch {
        return { id, name: entry.name, isDeck: false, children: [] };
      }

      if (inside.some((child) => child.name === DECK_FILE)) {
        return { id, name: entry.name, isDeck: true, children: [] };
      }

      const children = await this.expand(id, inside, depth + 1, limit);
      return { id, name: entry.name, isDeck: false, children };
    }));
    return nodes.filter((node): node is DeckTreeNode => node !== null);
  }
}
