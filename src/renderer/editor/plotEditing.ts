import type { PlotEl, PlotSpec } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { PLOT_DEFAULT_SIZE, defaultPlotSpec, plotSpecOf } from '@shared/plot.js';
import { openPlotDialog } from './plotDialog.js';
import type { EditorStore } from './store.js';

/**
 * Insert a plot on the current slide and select it.
 *
 * Args:
 *     store: The editor store to commit into.
 *     spec: The plot to insert.
 *
 * Returns:
 *     The element that was created.
 */
export function insertPlot(store: EditorStore, spec: PlotSpec): PlotEl {
  const { deck } = store.get();
  const w = Math.min(PLOT_DEFAULT_SIZE.w, Math.round(deck.canvas.w * 0.8));
  const h = Math.min(PLOT_DEFAULT_SIZE.h, Math.round(deck.canvas.h * 0.8));
  const z = (store.slide?.elements.reduce((max, el) => Math.max(max, el.z), 0) ?? 0) + 1;
  const created: PlotEl = {
    ...structuredClone(spec),
    type: 'plot', id: makeId('plot'),
    x: Math.round((deck.canvas.w - w) / 2), y: Math.round((deck.canvas.h - h) / 2),
    w, h, rot: 0, z, opacity: 1, class: [], style: {},
  };
  store.commit(
    (d) => d.slides[store.get().slideIndex].elements.push(created),
    { label: `Insert ${spec.kind} plot` },
  );
  store.select([created.id]);
  return created;
}

/** Replace the data and styling of a plot, wherever in the deck it is. */
export function updatePlot(store: EditorStore, elementId: string, spec: PlotSpec): boolean {
  let found = false;
  store.commit((d) => {
    // By id deck-wide: the dialog may outlive the slide it was opened on.
    for (const slide of d.slides) {
      const el = slide.elements.find((item) => item.id === elementId);

      if (el?.type === 'plot') {
        Object.assign(el, structuredClone(spec));
        found = true;
      }
    }
  }, { label: 'Edit plot' });
  return found;
}

/** Ask for a new plot in the dialog and insert it when confirmed. */
export async function insertPlotFromDialog(store: EditorStore): Promise<PlotEl | null> {
  const { deck } = store.get();
  const spec = await openPlotDialog(deck, defaultPlotSpec(deck), { mode: 'insert' });

  if (!spec || !store.slide) return null;

  return insertPlot(store, spec);
}

/** Open the dialog on an existing plot and apply the result as one edit. */
export async function editPlotInDialog(store: EditorStore, elementId: string): Promise<boolean> {
  const { deck } = store.get();
  const el = deck.slides.flatMap((slide) => slide.elements).find((item) => item.id === elementId);

  if (el?.type !== 'plot') return false;

  const before = plotSpecOf(el);
  const spec = await openPlotDialog(deck, before, { mode: 'edit', size: { w: el.w, h: el.h } });

  if (!spec || JSON.stringify(spec) === JSON.stringify(before)) return false;

  return updatePlot(store, elementId, spec);
}
