import { describe, expect, it } from 'vitest';
import { authoredTypeWarnings, settleAuthoredType } from '../src/shared/authoredTextRoles.js';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { slidesFromMeasured, type MeasuredNode, type MeasuredSlide } from '../src/shared/htmlSlides.js';
import { defaultLayoutMasters } from '../src/shared/layoutMasters.js';
import { THEMES, themeStyleOf } from '../src/shared/themes.js';

type TextEl = Extract<SlideElement, { type: 'text' }>;

/** A deck wearing a known theme: title 90px/700, body 40px/400. */
function themedDeck(): Deck {
  const deck = emptyDeck('Roles');
  const style = themeStyleOf(THEMES[0]);
  style.fonts.title = { family: 'Avenir, sans-serif', size: 90, weight: 700, lineHeight: 1, letterSpacing: '-0.02em', color: '#ffffff' };
  style.fonts.heading = { family: 'Avenir, sans-serif', size: 64, weight: 600, lineHeight: 1.1, letterSpacing: '0', color: '#ffffff' };
  style.fonts.body = { family: 'Avenir, sans-serif', size: 40, weight: 400, lineHeight: 1.35, letterSpacing: '0', color: '#ffffff' };
  style.fonts.caption = { family: 'Avenir, sans-serif', size: 28, weight: 500, lineHeight: 1.3, letterSpacing: '0.02em', color: '#9aa3ad' };
  deck.themePreset = THEMES[0].id;
  deck.themeStyle = style;
  return deck;
}

function text(classes: string[], style: Record<string, string>): TextEl {
  return {
    id: 't', type: 'text', x: 0, y: 0, w: 800, h: 100, rot: 0, z: 1, opacity: 1,
    class: classes, style, html: 'Words', align: 'left', valign: 'top',
  } as TextEl;
}

describe('settling the type of text from a standalone page', () => {
  it('drops everything that only repeats the role, in the browser’s units', () => {
    const el = text(['role-title'], {
      'font-family': '"Avenir", sans-serif', 'font-size': '90px', 'font-weight': '700',
      'font-style': 'normal', 'line-height': '90px', 'letter-spacing': '-1.8px',
      color: 'rgb(255, 255, 255)', 'text-transform': 'none',
    });
    const finding = settleAuthoredType(el, 'h1', themedDeck());
    expect(finding).toEqual({ inferred: null, untagged: false, overrides: [] });
    // What the theme does not decide is not its to drop.
    expect(el.style).toEqual({ 'text-transform': 'none' });
    expect(el.overrides).toBeUndefined();
  });

  it('keeps what differs from the role and records it as the box’s overrides', () => {
    const el = text(['role-body'], {
      'font-family': 'Avenir, sans-serif', 'font-size': '30px', 'font-weight': '400',
      'line-height': '40.5px', color: 'rgb(255, 0, 0)',
    });
    const finding = settleAuthoredType(el, 'p', themedDeck());
    // 40.5px is the role's 1.35 at the box's own 30px, so the leading follows.
    expect(el.style).toEqual({ 'font-size': '30px', color: 'rgb(255, 0, 0)' });
    expect(el.overrides).toEqual(['font-size', 'color']);
    expect(finding.overrides).toEqual(['font-size', 'color']);
  });

  it('gives untagged text a role from its tag, or from its size when it is prose', () => {
    const deck = themedDeck();
    const role = (tag: string, size: string) => {
      const el = text([], { 'font-size': size });
      const finding = settleAuthoredType(el, tag, deck);
      return [finding.inferred, finding.untagged, el.class];
    };
    expect(role('h1', '120px')).toEqual(['title', false, ['role-title']]);
    expect(role('h3', '50px')).toEqual(['heading', false, ['role-heading']]);
    expect(role('figcaption', '20px')).toEqual(['caption', false, ['role-caption']]);
    expect(role('p', '42px')).toEqual(['body', false, ['role-body']]);
    expect(role('div', '26px')).toEqual(['caption', false, ['role-caption']]);
    // A small label in a diagram is neither body nor caption: tagging it body
    // would hand it the body size on the next theme change.
    expect(role('div', '14px')).toEqual([null, true, []]);
  });

  it('words one line per kind of finding for a section', () => {
    expect(authoredTypeWarnings(2, [{ inferred: null, untagged: false, overrides: [] }])).toEqual([]);
    const warnings = authoredTypeWarnings(2, [
      { inferred: 'title', untagged: false, overrides: ['font-size'] },
      { inferred: null, untagged: true, overrides: [] },
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/^Section 2: 1 text box\(es\) named no role .*\(title\)/);
    expect(warnings[1]).toMatch(/have no role/);
    expect(warnings[2]).toMatch(/set their own font-size/);
  });
});

describe('compiling a standalone page onto the deck’s theme', () => {
  function node(tag: string, classes: string[], style: Record<string, string>, dataset: Record<string, string> = {}): MeasuredNode {
    return {
      tag, elementId: null, classes, dataset, rect: { x: 100, y: 100, w: 800, h: 120 },
      rotation: 0, opacity: 1, style, html: 'Words', attrs: {},
    } as MeasuredNode;
  }

  const page = (independent: boolean, nodes: MeasuredNode[]): MeasuredSlide => ({
    id: null, name: '', notes: '', background: { color: null, image: null },
    morphFromPrevious: false, nodes, ...(independent ? { independent: true } : {}),
  });

  it('keeps a tagged box on its role with no type of its own, and reports nothing', () => {
    const measured = [page(true, [node('h1', ['role-title'], {
      'font-family': 'Avenir, sans-serif', 'font-size': '90px', 'font-weight': '700',
      'line-height': '90px', 'letter-spacing': '-1.8px', color: 'rgb(255, 255, 255)',
    })])];
    const [slide] = slidesFromMeasured(themedDeck(), measured);
    const title = slide.elements[0] as TextEl;
    expect(title.class).toEqual(['role-title']);
    expect(title.style).toEqual({});
    expect(measured[0].warnings ?? []).toEqual([]);
  });

  it('reports inferred roles and overrides through the compile’s warnings', () => {
    const measured = [page(true, [node('h1', [], { 'font-size': '120px', 'font-weight': '700' })])];
    const [slide] = slidesFromMeasured(themedDeck(), measured);
    const title = slide.elements[0] as TextEl;
    expect(title.class).toEqual(['role-title']);
    expect(title.style).toEqual({ 'font-size': '120px' });
    expect(title.overrides).toEqual(['font-size']);
    expect(measured[0].warnings).toHaveLength(2);
  });

  it('leaves an exported page exactly as it was written', () => {
    const measured = [page(false, [node('div', ['role-body', 'lead'], { 'font-size': '40px' })])];
    const [slide] = slidesFromMeasured(themedDeck(), measured);
    const body = slide.elements[0] as TextEl;
    expect(body.class).toEqual(['role-body', 'lead']);
    expect(body.style).toEqual({ 'font-size': '40px' });
    expect(measured[0].warnings).toBeUndefined();
  });

  it('does not double a layout\u2019s repeated objects when an exported slide comes back', () => {
    const deck = themedDeck();
    deck.layoutMasters = defaultLayoutMasters();
    deck.layoutMasters.standard.elements.push({
      id: 'logo', type: 'shape', shape: 'rect', x: 1700, y: 40, w: 120, h: 60, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, fill: '#3366ff', stroke: null, strokeWidth: 0, radius: 0,
      path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    });
    const exported: MeasuredSlide = {
      ...page(false, [
        { ...node('div', ['layout-master-element'], { background: '#3366ff' }), elementId: 's1--master--logo' },
        node('h1', ['role-title'], {}, { layoutSlot: 'title' }),
      ]),
      id: 's1',
      layout: 'standard',
    };
    const [slide] = slidesFromMeasured(deck, [exported]);
    const ids = slide.elements.map((element) => element.id);
    expect(ids.filter((id) => id === 's1--master--logo')).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
