import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, PlotSpecSchema, type PlotSpec } from '../src/shared/deck.js';
import {
  elementFromNode, plotAuthoringMarkup, slideToHtml, type MeasuredNode,
} from '../src/shared/htmlSlides.js';
import {
  completePlotSpec, defaultPlotSpec, plotDataFromGrid, plotGrid, plotGridFromCells,
  plotThemeColors,
} from '../src/shared/plot.js';
import { formatTick, niceStep, niceTicks, plotSvg } from '../src/shared/plotSvg.js';

/**
 * The reference is a hand-written 780×470 SVG from a real deck: the FID plot
 * the plot style was taken from. Its path coordinates are the fixture, so
 * these tests pin the layout to the drawing people already had on a slide.
 */
const REFERENCE_PATHS = {
  baseline: [[78, 337.7], [247.5, 367.1], [417, 322.2], [586.5, 231.4], [756, 132.4]],
  cka: [[78, 132.6], [247.5, 267.9], [417, 336.8], [586.5, 358.5], [756, 362]],
  repa: [
    [78, 167.4], [162.8, 243.6], [247.5, 295.8], [332.2, 332.3], [417, 343.7],
    [501.8, 349.9], [586.5, 349.3], [671.2, 341.9], [756, 323.1],
  ],
} as const;

/** Undo the reference's y mapping: 8.5 at y=412, 10.5 at y=52. */
function valueAt(y: number): number {
  return Number((8.5 + (412 - y) / 180).toFixed(4));
}

function referenceSpec(): PlotSpec {
  const x = [3, 3.25, 3.5, 3.75, 4, 4.25, 4.5, 4.75, 5];
  const sparse = (points: ReadonlyArray<readonly [number, number]>) =>
    x.map((_, i) => (i % 2 === 0 ? valueAt(points[i / 2][1]) : null));
  return PlotSpecSchema.parse({
    title: 'FID (lower is better)',
    xLabel: 'CFG scale',
    xValues: x,
    series: [
      { name: 'baseline', color: '#c9cad1', values: sparse(REFERENCE_PATHS.baseline) },
      { name: 'CKA λ = 0.1', color: '#5b6cf5', values: sparse(REFERENCE_PATHS.cka) },
      { name: 'REPA before stage 1', color: '#2ca300',
        values: REFERENCE_PATHS.repa.map(([, y]) => valueAt(y)) },
    ],
    colors: { title: '#e7e7e6', axis: '#989ca7', grid: '#22252f', halo: '#0a0b0f' },
  });
}

function attrs(svg: string, tag: string): Array<Record<string, string>> {
  return [...svg.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((match) =>
    Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
}

function texts(svg: string): Array<{ text: string } & Record<string, string>> {
  return [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((match) => ({
    ...Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
    text: match[2],
  }));
}

function pathPoints(d: string): number[][] {
  return d.split(/\s*[ML]\s*/).filter(Boolean).map((pair) => pair.split(',').map(Number));
}

describe('plot ticks', () => {
  it('picks 1-2-5 steps that enclose the data', () => {
    expect(niceStep(1.2, 5)).toBeCloseTo(0.5);
    expect(niceTicks(8.85, 10.05, 5)).toEqual([8.5, 9, 9.5, 10, 10.5]);
    expect(niceTicks(125, 215, 5)).toEqual([120, 140, 160, 180, 200, 220]);
    expect(niceTicks(0, 8, 5)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(4, 4, 5).length).toBeGreaterThan(1);
  });

  it('writes ticks in their shortest form', () => {
    expect(formatTick(9)).toBe('9');
    expect(formatTick(10.5)).toBe('10.5');
    expect(formatTick(0.1 + 0.2)).toBe('0.3');
    expect(formatTick(-0)).toBe('0');
  });
});

describe('plotSvg', () => {
  const svg = plotSvg(referenceSpec(), 780, 470, 'ref');

  it('reproduces the reference frame, grid and labels', () => {
    const labels = texts(svg);
    expect(labels[0]).toMatchObject({
      text: 'FID (lower is better)', x: '78', y: '30', 'font-size': '28', 'font-weight': '600',
      fill: '#e7e7e6',
    });
    const grid = attrs(svg, 'line').filter((line) => line.stroke === '#22252f');
    expect(grid.map((line) => Number(line.y1))).toEqual([412, 322, 232, 142, 52]);
    expect(grid.every((line) => line.x1 === '78' && line.x2 === '756')).toBe(true);
    const yTicks = labels.filter((label) => label['text-anchor'] === 'end');
    expect(yTicks.map((label) => label.text)).toEqual(['8.5', '9', '9.5', '10', '10.5']);
    expect(yTicks.map((label) => [label.x, label.y])).toEqual(
      [['66', '420'], ['66', '330'], ['66', '240'], ['66', '150'], ['66', '60']],
    );
    const xTicks = labels.filter((label) => label.y === '446');
    expect(xTicks.map((label) => [label.text, Number(label.x)])).toEqual(
      [['3', 78], ['3.5', 247.5], ['4', 417], ['4.5', 586.5], ['5', 756]],
    );
    expect(labels.find((label) => label.text === 'CFG scale')).toMatchObject({
      x: '417', y: '469', 'font-size': '20', fill: '#989ca7',
    });
    expect(svg).not.toContain('font-family');
  });

  it('reproduces the reference series, skipping the samples a series lacks', () => {
    const paths = attrs(svg, 'path');
    expect(paths.map((path) => [path.stroke, path['stroke-width']])).toEqual(
      [['#c9cad1', '3'], ['#5b6cf5', '3'], ['#2ca300', '3']],
    );
    Object.values(REFERENCE_PATHS).forEach((reference, index) => {
      const points = pathPoints(paths[index].d);
      expect(points).toHaveLength(reference.length);
      points.forEach(([x, y], i) => {
        expect(Math.abs(x - reference[i][0])).toBeLessThan(0.11);
        expect(Math.abs(y - reference[i][1])).toBeLessThan(0.11);
      });
    });
    const dots = attrs(svg, 'circle');
    expect(dots).toHaveLength(19);
    expect(dots[0]).toMatchObject({ r: '6', fill: '#c9cad1', stroke: '#0a0b0f', 'stroke-width': '1.5' });
  });

  it('draws an unboxed legend in the series colours', () => {
    const swatches = attrs(svg, 'line').filter((line) => line['stroke-width'] === '4');
    expect(swatches.map((line) => [line.stroke, line.y1])).toEqual(
      [['#c9cad1', '80'], ['#5b6cf5', '114'], ['#2ca300', '148']],
    );
    const label = texts(svg).find((item) => item.text === 'REPA before stage 1');
    expect(label).toMatchObject({ fill: '#2ca300', y: '156', 'font-size': '22' });
    expect(Number(label?.x) - Number(swatches[0].x2)).toBe(10);
    expect(Number(swatches[0].x1)).toBeGreaterThan(417);
    expect(plotSvg({ ...referenceSpec(), legend: 'none' }, 780, 470)).not.toContain('>baseline<');
  });

  it('reflows at a new size instead of stretching', () => {
    const wide = plotSvg(referenceSpec(), 1200, 600, 'ref');
    expect(wide).toContain('viewBox="0 0 1200 600"');
    expect(texts(wide)[0]).toMatchObject({ 'font-size': '28', x: '78' });
    expect(attrs(wide, 'line')[0].x2).toBe('1176');
  });

  it('scales every measure with the text size', () => {
    const big = plotSvg({ ...referenceSpec(), textSize: 44 }, 1560, 940, 'ref');
    expect(texts(big)[0]).toMatchObject({ 'font-size': '56', x: '156', y: '60' });
  });

  it('draws grouped bars from a zero baseline', () => {
    const spec = PlotSpecSchema.parse({
      kind: 'bar', xValues: ['A', 'B'],
      series: [
        { name: 'one', color: '#111111', values: [2, 4] },
        { name: 'two', color: '#222222', values: [3, null] },
      ],
    });
    const bars = attrs(plotSvg(spec, 780, 470), 'path');
    expect(bars.map((bar) => bar.fill)).toEqual(['#111111', '#111111', '#222222']);
    const labels = texts(plotSvg(spec, 780, 470));
    expect(labels.filter((l) => l['text-anchor'] === 'end').map((l) => l.text)[0]).toBe('0');
    expect(labels.filter((l) => l['text-anchor'] === 'middle').map((l) => l.text)).toEqual(['A', 'B']);
    // Every bar starts on the floor of the plot.
    const floor = 470 - 42;
    expect(bars.every((bar) => bar.d.startsWith('M') && bar.d.includes(`,${floor} L`))).toBe(true);
  });

  it('treats labels on a line plot as evenly spaced categories', () => {
    const spec = PlotSpecSchema.parse({
      xValues: ['Mon', 'Tue', 'Wed'], series: [{ name: 'a', values: [1, 2, 3] }],
    });
    const xs = texts(plotSvg(spec, 780, 470))
      .filter((label) => ['Mon', 'Tue', 'Wed'].includes(label.text)).map((label) => Number(label.x));
    expect(xs).toEqual([78, 417, 756]);
  });

  it('clips marks only when a limit is pinned, and survives empty data', () => {
    expect(svg).not.toContain('clipPath');
    expect(plotSvg({ ...referenceSpec(), yMax: 9.5 }, 780, 470, 'a b')).toContain('id="plot-clip-a-b"');
    const empty = plotSvg(PlotSpecSchema.parse({}), 780, 470);
    expect(empty).toContain('<svg');
    expect(empty).not.toContain('NaN');
    expect(plotSvg(PlotSpecSchema.parse({ xValues: [1], series: [{ values: [5] }] }), 300, 200))
      .not.toContain('NaN');
  });

  it('escapes text and falls back to the slide ink without colours', () => {
    const plain = plotSvg(PlotSpecSchema.parse({
      title: 'a < b & c', xValues: [1, 2], series: [{ name: '"q"', values: [1, 2] }],
    }), 780, 470);
    expect(plain).toContain('a &lt; b &amp; c');
    expect(plain).toContain('fill="currentColor"');
    expect(attrs(plain, 'circle')[0].stroke).toBeUndefined();
  });
});

describe('plot data', () => {
  it('fills colours from the theme and the series cycle', () => {
    const deck = emptyDeck('t');
    const spec = completePlotSpec({ xValues: [1, 2], series: [{ values: [1, 2] }, { values: [2, 1], color: '#123456' }] }, deck);
    expect(spec.colors).toEqual(plotThemeColors(deck));
    expect(spec.series.map((s) => s.color)).toEqual(['#c9cad1', '#123456']);
    expect(completePlotSpec({ colors: { halo: null } }, deck).colors.halo).toBeNull();
    expect(defaultPlotSpec(deck, 'bar').kind).toBe('bar');
  });

  it('round-trips data through the grid', () => {
    const spec = referenceSpec();
    const data = plotDataFromGrid(plotGrid(spec), spec.series.map((s) => s.color));
    expect(data.xValues).toEqual(spec.xValues);
    expect(data.series).toEqual(spec.series);
  });

  it('reads pasted cells, with or without a header row', () => {
    const withHeader = plotGridFromCells([['cfg', 'base', 'ours'], ['3', '9.1', '8,9'], ['', '', '']]);
    expect(withHeader).toEqual({ names: ['base', 'ours'], rows: [['3', '9.1', '8,9']] });
    expect(plotDataFromGrid(withHeader!).series[1].values).toEqual([8.9]);
    expect(plotGridFromCells([['1', '2'], ['2', '3']])?.names).toEqual(['Series 1']);
    expect(plotGridFromCells([['only']])).toBeNull();
    expect(plotDataFromGrid({ names: ['a'], rows: [['1', '2'], ['x', '']] }).xValues).toEqual(['1', 'x']);
  });
});

describe('plot authoring round trip', () => {
  function measured(dataset: Record<string, string>): MeasuredNode {
    return {
      tag: 'div', elementId: null, classes: [], dataset,
      rect: { x: 120, y: 440, w: 780, h: 470 }, rotation: 0, opacity: 1,
      style: {}, html: '', attrs: {},
    };
  }

  function dataPlot(html: string): string {
    const raw = /data-plot='([^']*)'/.exec(html)?.[1] ?? '';
    return raw.replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  it('reads a minimal description and fills the rest from the deck', () => {
    const deck = emptyDeck('t');
    const element = elementFromNode(measured({
      element: 'plot',
      plot: '{"title":"Loss","xValues":[1,2,3],"series":[{"name":"train","values":[3,2,1]}]}',
    }), 'p1', 2, deck);
    expect(element).toMatchObject({
      type: 'plot', kind: 'line', title: 'Loss', x: 120, y: 440, w: 780, h: 470,
      xValues: [1, 2, 3], legend: 'top-right', textSize: 22,
      colors: plotThemeColors(deck),
    });
    expect(element?.type === 'plot' && element.series[0]).toEqual(
      { name: 'train', color: '#c9cad1', values: [3, 2, 1] },
    );
    expect(() => parseDeck({ version: 1, slides: [{ id: 's', elements: [element] }] })).not.toThrow();
  });

  it('exports the description with its drawing and reads the same plot back', () => {
    const deck = emptyDeck('t');
    const spec = { ...referenceSpec(), title: `it's <a> & "b"` };
    deck.slides[0].elements.push({
      ...spec, type: 'plot', id: 'p1', x: 120, y: 440, w: 780, h: 470, rot: 0, z: 1,
      opacity: 1, class: [], style: {},
    });
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html).toContain('data-element="plot"');
    // The drawing is scenery: the walk must not take it for an object.
    expect(html).toContain('<svg data-element="none"');
    expect(JSON.parse(dataPlot(html))).toEqual(spec);

    const back = elementFromNode(measured({ element: 'plot', plot: dataPlot(html) }), 'p1', 1, deck);
    expect(back).toEqual(deck.slides[0].elements[0]);
    expect(dataPlot(plotAuthoringMarkup(spec, { w: 600, h: 400 }))).toBe(JSON.stringify(spec));
  });

  it('accepts URI-encoded JSON and explains a description it cannot read', () => {
    const encoded = encodeURIComponent('{"kind":"bar","xValues":["a"],"series":[{"values":[1]}]}');
    expect(elementFromNode(measured({ element: 'plot', plot: encoded }), 'p', 1))
      .toMatchObject({ type: 'plot', kind: 'bar', colors: { title: null, halo: null } });
    expect(() => elementFromNode(measured({ element: 'plot', plot: '{oops' }), 'p', 1))
      .toThrow(/data-plot is not valid JSON/);
    expect(() => elementFromNode(measured({ element: 'plot', plot: '{"kind":"pie"}' }), 'p', 1))
      .toThrow(/does not describe a plot \(kind/);
  });
});

describe('plot legend headroom', () => {
  const bars = (over: Record<string, unknown> = {}) => PlotSpecSchema.parse({
    kind: 'bar', xValues: ['a', 'b', 'c'], legend: 'top-left',
    series: [{ name: 'one', values: [240, 131, 160] }, { name: 'two', values: [201, 196, 214] }],
    ...over,
  });
  const yTicks = (svg: string) =>
    texts(svg).filter((label) => label['text-anchor'] === 'end').map((label) => Number(label.text));

  it('adds steps above bars the legend would otherwise be printed on', () => {
    expect(Math.max(...yTicks(plotSvg(bars({ legend: 'none' }), 697, 420)))).toBe(250);
    expect(Math.max(...yTicks(plotSvg(bars(), 697, 420)))).toBeGreaterThan(250);
  });

  it('leaves a pinned axis and line plots alone', () => {
    expect(Math.max(...yTicks(plotSvg(bars({ yMax: 250 }), 697, 420)))).toBe(250);
    expect(yTicks(plotSvg(bars({ kind: 'line' }), 697, 420)))
      .toEqual(yTicks(plotSvg(bars({ kind: 'line', legend: 'none' }), 697, 420)));
  });
});
