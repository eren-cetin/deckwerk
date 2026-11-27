// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type PlotEl } from '../src/shared/deck.js';
import { defaultPlotSpec, plotSpecOf } from '../src/shared/plot.js';
import { createPlotInsertButton } from '../src/renderer/editor/elementCreation.js';
import { openPlotDialog } from '../src/renderer/editor/plotDialog.js';
import { editPlotInDialog, insertPlot, updatePlot } from '../src/renderer/editor/plotEditing.js';
import { renderSlide } from '../src/renderer/player/render.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * The plot dialog and the actions around it, driven through the DOM the way
 * a person drives them: typing into grid cells, pasting a block copied from a
 * spreadsheet, pressing Insert.
 */

function setup(): EditorStore {
  document.body.replaceChildren();
  return new EditorStore(emptyDeck('Plots'), '/tmp/plots');
}

const dialog = () => document.querySelector<HTMLElement>('.plot-dialog');
const cell = (row: number, column: number) =>
  document.querySelector<HTMLInputElement>(`.plot-grid input[data-row="${row}"][data-column="${column}"]`)!;
const actionButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.plot-dialog button')]
    .find((button) => button.textContent === label)!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function paste(input: HTMLInputElement, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  input.dispatchEvent(event);
}

describe('plot insertion', () => {
  beforeEach(() => document.body.replaceChildren());

  it('inserts a centred, selected plot as one named undo step', () => {
    const store = setup();
    const { deck } = store.get();
    const created = insertPlot(store, defaultPlotSpec(deck));
    expect(created).toMatchObject({ type: 'plot', kind: 'line', w: 780, h: 470, x: 570, y: 305 });
    expect([...store.get().selection]).toEqual([created.id]);
    expect(store.slide!.elements).toHaveLength(1);
    store.undo();
    expect(store.slide!.elements).toHaveLength(0);
  });

  it('draws the plot on the slide and redraws nothing it was not told to', () => {
    const store = setup();
    insertPlot(store, defaultPlotSpec(store.get().deck));
    const node = renderSlide(store.slide!, { resolveSrc: (src) => src });
    const svg = node.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 780 470');
    expect(svg?.querySelectorAll('path')).toHaveLength(2);
    expect(svg?.querySelectorAll('circle')).toHaveLength(10);
  });

  it('opens from the toolbar button, edits in the grid and inserts on confirm', async () => {
    const store = setup();
    const trigger = createPlotInsertButton(store);
    document.body.appendChild(trigger);
    expect(trigger.getAttribute('aria-label')).toBe('Plot');
    trigger.click();
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Insert plot');
    expect(dialog()?.querySelector('.plot-dialog-preview svg')).not.toBeNull();

    type(cell(0, 1), '42');
    expect(dialog()!.querySelector('.plot-dialog-preview')!.innerHTML).toContain('>50<');
    const title = [...dialog()!.querySelectorAll<HTMLLabelElement>('label.field')]
      .find((label) => label.querySelector('span')?.textContent === 'Title')!
      .querySelector('input')!;
    type(title, 'Loss');

    actionButton('Insert').click();
    await settle();
    expect(dialog()).toBeNull();
    const [created] = store.slide!.elements as PlotEl[];
    expect(created).toMatchObject({ type: 'plot', title: 'Loss' });
    expect(created.series[0].values[0]).toBe(42);
    expect([...store.get().selection]).toEqual([created.id]);
  });

  it('inserts nothing when cancelled', async () => {
    const store = setup();
    createPlotInsertButton(store).click();
    actionButton('Cancel').click();
    await settle();
    expect(dialog()).toBeNull();
    expect(store.slide!.elements).toHaveLength(0);
  });
});

describe('plot dialog grid', () => {
  beforeEach(() => document.body.replaceChildren());

  it('grows to fit a pasted spreadsheet block and takes its header as series names', async () => {
    const deck = emptyDeck('Plots');
    const result = openPlotDialog(deck, defaultPlotSpec(deck), { mode: 'insert' });
    paste(cell(0, 0), 'cfg\tbaseline\tours\tthird\n3\t9.1\t8.9\t1\n3.5\t9.4\t\t2\n4\t9.9\t8.7\t3\n'.repeat(1)
      + '4.5\t10\t8.8\t4\n5\t10.2\t8.9\t5\n5.5\t10.4\t9\t6\n');
    const names = [...document.querySelectorAll<HTMLInputElement>('.plot-grid-series input[type="text"]')]
      .map((input) => input.value);
    expect(names).toEqual(['baseline', 'ours', 'third']);
    expect(document.querySelectorAll('.plot-grid tbody tr')).toHaveLength(6);

    actionButton('Insert').click();
    const spec = (await result)!;
    expect(spec.xValues).toEqual([3, 3.5, 4, 4.5, 5, 5.5]);
    expect(spec.series.map((series) => series.name)).toEqual(['baseline', 'ours', 'third']);
    expect(spec.series[1].values).toEqual([8.9, null, 8.7, 8.8, 8.9, 9]);
    expect(spec.series[2].color).toBe('#2ca300');
  });

  it('adds and removes rows and series, and walks cells with the keyboard', async () => {
    const deck = emptyDeck('Plots');
    const result = openPlotDialog(deck, defaultPlotSpec(deck), { mode: 'insert' });
    actionButton('Add series').click();
    actionButton('Add row').click();
    expect(document.querySelectorAll('.plot-grid-series')).toHaveLength(3);
    expect(document.querySelectorAll('.plot-grid tbody tr')).toHaveLength(6);

    cell(5, 0).focus();
    cell(5, 0).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelectorAll('.plot-grid tbody tr')).toHaveLength(7);
    expect(document.activeElement).toBe(cell(6, 0));
    cell(6, 0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(cell(5, 0));

    document.querySelector<HTMLButtonElement>('[aria-label="Remove series 1"]')!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="Remove row 1"]')!.click();
    actionButton('Insert').click();
    const spec = (await result)!;
    // Rows left blank are not data.
    expect(spec.xValues).toEqual([2, 3, 4, 5]);
    expect(spec.series.map((series) => series.name)).toEqual(['Series 2', 'Series 3']);
  });

  it('switches to bars, disabling what only lines have', async () => {
    const deck = emptyDeck('Plots');
    const result = openPlotDialog(deck, defaultPlotSpec(deck), { mode: 'insert' });
    document.querySelector<HTMLButtonElement>('.plot-dialog .segment-button[data-value="bar"]')!.click();
    expect(document.querySelector('.plot-grid-corner')?.textContent).toBe('Category');
    const markers = [...document.querySelectorAll<HTMLLabelElement>('.plot-dialog .field-check')]
      .find((label) => label.textContent === 'Point markers')!;
    expect(markers.querySelector('input')!.disabled).toBe(true);
    actionButton('Insert').click();
    expect((await result)!.kind).toBe('bar');
  });

  it('closes on Escape without a result', async () => {
    const deck = emptyDeck('Plots');
    const result = openPlotDialog(deck, defaultPlotSpec(deck), { mode: 'edit' });
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Edit plot');
    document.querySelector('.workflow-overlay')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await result).toBeNull();
  });
});

describe('plot editing', () => {
  beforeEach(() => document.body.replaceChildren());

  it('applies the dialog to the plot as one undo step, and nothing when unchanged', async () => {
    const store = setup();
    const created = insertPlot(store, defaultPlotSpec(store.get().deck));
    const before = plotSpecOf(created);

    const unchanged = editPlotInDialog(store, created.id);
    actionButton('Apply').click();
    expect(await unchanged).toBe(false);

    const edited = editPlotInDialog(store, created.id);
    type(cell(1, 2), '99');
    actionButton('Apply').click();
    expect(await edited).toBe(true);
    const plot = store.slide!.elements[0] as PlotEl;
    expect(plot.series[1].values[1]).toBe(99);
    expect(plot).toMatchObject({ id: created.id, x: created.x, w: created.w });
    store.undo();
    expect(plotSpecOf(store.slide!.elements[0] as PlotEl)).toEqual(before);
  });

  it('finds the plot by id on whichever slide it is, and ignores a missing one', () => {
    const store = setup();
    const created = insertPlot(store, defaultPlotSpec(store.get().deck));
    store.commit((deck) => {
      deck.slides.unshift({ ...structuredClone(deck.slides[0]), id: 'front', elements: [] });
    });
    const next = { ...plotSpecOf(created), title: 'Moved' };
    expect(updatePlot(store, created.id, next)).toBe(true);
    expect(store.get().deck.slides[1].elements[0]).toMatchObject({ title: 'Moved' });
    expect(updatePlot(store, 'gone', next)).toBe(false);
  });
});
