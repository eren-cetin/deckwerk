import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import {
  FAR,
  IMAGE,
  LIST,
  MOD,
  PARA,
  SHIFT,
  elementSelector,
  startCrossSession,
  type CrossSession,
  type CrossState,
} from './support/crossContextSession.js';

/**
 * Cross-context fuzz: a seeded random walk over a slide holding THREE
 * different elements — a paragraph textbox, a list textbox and an image —
 * plus a second slide, all driven by real input. The existing fuzzers each
 * work a single textbox, so every fault that needs two editing contexts, an
 * element selection, or a slide switch is outside their state space. This
 * walk's vocabulary is exactly those moves: clicking the other textbox
 * mid-typing, Escape and empty-canvas clicks mid-edit, shift-click
 * multi-select, marquee drags, rail hops mid-edit, double-clicking the image,
 * Cmd+B mid-word, undo/redo at random points, Backspace with an element
 * selection, and Cmd+A in both contexts.
 *
 * After EVERY step five oracles run: the whole-editor invariant set from
 * selectionSession, keystroke routing via per-step nonce strings, an element
 * census, an undo/redo round-trip check, and a page-error trap.
 *
 * Two bugs are already known and must not drown the walk:
 *  - clicking an already-selected box inside a multi-selection enters edit
 *    mode without narrowing the selection ("editing X while the selection is
 *    [X, …]") — counted, not reported;
 *  - formatting+typing coalescing into one undo entry — the round-trip oracle
 *    is deliberately insensitive to undo granularity, so it cannot re-fire.
 *
 * `CROSS_FUZZ_SEEDS`, `CROSS_FUZZ_STEPS` and `CROSS_FUZZ_TRACE=1` are the
 * knobs a failure needs.
 */
const DECK_ID = 'cross-context-fuzz';
const SEEDS = Number.parseInt(process.env.CROSS_FUZZ_SEEDS ?? '', 10) || 8;
const STEPS = Number.parseInt(process.env.CROSS_FUZZ_STEPS ?? '', 10) || 15;
const TRACE = process.env.CROSS_FUZZ_TRACE === '1';

let session: CrossSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startCrossSession(DECK_ID, 'Cross Context Fuzz');
  session = started.session;
  close = started.close;
}, 180_000);

afterAll(async () => {
  await close?.();
  close = null;
});

/** A small, reproducible pseudo-random source. */
function random(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

const pick = <T,>(next: () => number, list: T[]): T =>
  list[Math.floor(next() * list.length)];

/**
 * Typed markers must be unique across the whole run, not just within a step:
 * undo can resurrect state from an earlier seed (the walks share one editor
 * and one history), so a reused marker string would let the routing oracle
 * blame a fresh keystroke for text a previous walk legitimately typed.
 */
let tokenCounter = 0;
/** Decimal, so every marker contains a digit and cannot collide with fixture
 * words ("item two" contains "wo", which a base-36 token once produced). */
const uniqueToken = () => `${tokenCounter++}`;

/**
 * KNOWN BUG #1 (selectionStateBugs.test.ts): a click on an already-selected
 * box inside a multi-selection begins an edit without narrowing the
 * selection. Its invariant signature is "editing X while the selection is
 * [... X ...]"; the same broken state also mislabels focus/caret against the
 * multi-selection, so those two strings are carved out only while the
 * signature itself is present.
 */
function splitKnown(problems: string[]): { known: string[]; unknown: string[] } {
  const known: string[] = [];
  const unknown: string[] = [];
  const signature = problems.find((problem) => {
    const match = /^editing (\S+) while the selection is \[(.*)\]$/.exec(problem);
    if (!match) return false;
    const listed = match[2].split(',').map((id) => id.trim());
    return listed.length > 1 && listed.includes(match[1]);
  });
  for (const problem of problems) {
    if (signature && problem === signature) known.push(problem);
    else unknown.push(problem);
  }
  return { known, unknown };
}

/**
 * BUG (new, found by this fuzzer — see the directed repro below): ending a
 * text-edit session that changed nothing leaves `style="outline: none;
 * cursor: text"` on the .text-content (beginTextEdit sets them at
 * canvas.ts:2189, commitTextEdit's no-change branch never clears them), and
 * the app's own render-invariant checker reports the canvas DOM as stale at
 * the next in-place patch. Counted here so it does not drown the walk.
 */
function isKnownStaleEditChrome(error: string): boolean {
  if (!error.includes('[render-invariant]')) return false;
  if (!error.includes('div.text-content')) return false;
  const properties = [...error.matchAll(/style\.([a-z-]+)/g)].map((m) => m[1]);
  return properties.length > 0 && properties.every((property) =>
    ['outline-color', 'outline-style', 'outline-width', 'cursor'].includes(property));
}

/**
 * BUG (new, found by this fuzzer — see the directed repro below): navigating
 * between two structurally identical slides takes render()'s in-place patch
 * path, which never rewrites slide-scoped DOM (data-slide-id stays on the
 * previous slide's value). Counted here so it does not drown the walk.
 */
function isKnownStaleSlideIdentity(error: string): boolean {
  return error.includes('[render-invariant]')
    && error.includes('@data-slide-id')
    && !/style\.[a-z-]+/.test(error);
}

type OpName =
  | 'click' | 'shift-click' | 'double-click text' | 'double-click image then text'
  | 'type nonce' | 'bold mid-word' | 'escape' | 'click empty' | 'marquee'
  | 'rail hop' | 'rail drag' | 'find next' | 'shift drag' | 'page numbers' | 'theme apply' | 'grid toggle' | 'undo' | 'redo' | 'undo round-trip' | 'delete selection'
  | 'cmd+a' | 'group toggle' | 'panel toggle' | 'view menu' | 'section fold' | 'path menu' | 'arrow slide' | 'list indent' | 'text case' | 'image caption'
  | 'copy as image';

interface Violation { seed: number; step: number; op: OpName; oracle: string; detail: string }

interface OracleStats {
  invariants: number;
  routing: number;
  census: number;
  undoRoundTrip: number;
  pageErrors: number;
  knownMultiSelectEdit: number;
  knownStaleEditChrome: number;
  knownStaleSlideIdentity: number;
}

describe.skipIf(!electronBinary)('cross-context fuzz over three elements and two slides', () => {
  it(`survives ${SEEDS} seeded walks of ${STEPS} cross-context steps`, {
    timeout: 30 * 60_000,
  }, async () => {
    const violations: Violation[] = [];
    const stats: OracleStats = {
      invariants: 0, routing: 0, census: 0, undoRoundTrip: 0, pageErrors: 0,
      knownMultiSelectEdit: 0, knownStaleEditChrome: 0, knownStaleSlideIdentity: 0,
    };
    const opCounts = new Map<OpName, number>();

    for (let seedIndex = 0; seedIndex < SEEDS; seedIndex++) {
      const seed = 90_2026 + seedIndex * 7919;
      const next = random(seed);
      await session.reset();
      await session.drainPageErrors();
      /** ids ever seen in the deck, slide-qualified — undo may resurrect any. */
      const everKnown = new Set(await session.allElementIds());
      /** what the census expects right now. */
      let expectedIds = [...everKnown];
      const steps: string[] = [];

      for (let step = 0; step < STEPS; step++) {
        const pre = await session.state();
        const op = chooseOp(next, pre);
        opCounts.set(op, (opCounts.get(op) ?? 0) + 1);
        steps.push(op);
        const label = `seed ${seed} step ${step + 1} (${op}) after [${steps.join(' → ')}]`;
        if (TRACE) console.log(label);

        const flag = (oracle: keyof OracleStats, detail: string) => {
          stats[oracle] += 1;
          violations.push({ seed, step: step + 1, op, oracle, detail: `${label}: ${detail}` });
        };

        let censusMode: 'same' | 'resync' | string[] = 'same';
        try {
          censusMode = await performOp(op, next, pre, flag);
        } catch (error) {
          flag('invariants', `the op itself failed: ${(error as Error).message}`);
          break;
        }

        // Oracle 1: the whole-editor invariant set, with the known-bug carve-out.
        const { known, unknown } = splitKnown(await session.problems());
        stats.knownMultiSelectEdit += known.length;
        if (unknown.length > 0) {
          flag('invariants', unknown.join(' | '));
          break; // a broken editor cascades; stop this seed at the first fault
        }

        // Oracle 3: element census — nothing appears or disappears except via
        // an explicit delete, and undo/redo only ever resurrect known ids.
        const ids = await session.allElementIds();
        if (new Set(ids).size !== ids.length) {
          flag('census', `duplicate element ids: [${ids.join(', ')}]`);
          break;
        }
        if (censusMode === 'resync') {
          const foreign = ids.filter((id) => !everKnown.has(id));
          if (foreign.length > 0) {
            flag('census', `undo/redo materialised never-seen elements: [${foreign.join(', ')}]`);
            break;
          }
          expectedIds = ids;
        } else {
          const expected = Array.isArray(censusMode) ? censusMode : expectedIds;
          if ([...ids].sort().join('|') !== [...expected].sort().join('|')) {
            flag('census', `elements changed: expected [${expected.join(', ')}] got [${ids.join(', ')}]`);
            break;
          }
          expectedIds = expected;
        }
        for (const id of ids) everKnown.add(id);

        // Oracle 5: nothing on the page blew up.
        const errors = await session.drainPageErrors();
        stats.knownStaleEditChrome += errors.filter(isKnownStaleEditChrome).length;
        stats.knownStaleSlideIdentity += errors.filter(isKnownStaleSlideIdentity).length;
        const realErrors = errors.filter((error) =>
          !isKnownStaleEditChrome(error) && !isKnownStaleSlideIdentity(error));
        if (realErrors.length > 0) {
          flag('pageErrors', realErrors.join(' | '));
          break;
        }
      }
    }

    console.log('cross-context fuzz stats:', JSON.stringify({
      seeds: SEEDS,
      steps: STEPS,
      ops: Object.fromEntries(opCounts),
      oracleFirings: stats,
    }, null, 2));

    expect(
      violations,
      violations.map((v) => `[${v.oracle}] ${v.detail}`).join('\n\n'),
    ).toEqual([]);
  });
});

describe.skipIf(!electronBinary)('directed repros minimised from the fuzz walk', () => {
  // BUG (new): ending a text-edit session that changed nothing leaves the
  // edit-session inline styles (`outline: none; cursor: text`) on the
  // .text-content. beginTextEdit writes them (canvas.ts:2189-2190);
  // commitTextEdit removes contenteditable and the .editing class but never
  // these styles, and its no-change branch does not re-render either, so
  // after the session the box permanently shows a text cursor on hover and
  // the app's own render-invariant checker reports "canvas DOM is stale
  // after an in-place patch" at the next patch (here: nudging the box with an
  // arrow key; in the fuzz walk it was an undo). Expected: leaving an
  // unchanged edit restores the node exactly and no render-invariant error
  // fires. Observed: the stale styles persist and the checker fires.
  // Minimised from fuzz seed 941621 step 2 (double-click text → undo).
  it('leaves no stale edit styling after an unchanged edit session', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.drainPageErrors();
    // A real history entry, so the later undo produces an in-place patch.
    await session.click(PARA);
    await session.key('ArrowRight', 39);
    await wait(200);
    await session.doubleClick(PARA); // enter edit
    await session.key('Escape', 27); // leave without changing anything
    const residue = await session.cdp.evaluate<string>(`(() => {
      const body = document.querySelector('${elementSelector(PARA)} .text-content');
      return body ? body.getAttribute('style') ?? '' : '(missing)';
    })()`);
    // Undoing the move patches the slide in place, which runs the app's own
    // staleness check while nothing is being edited.
    await session.clickEmpty();
    await session.chord('z', 'KeyZ', 90, MOD);
    await wait(300);

    const errors = await session.drainPageErrors();
    expect(
      errors,
      `stale edit chrome after an unchanged edit (inline style left behind: "${residue}")`,
    ).toEqual([]);
  });
});

describe.skipIf(!electronBinary)('directed repro: stale slide identity across a rail hop', () => {
  // BUG (new): navigating between two slides whose element lists are
  // structurally identical (here: both emptied by Cmd+A + Backspace) takes
  // the in-place patch path — render() checks sameStructure(renderedSlide,
  // slide) (canvas.ts:529) BEFORE it checks whether the slide index changed,
  // and sameStructure (canvas.ts:4486) compares only the elements, never the
  // slide's own identity or background. The canvas therefore keeps showing
  // the previous slide's DOM: data-slide-id stays stale (the app's own
  // render-invariant checker reports 'canvas has "slide-1", a fresh render
  // gives "slide-2"'), and anything else keyed off the slide node — e.g. a
  // different slide background — would keep the old slide's paint. Expected:
  // a rail hop always shows the target slide's DOM identity. Observed: the
  // slide node still carries the previous slide's data-slide-id. Minimised
  // from fuzz seed 989135 step 16.
  it('shows the target slide identity after hopping between identical slides', {
    timeout: 120_000,
  }, async () => {
    await session.reset();
    await session.drainPageErrors();
    // Empty slide 1 with real input: select every object, delete them.
    await session.chord('a', 'KeyA', 65, MOD);
    await session.key('Backspace', 8);
    // Empty slide 2 the same way. The rail keeps keyboard focus after a rail
    // click, so click the canvas first — otherwise Cmd+A selects slides.
    await session.clickRail(1);
    await session.clickEmpty();
    await session.chord('a', 'KeyA', 65, MOD);
    await session.key('Backspace', 8);
    await session.drainPageErrors();
    // Hop back: two structurally identical (empty) slides.
    await session.clickRail(0);
    await wait(300);

    const identity = await session.cdp.evaluate<{ dom: string; model: string }>(`(() => {
      const state = window.store.get();
      return {
        dom: document.querySelector('.slide-layer .slide')?.getAttribute('data-slide-id')
          ?? '(none)',
        model: state.deck.slides[state.slideIndex]?.id ?? '(none)',
      };
    })()`);
    const errors = (await session.drainPageErrors())
      .filter((error) => !isKnownStaleEditChrome(error));
    expect(
      identity.dom,
      `the canvas still shows ${identity.dom} after navigating to ${identity.model}`
      + (errors.length > 0 ? ` (page errors: ${errors.join(' | ')})` : ''),
    ).toBe(identity.model);
    expect(errors, 'no staleness reported by the render-invariant checker').toEqual([]);
  });
});

describe.skipIf(electronBinary)('cross-context fuzz (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});

/** The elements an op can aim at on the current slide, live. */
function targetsOn(pre: CrossState): string[] {
  const known = [PARA, LIST, IMAGE, FAR];
  return pre.elements.filter((id) => known.includes(id));
}

function chooseOp(next: () => number, pre: CrossState): OpName {
  const targets = targetsOn(pre);
  const ops: OpName[] = [];
  const add = (op: OpName, weight: number) => {
    for (let i = 0; i < weight; i++) ops.push(op);
  };
  if (targets.length > 0) {
    add('click', 3);
    add('shift-click', 2);
    if (targets.some((id) => id !== IMAGE)) add('double-click text', 3);
  }
  if (pre.slideIndex === 0 && pre.elements.includes(IMAGE)
    && pre.elements.some((id) => id === PARA || id === LIST)) {
    add('double-click image then text', 1);
  }
  if (pre.editing !== null) {
    add('type nonce', 3);
    add('bold mid-word', 2);
    add('click', 2); // click the other box mid-typing, no Escape first
  }
  add('escape', 1);
  add('click empty', 1);
  add('marquee', 1);
  add('rail hop', 2);
  if (pre.editing === null) add('rail drag', 1);
  add('find next', 1);
  if (pre.editing === null && targets.length > 0) add('shift drag', 2);
  if (pre.editing === null) add('page numbers', 1);
  if (pre.editing === null) add('theme apply', 1);
  add('grid toggle', 1);
  add('panel toggle', 1);
  add('view menu', 1);
  add('path menu', 1);
  if (pre.editing === null && pre.selection.length === 0) add('arrow slide', 2);
  if (pre.editing === null) add('section fold', 3);
  if (pre.elements.includes(LIST)) add('list indent', 1);
  if (pre.elements.includes(PARA)) add('text case', 1);
  if (pre.elements.includes(IMAGE)) add('image caption', 1);
  if (pre.editing === null && pre.selection.length > 0) add('copy as image', 1);
  add('undo', 2);
  add('redo', 1);
  add('undo round-trip', 1);
  if (pre.editing === null && pre.selection.length > 0) add('delete selection', 2);
  add('cmd+a', 1);
  if (pre.editing === null && targets.length >= 2) add('group toggle', 3);
  return pick(next, ops);
}

/**
 * Perform one op and run its op-specific oracle (keystroke routing, deletion,
 * round-trip). Returns how the census should treat the step: 'same' (no
 * element change allowed), 'resync' (undo/redo/round-trip may restore any
 * known state), or the explicit id list expected after a delete.
 */
async function performOp(
  op: OpName,
  next: () => number,
  pre: CrossState,
  flag: (oracle: 'routing' | 'undoRoundTrip' | 'census', detail: string) => void,
): Promise<'same' | 'resync' | string[]> {
  const targets = targetsOn(pre);
  switch (op) {
    case 'click':
      await session.click(pick(next, targets));
      return 'same';
    case 'shift-click':
      await session.shiftClick(pick(next, targets));
      return 'same';
    case 'double-click text':
      await session.doubleClick(pick(next, targets.filter((id) => id !== IMAGE)));
      return 'same';
    case 'double-click image then text': {
      await session.doubleClick(IMAGE);
      const boxes = targets.filter((id) => id === PARA || id === LIST);
      await session.doubleClick(pick(next, boxes));
      return 'same';
    }
    case 'type nonce': {
      const nonce = `q${uniqueToken()}z`;
      await session.type(nonce);
      await wait(120);
      await checkRouting(pre, nonce, flag);
      return 'same';
    }
    case 'bold mid-word': {
      const head = `w${uniqueToken()}`;
      const tail = `t${uniqueToken()}x`;
      await session.type(head);
      await session.chord('b', 'KeyB', 66, MOD);
      await session.type(tail);
      await wait(120);
      await checkRouting(pre, head, flag);
      await checkRouting(pre, tail, flag);
      return 'same';
    }
    case 'escape':
      await session.key('Escape', 27);
      return 'same';
    case 'click empty':
      await session.clickEmpty();
      return 'same';
    case 'marquee': {
      const layer = await session.boxOf('.slide-layer');
      const sweepTo = pre.slideIndex === 0
        ? pick(next, [PARA, LIST, IMAGE].filter((id) => pre.elements.includes(id)))
        : pre.elements.includes(FAR) ? FAR : null;
      const end = sweepTo
        ? await session.boxOf(elementSelector(sweepTo))
        : { left: layer.left, top: layer.top, width: 10, height: 10 };
      await session.dragPath([
        { x: layer.left + layer.width * 0.55, y: layer.top + layer.height * 0.94 },
        { x: layer.left + layer.width * 0.4, y: layer.top + layer.height * 0.6 },
        { x: end.left + end.width / 2, y: end.top + end.height / 2 },
      ]);
      return 'same';
    }
    case 'rail hop': {
      const other = pre.slideIndex === 0 ? 1 : 0;
      await session.clickRail(other);
      if (next() < 0.6) await session.clickRail(pre.slideIndex);
      return 'same';
    }
    case 'rail drag': {
      // Two slides: dragging one past the other swaps them. Selecting both
      // first makes it a group drag, whose only targets are its own rows, so
      // nothing may move — and the group must still be selected afterwards.
      const order = async () => session.cdp.evaluate<string[]>(
        'window.store.get().deck.slides.map((slide) => slide.id)');
      const before = await order();
      const group = next() < 0.35;
      if (group) {
        await session.clickRail(0);
        await session.cdp.clickModified('.rail-item[data-index="1"]', SHIFT, 'shift-click rail slide 1');
        await wait(150);
        await session.dragRail(0, 1, 'after');
      } else if (next() < 0.5) {
        // A lone slide: an earlier Cmd+A in the rail may have left both
        // selected, which would make this a group drag.
        await session.clickRail(0);
        await session.dragRail(0, 1, 'after');
      } else {
        await session.clickRail(1);
        await session.dragRail(1, 0, 'before');
      }
      const after = await order();
      const expected = group ? before : [...before].reverse();
      if (after.join('|') !== expected.join('|')) {
        flag('census', `rail drag left slides [${after.join(', ')}], expected [${expected.join(', ')}]`);
      }
      if (group) {
        const selected = await session.cdp.evaluate<number>('window.store.get().slideSelection.size');
        if (selected !== 2) flag('census', `group drag dropped the selection to ${selected} slide(s)`);
      }
      return 'same';
    }
    case 'find next': {
      // Cmd/Ctrl+F from wherever focus is (mid-edit included), a word that is
      // on the slide, Enter, Escape. The query must never reach the slide's
      // text, the bar must land on a highlighted match, and Escape must close.
      // innerText keeps the line breaks between paragraphs that allTexts
      // collapses, so every candidate is a word a person could see and type.
      const shown = await session.cdp.evaluate<string>(`[...document.querySelectorAll('.slide-layer .text-content')]
        .map((node) => node.innerText).join('\\n')`);
      const words = shown.match(/[A-Za-z]{4,}/g) ?? [];
      if (words.length === 0) return 'same';
      const word = pick(next, words);
      await session.chord('f', 'KeyF', 70, MOD);
      await wait(80);
      // Opening find ends a live text edit, which commits it; the texts are
      // read after that so the oracle sees only what the query typing did.
      const texts = await session.allTexts();
      await session.type(word);
      await session.key('Enter', 13);
      await wait(200);
      const found = await session.cdp.evaluate<{ open: boolean; count: string; painted: number }>(`(() => ({
        open: !document.querySelector('.find-bar')?.hidden,
        count: document.querySelector('.find-count')?.textContent ?? '',
        painted: CSS.highlights.get('deck-find-current')?.size ?? 0,
      }))()`);
      if (!found.open) flag('routing', 'Cmd/Ctrl+F did not open the find bar');
      else if (!/^\d+ of \d+$/.test(found.count)) flag('routing', `find "${word}" reported "${found.count}"`);
      else if (found.painted !== 1) flag('routing', `find "${word}" highlighted ${found.painted} current matches`);
      const after = await session.allTexts();
      for (const [id, text] of Object.entries(after)) {
        if (texts[id] !== undefined && texts[id] !== text) {
          flag('routing', `typing the find query changed ${id}: "${texts[id]}" -> "${text}"`);
        }
      }
      await session.key('Escape', 27);
      const closed = await session.cdp.evaluate<boolean>(`Boolean(document.querySelector('.find-bar')?.hidden)`);
      if (!closed) flag('routing', 'Escape did not close the find bar');
      return 'same';
    }
    case 'shift drag': {
      // A real Shift-held drag of an object along a wobbly path. Whatever
      // moved must have moved as one rigid group along an exact horizontal,
      // vertical or 45° line, however near a snap guide it passed.
      const positions = () => session.cdp.evaluate<Record<string, { x: number; y: number }>>(`(() => {
        const out = {};
        for (const el of window.store.slide.elements) out[el.id] = { x: el.x, y: el.y };
        return out;
      })()`);
      const before = await positions();
      const box = await session.boxOf(elementSelector(pick(next, targets)));
      const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const reach = 40 + next() * 120;
      const angle = next() * Math.PI * 2;
      const end = { x: start.x + Math.cos(angle) * reach, y: start.y + Math.sin(angle) * reach };
      await session.dragPath([
        start,
        { x: start.x + (end.x - start.x) * 0.4 + 6, y: start.y + (end.y - start.y) * 0.4 - 5 },
        { x: start.x + (end.x - start.x) * 0.8 - 4, y: start.y + (end.y - start.y) * 0.8 + 7 },
        end,
      ], SHIFT);
      const after = await positions();
      const moves = Object.keys(after)
        .filter((id) => before[id])
        .map((id) => ({ id, dx: after[id].x - before[id].x, dy: after[id].y - before[id].y }))
        .filter((move) => move.dx !== 0 || move.dy !== 0);
      for (const move of moves) {
        const exact = move.dx === 0 || move.dy === 0 || Math.abs(move.dx) === Math.abs(move.dy);
        if (!exact) flag('census', `Shift-drag moved ${move.id} by (${move.dx}, ${move.dy}), off every 45° line`);
        if (move.dx !== moves[0].dx || move.dy !== moves[0].dy) {
          flag('census', `Shift-drag moved ${move.id} by (${move.dx}, ${move.dy}) but ${moves[0].id} by (${moves[0].dx}, ${moves[0].dy})`);
        }
      }
      // Undo the drag with a real Cmd/Ctrl+Z: one step must put everything
      // back exactly, and objects never pile up on each other across steps
      // (a later click on a covered box is refused by the click helper).
      if (moves.length > 0) {
        await session.chord('z', 'KeyZ', 90, MOD);
        await wait(200);
        const restored = await positions();
        for (const id of Object.keys(before)) {
          if (restored[id] && (restored[id].x !== before[id].x || restored[id].y !== before[id].y)) {
            flag('undoRoundTrip', `undoing the Shift-drag left ${id} at (${restored[id].x}, ${restored[id].y}), not (${before[id].x}, ${before[id].y})`);
          }
        }
      }
      return 'same';
    }
    case 'page numbers': {
      // The Design tab's real checkbox, then straight back to Props: the
      // canvas must show the current slide's number exactly while numbering
      // is on, outside the slide layer the render invariant compares.
      await session.cdp.click('#side-tabs button[data-panel="themePanel"]', 'Design tab');
      await wait(120);
      await session.cdp.click('.page-numbers-section .field-check input', 'Show page numbers');
      await wait(120);
      await session.cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
      await wait(150);
      const shown = await session.cdp.evaluate<{ on: boolean; label: string | null; index: number; inLayer: boolean }>(`(() => ({
        on: Boolean(window.store.get().deck.pageNumbers),
        label: document.querySelector('#canvas .stage > .page-number')?.textContent ?? null,
        index: window.store.get().slideIndex,
        inLayer: Boolean(document.querySelector('#canvas .slide-layer .page-number')),
      }))()`);
      const expected = shown.on ? String(shown.index + 1) : null;
      if (shown.label !== expected) {
        flag('routing', `page numbers ${shown.on ? 'on' : 'off'} on slide ${shown.index + 1} showed ${JSON.stringify(shown.label)}`);
      }
      if (shown.inLayer) flag('routing', 'the page number landed inside the slide layer');
      return 'same';
    }
    case 'grid toggle': {
      // Cmd/Ctrl+' from wherever focus is, mid-edit included: the grid flips
      // and nothing about the slide or the text being edited changes.
      const gridShown = () => session.cdp.evaluate<boolean>(
        `Boolean(document.querySelector('#canvas .stage > .canvas-grid'))`);
      const before = await gridShown();
      const texts = await session.allTexts();
      await session.chord("'", 'Quote', 222, MOD);
      await wait(80);
      if ((await gridShown()) === before) flag('routing', 'Cmd/Ctrl+\' did not toggle the grid');
      const after = await session.allTexts();
      for (const [id, text] of Object.entries(after)) {
        if (texts[id] !== undefined && texts[id] !== text) {
          flag('routing', `toggling the grid changed ${id}: "${texts[id]}" -> "${text}"`);
        }
      }
      return 'same';
    }
    case 'view menu': {
      // View › Show Grid from the toolbar, wherever focus is: the checkmark
      // tells the truth before and after, and no word on the slide changes.
      const gridShown = () => session.cdp.evaluate<boolean>(
        `Boolean(document.querySelector('#canvas .stage > .canvas-grid'))`);
      const reachable = await session.cdp.evaluate<boolean>(`(() => {
        const trigger = [...document.querySelectorAll('.toolbar-expanded-secondary-actions .shape-menu-trigger')]
          .find((button) => button.textContent.trim() === 'View');
        return Boolean(trigger) && trigger.getClientRects().length > 0;
      })()`);
      if (!reachable) return 'same';
      const before = await gridShown();
      const texts = await session.allTexts();
      const openItem = async () => {
        await session.cdp.evaluate(`([...document.querySelectorAll('.toolbar-expanded-secondary-actions .shape-menu-trigger')]
          .find((button) => button.textContent.trim() === 'View').click(), true)`);
        await wait(80);
        return session.cdp.evaluate<string | null>(`[...document.querySelectorAll('.shape-menu [role=menuitemcheckbox]')]
          .find((row) => row.textContent.includes('Show Grid'))?.getAttribute('aria-checked') ?? null`);
      };
      const checked = await openItem();
      if (checked !== String(before)) flag('routing', `View › Show Grid read ${checked} with the grid ${before ? 'shown' : 'hidden'}`);
      await session.cdp.evaluate(`([...document.querySelectorAll('.shape-menu [role=menuitemcheckbox]')]
        .find((row) => row.textContent.includes('Show Grid'))?.click(), true)`);
      await wait(80);
      if ((await gridShown()) === before) flag('routing', 'View › Show Grid did not toggle the grid');
      const after = await openItem();
      if (after !== String(!before)) flag('routing', `View › Show Grid read ${after} after toggling`);
      // Close it the way it opened; Escape would also end a text edit.
      await session.cdp.evaluate(`([...document.querySelectorAll('.toolbar-expanded-secondary-actions .shape-menu-trigger')]
        .find((button) => button.textContent.trim() === 'View').click(), true)`);
      await wait(80);
      if (await session.cdp.evaluate<boolean>(`Boolean(document.querySelector('.shape-menu [role=menuitemcheckbox]'))`)) {
        flag('routing', 'the View menu stayed open');
      }
      const textsAfter = await session.allTexts();
      for (const [id, text] of Object.entries(textsAfter)) {
        if (texts[id] !== undefined && texts[id] !== text) {
          flag('routing', `View › Show Grid changed ${id}: "${texts[id]}" -> "${text}"`);
        }
      }
      return 'same';
    }
    case 'section fold': {
      // With no section yet, + Section starts one at the current slide and
      // Escape keeps its default name; otherwise a section folds and unfolds.
      // Either way no slide and no word changes.
      const texts = await session.allTexts();
      const slides = () => session.cdp.evaluate<number>(`document.querySelectorAll('#rail .rail-item').length`);
      const hasSection = await session.cdp.evaluate<boolean>(`Boolean(document.querySelector('#rail .rail-section'))`);
      if (!hasSection) {
        await session.cdp.evaluate(`(() => {
          [...document.querySelectorAll('#rail .rail-actions button')].find((b) => b.textContent === '+ Section').click();
          return true;
        })()`);
        await wait(120);
        await session.key('Escape', 27);
        await wait(80);
        if (!(await session.cdp.evaluate<boolean>(`Boolean(document.querySelector('#rail .rail-section'))`))) {
          flag('routing', '+ Section did not start a section');
        }
      } else {
        const before = await slides();
        for (let fold = 0; fold < 2; fold++) {
          await session.cdp.evaluate(`(() => { document.querySelector('#rail .rail-section-toggle').click(); return true; })()`);
          await wait(80);
        }
        if ((await slides()) !== before) flag('routing', 'folding and unfolding a section lost rail rows');
      }
      const after = await session.allTexts();
      for (const [id, text] of Object.entries(after)) {
        if (texts[id] !== undefined && texts[id] !== text) flag('routing', `a section action changed ${id}'s text`);
      }
      return 'same';
    }
    case 'arrow slide': {
      // Nothing selected: Right/Left page to the next or previous visible
      // slide, or stay put at an end, unless a field has the keyboard.
      const forward = next() < 0.5;
      const expected = await session.cdp.evaluate<number | null>(`(() => {
        const target = document.activeElement;
        if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return null;
        const { deck, slideIndex } = window.store.get();
        let at = slideIndex + ${forward ? 1 : -1};
        while (at >= 0 && at < deck.slides.length && deck.slides[at].skipped) at += ${forward ? 1 : -1};
        return at < 0 || at >= deck.slides.length ? slideIndex : at;
      })()`);
      const texts = await session.allTexts();
      await session.key(forward ? 'ArrowRight' : 'ArrowLeft', forward ? 39 : 37);
      await wait(100);
      if (expected !== null) {
        const now = await session.cdp.evaluate<number>('window.store.get().slideIndex');
        if (now !== expected) flag('routing', `${forward ? 'Right' : 'Left'} arrow went to slide ${now + 1}, expected ${expected + 1}`);
      }
      const after = await session.allTexts();
      for (const [id, text] of Object.entries(after)) {
        if (texts[id] !== undefined && texts[id] !== text) flag('routing', `an arrow key changed ${id}'s text`);
      }
      return 'same';
    }
    case 'path menu': {
      // The deck folder's menu opens from the toolbar wherever focus is, edits
      // included, and a press elsewhere (or Rename… then Escape) puts it away
      // with nothing changed.
      const texts = await session.allTexts();
      const visible = await session.cdp.evaluate<boolean>(`(() => {
        // The compact toolbar hides the label in a narrow window.
        const label = document.querySelector('button.bar-deck-name');
        return Boolean(label) && getComputedStyle(label).display !== 'none';
      })()`);
      if (visible) {
        await session.cdp.click('.bar-deck-name', 'deck folder');
        await wait(80);
        const rows = await session.cdp.evaluate<string[]>(
          `[...document.querySelectorAll('#ctx-menu button')].map((row) => row.textContent)`);
        // The browser's server folder has no Finder or local path to offer.
        const offered = rows.filter((row) => row !== 'Rename…').join();
        if (offered !== 'Copy link,Open folder…') flag('routing', `the deck folder menu offered ${rows.join(', ') || 'nothing'}`);
        if (rows.includes('Rename…') && next() < 0.5) {
          // Rename… opens its dialog, and Escape puts it away with the deck
          // left where it was.
          const dir = await session.cdp.evaluate<string>(`document.querySelector('.bar-deck-name')?.title.split('\\n')[0] ?? ''`);
          await session.cdp.evaluate(`([...document.querySelectorAll('#ctx-menu button')]
            .find((row) => row.textContent === 'Rename…')?.click(), true)`);
          await wait(80);
          if (!(await session.cdp.evaluate<boolean>(`Boolean(document.querySelector('.deck-rename input'))`))) {
            flag('routing', 'Rename… did not open its dialog');
          }
          await session.cdp.evaluate(`(document.querySelector('.deck-rename input')?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
          await wait(80);
          if (await session.cdp.evaluate<boolean>(`Boolean(document.querySelector('.deck-rename'))`)) {
            flag('routing', 'Escape left the rename dialog open');
          }
          const still = await session.cdp.evaluate<string>(`document.querySelector('.bar-deck-name')?.title.split('\\n')[0] ?? ''`);
          if (still !== dir) flag('routing', `cancelling the rename moved the deck from ${dir} to ${still}`);
        } else {
          await session.cdp.evaluate(`(document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), true)`);
          await wait(80);
          if (await session.cdp.evaluate<boolean>(`Boolean(document.getElementById('ctx-menu'))`)) {
            flag('routing', 'the deck folder menu stayed open after a press elsewhere');
          }
        }
      }
      const after = await session.allTexts();
      for (const [id, text] of Object.entries(after)) {
        if (texts[id] !== undefined && texts[id] !== text) flag('routing', `the deck folder menu changed ${id}'s text`);
      }
      return 'same';
    }
    case 'list indent': {
      // The − or + beside List, with the list box selected (or being typed
      // into): its bullets move one step and not one word of any box changes.
      await session.click(LIST);
      const control = '#inspector .field-list-indent';
      const present = await session.cdp.evaluate<boolean>(`Boolean(document.querySelector('${control}'))`);
      if (!present) {
        flag('routing', 'the list box shows no List indent control');
        return 'same';
      }
      const indent = () => session.cdp.evaluate<number>(`parseFloat(getComputedStyle(
        document.querySelector('.slide-layer [data-element-id="${LIST}"] .text-content > ul')).paddingLeft)`);
      const before = await indent();
      const more = next() < 0.5 || before <= 0;
      const texts = await session.allTexts();
      await session.cdp.click(`${control} .list-indent-${more ? 'more' : 'less'}`);
      await wait(120);
      const after = await indent();
      if (more ? after <= before : after >= before) {
        flag('routing', `List indent ${more ? '+' : '−'} moved the bullets from ${before}px to ${after}px`);
      }
      const changed = await session.allTexts();
      for (const [id, text] of Object.entries(changed)) {
        if (texts[id] !== undefined && texts[id] !== text) {
          flag('routing', `changing the list indent changed ${id}: "${texts[id]}" -> "${text}"`);
        }
      }
      return 'same';
    }
    case 'image caption': {
      // Show caption on the picture, nudge the picture, and the caption is
      // still the standard gap below it; switched off again, it is gone and
      // the census is back where it was.
      const geometry = (selector: string) => session.cdp.evaluate<{ x: number; y: number; w: number; h: number } | null>(`(() => {
        const node = document.querySelector('${selector}');
        return node ? { x: parseFloat(node.style.left), y: parseFloat(node.style.top),
          w: parseFloat(node.style.width), h: parseFloat(node.style.height) } : null;
      })()`);
      const picture = `.slide-layer [data-element-id="${IMAGE}"]`;
      const caption = '.slide-layer .element-text.role-caption';
      const toggle = async () => {
        const box = await session.cdp.evaluate<boolean>(`(() => {
          const field = [...document.querySelectorAll('#inspector .field')]
            .find((node) => node.querySelector('span')?.textContent === 'Show caption');
          if (!field) return false;
          field.querySelector('input').click();
          return true;
        })()`);
        if (!box) flag('routing', 'the picture shows no Show caption switch');
        await wait(120);
        return box;
      };
      await session.click(IMAGE);
      const texts = await session.allTexts();
      if (!(await toggle())) return 'same';
      const attached = async (when: string) => {
        const [media, text] = [await geometry(picture), await geometry(caption)];
        if (!media || !text) {
          flag('routing', `${when}: the picture's caption is missing`);
          return;
        }
        if (text.x !== media.x || text.w !== media.w || text.y !== media.y + media.h + 16) {
          flag('routing', `${when}: caption at ${JSON.stringify(text)} under picture ${JSON.stringify(media)}`);
        }
      };
      await attached('Show caption');
      await session.click(IMAGE);
      await session.key('ArrowRight', 39);
      await wait(120);
      await attached('after a nudge');
      await toggle();
      if (await geometry(caption)) flag('routing', 'switching Show caption off left the caption');
      const after = await session.allTexts();
      for (const [id, text] of Object.entries(after)) {
        if (texts[id] !== undefined && texts[id] !== text) {
          flag('routing', `captioning the picture changed ${id}: "${texts[id]}" -> "${text}"`);
        }
      }
      return 'same';
    }
    case 'copy as image': {
      // ⇧⌘C is a picture for other apps (desktop only); here, as on the
      // desktop, it must not touch the deck or the selection it pictures.
      const texts = await session.allTexts();
      const ids = await session.allElementIds();
      const { selection } = await session.state();
      await session.chord('C', 'KeyC', 67, MOD | SHIFT);
      await wait(120);
      const after = await session.state();
      if (after.selection.join() !== selection.join()) {
        flag('routing', `⇧⌘C changed the selection: ${selection.join()} -> ${after.selection.join()}`);
      }
      if ((await session.allElementIds()).join() !== ids.join()) flag('routing', '⇧⌘C added or removed objects');
      const textsAfter = await session.allTexts();
      for (const [id, text] of Object.entries(textsAfter)) {
        if (texts[id] !== undefined && texts[id] !== text) {
          flag('routing', `⇧⌘C changed ${id}: "${texts[id]}" -> "${text}"`);
        }
      }
      return 'same';
    }
    case 'text case': {
      // A Case choice for the paragraph box: its letters are drawn in the new
      // case while the words stored in every box stay exactly as typed.
      await session.click(PARA);
      const choices = ['As typed', 'All capitals', 'All lowercase', 'Capitalize each word'];
      const values = ['none', 'uppercase', 'lowercase', 'capitalize'];
      const pickIndex = Math.floor(next() * choices.length);
      const button = `#inspector .text-case .segment-button[title="${choices[pickIndex]}"]`;
      if (!(await session.cdp.evaluate<boolean>(`Boolean(document.querySelector('${button}'))`))) {
        flag('routing', 'the paragraph box shows no Case control');
        return 'same';
      }
      const texts = await session.allTexts();
      await session.cdp.click(button);
      await wait(120);
      const drawn = await session.cdp.evaluate<string>(`getComputedStyle(
        document.querySelector('.slide-layer [data-element-id="${PARA}"] .text-content')).textTransform`);
      if (drawn !== values[pickIndex]) flag('routing', `Case "${choices[pickIndex]}" drew the paragraph as ${drawn}`);
      const after = await session.allTexts();
      for (const [id, text] of Object.entries(after)) {
        if (texts[id] !== undefined && texts[id] !== text) {
          flag('routing', `changing the case changed the words of ${id}: "${texts[id]}" -> "${text}"`);
        }
      }
      return 'same';
    }
    case 'panel toggle': {
      // ⌥⌘1 / ⌥⌘2 from wherever focus is, mid-edit included: the slide list
      // or sidebar goes away and comes back, and no word on the slide moves.
      // Restored within the op, since rail ops click the list.
      const panel = next() < 0.5 ? 'rail' : 'side';
      const code = panel === 'rail' ? 'Digit1' : 'Digit2';
      const shown = () => session.cdp.evaluate<boolean>(
        `getComputedStyle(document.getElementById('${panel}')).display !== 'none'`);
      const texts = await session.allTexts();
      for (const expected of [false, true]) {
        await session.chord(code.slice(-1), code, code === 'Digit1' ? 49 : 50, MOD | 1);
        await wait(80);
        if ((await shown()) !== expected) flag('routing', `Alt+Cmd/Ctrl+${code.slice(-1)} did not ${expected ? 'show' : 'hide'} the ${panel}`);
      }
      const after = await session.allTexts();
      for (const [id, text] of Object.entries(after)) {
        if (texts[id] !== undefined && texts[id] !== text) {
          flag('routing', `toggling the ${panel} changed ${id}: "${texts[id]}" -> "${text}"`);
        }
      }
      return 'same';
    }
    case 'theme apply': {
      // The Design tab's Apply with Type scale and "Replace my manual
      // changes" ticked, by real clicks: afterwards no text box on the slide
      // may keep a size of its own -- each one follows the theme's role size.
      await session.cdp.click('#side-tabs button[data-panel="themePanel"]', 'Design tab');
      await wait(120);
      for (const group of ['typeScale', 'replaceAuthored']) {
        const ticked = await session.cdp.evaluate<boolean>(
          `document.querySelector('input[data-group="${group}"]').checked`);
        if (!ticked) await session.cdp.click(`input[data-group="${group}"]`, group);
      }
      await session.cdp.click('.theme-apply-action button', 'Apply theme');
      await wait(150);
      await session.cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
      await wait(150);
      const sized = await session.cdp.evaluate<string[]>(`window.store.slide.elements
        .filter((el) => el.type === 'text' && (el.style['font-size'] || /font-size:\\s*\\d*\\.?\\d+(px|pt)/.test(el.html)))
        .map((el) => el.id)`);
      if (sized.length > 0) flag('routing', `Apply with Type scale left sizes on [${sized.join(', ')}]`);
      return 'same';
    }
    case 'undo':
      await session.chord('z', 'KeyZ', 90, MOD);
      await wait(250);
      return 'resync';
    case 'redo':
      await session.chord('z', 'KeyZ', 90, MOD | 8);
      await wait(250);
      return 'resync';
    case 'undo round-trip': {
      // Oracle 4: undo then redo must return to the pre-undo committed state.
      // This is deliberately insensitive to undo granularity, so the known
      // formatting+typing coalescing bug cannot re-fire here.
      if (pre.editing !== null) {
        await session.key('Escape', 27);
      }
      await wait(900); // let any typing run seal
      const before = await session.deckSnapshot();
      await session.chord('z', 'KeyZ', 90, MOD);
      await wait(250);
      await session.chord('z', 'KeyZ', 90, MOD | 8);
      await wait(400);
      let after = await session.deckSnapshot();
      for (let poll = 0; poll < 10 && after !== before; poll++) {
        await wait(200);
        after = await session.deckSnapshot();
      }
      if (after !== before) {
        flag('undoRoundTrip', `undo+redo did not restore the committed deck;`
          + ` diff: ${firstDiff(before, after)}`);
      }
      return 'resync';
    }
    case 'delete selection': {
      const texts = await session.allTexts();
      const survivors = pre.elements.filter((id) => !pre.selection.includes(id));
      const useForwardDelete = next() < 0.4;
      if (useForwardDelete) await session.key('Delete', 46);
      else await session.key('Backspace', 8);
      await wait(150);
      // Element selection + Backspace/Delete must delete the elements, and
      // must never eat text out of a box that was not focused.
      const post = await session.state();
      const remaining = post.elements;
      for (const id of pre.selection) {
        if (remaining.includes(id)) {
          flag('census', `selected ${id} survived ${useForwardDelete ? 'Delete' : 'Backspace'}`);
        }
      }
      const afterTexts = await session.allTexts();
      for (const id of survivors) {
        if (afterTexts[id] !== undefined && texts[id] !== undefined
          && afterTexts[id] !== texts[id]) {
          flag('routing', `deleting the selection changed text in unselected ${id}: `
            + `"${texts[id]}" -> "${afterTexts[id]}"`);
        }
      }
      const expected = (await session.allElementIds());
      return expected;
    }
    case 'cmd+a':
      await session.chord('a', 'KeyA', 65, MOD, pre.editing !== null ? ['selectAll'] : undefined);
      return 'same';
    case 'group toggle': {
      // ⌘G on a selection of separate objects frames them as one group;
      // ⇧⌘G on a selected group takes the frame away. Either way the
      // selection and every word on the slide stay as they were.
      const frames = () => session.cdp.evaluate<number>(
        `document.querySelectorAll('#canvas .overlay-layer .group-frame').length`);
      // Grouping needs two objects. Picked by clicking: ⌘A would select
      // slides instead when the rail has focus (after a rail hop, say).
      // The first click may take a whole group already, and a Shift-click on
      // one of its own pieces would then deselect it.
      if (pre.selection.length < 2) {
        const [first, second] = targetsOn(pre);
        await session.click(first);
        if ((await frames()) === 0) await session.shiftClick(second);
      }
      const picked = (await session.state()).selection;
      const before = await frames();
      const texts = await session.allTexts();
      const ungroup = before > 0;
      await session.chord('g', 'KeyG', 71, ungroup ? MOD | SHIFT : MOD);
      await wait(100);
      const after = await frames();
      if (ungroup ? after !== 0 : after === 0) {
        flag('routing', `${ungroup ? 'Shift+' : ''}Cmd/Ctrl+G left ${after} group frame(s), had ${before}`);
      }
      const post = await session.state();
      if ([...post.selection].sort().join() !== [...picked].sort().join()) {
        flag('routing', `grouping changed the selection: ${picked.join()} -> ${post.selection.join()}`);
      }
      const now = await session.allTexts();
      for (const [id, text] of Object.entries(now)) {
        if (texts[id] !== undefined && texts[id] !== text) flag('routing', `grouping changed ${id}'s text`);
      }
      return 'same';
    }
  }
}

/**
 * Oracle 2: the typed marker must land in exactly the element the UI showed
 * as editing when the keystrokes were sent, and nowhere else.
 */
async function checkRouting(
  pre: CrossState,
  nonce: string,
  flag: (oracle: 'routing', detail: string) => void,
): Promise<void> {
  const texts = await session.allTexts();
  const landed = Object.entries(texts)
    .filter(([, text]) => text.includes(nonce))
    .map(([id]) => id);
  const editing = pre.editing;
  if (editing === null) return;
  if (!landed.includes(editing)) {
    flag('routing', `typed "${nonce}" while the UI showed editing ${editing}, `
      + `but it landed in [${landed.join(', ') || 'nowhere'}]`);
  }
  const strays = landed.filter((id) => id !== editing);
  if (strays.length > 0) {
    flag('routing', `typed "${nonce}" into ${editing} but it also appears in `
      + `[${strays.join(', ')}]`);
  }
}

function firstDiff(a: string, b: string): string {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  const from = Math.max(0, index - 60);
  return `…${a.slice(from, index + 120)}… vs …${b.slice(from, index + 120)}…`;
}
