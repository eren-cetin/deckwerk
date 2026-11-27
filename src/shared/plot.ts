import { PLOT_LEGEND_POSITIONS, PlotSpecSchema, type Deck, type PlotSpec } from './deck.js';
import { effectiveThemeStyle, hexToRgb } from './themes.js';

/**
 * Everything about a plot that is not drawing it: the colours a new plot is
 * born with, and the conversion between a plot's data and the grid of cells
 * people type and paste it as.
 */

/** The order series take their colours in until someone picks their own. */
export const PLOT_SERIES_COLORS = [
  '#c9cad1', '#5b6cf5', '#2ca300', '#f5a35c', '#e57fb8', '#4fc3d9', '#d9c04f', '#b08cf5',
] as const;

/** What each legend position is called in the editor. */
export const PLOT_LEGEND_LABELS: Record<(typeof PLOT_LEGEND_POSITIONS)[number], string> = {
  'top-right': 'Top right',
  'top-left': 'Top left',
  'bottom-right': 'Bottom right',
  'bottom-left': 'Bottom left',
  none: 'Hidden',
};

/** The size a plot is inserted at, in canvas pixels. */
export const PLOT_DEFAULT_SIZE = { w: 780, h: 470 } as const;

/** Return the colour the nth series of a plot starts with. */
export function plotSeriesColor(index: number): string {
  return PLOT_SERIES_COLORS[index % PLOT_SERIES_COLORS.length];
}

function mix(from: string, to: string, amount: number): string | null {
  const a = hexToRgb(from);
  const b = hexToRgb(to);

  if (!a || !b) return null;

  const channel = (i: number): string =>
    Math.round(a[i] + (b[i] - a[i]) * amount).toString(16).padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/**
 * Resolve the non-series ink of a plot from the deck's theme.
 *
 * Args:
 *     deck: The deck the plot will live in.
 *
 * Returns:
 *     Title in the theme's text colour, tick and axis labels in its muted
 *     colour, hairlines a step off the background, and a marker halo in the
 *     background itself so points punch through the lines they sit on.
 */
export function plotThemeColors(deck: Deck): PlotSpec['colors'] {
  const { colors } = effectiveThemeStyle(deck);
  return {
    title: colors.text,
    axis: colors.muted,
    grid: mix(colors.background, colors.muted, 0.17),
    halo: colors.background,
  };
}

/**
 * Parse a plot description, filling whatever it leaves out.
 *
 * Args:
 *     input: A plot spec as parsed JSON; unknown keys are dropped.
 *     deck: When given, colours the spec does not set come from its theme
 *         and series without a colour take the default cycle.
 *
 * Returns:
 *     A complete spec.
 *
 * Raises:
 *     ZodError: If a field has the wrong type.
 */
export function completePlotSpec(input: unknown, deck?: Deck): PlotSpec {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const rawSeries = Array.isArray(raw.series) ? raw.series : [];
  const spec = PlotSpecSchema.parse(raw);
  spec.series.forEach((series, index) => {
    const given = rawSeries[index] as { color?: unknown } | undefined;

    if (typeof given?.color !== 'string') series.color = plotSeriesColor(index);
  });

  if (deck) {
    const theme = plotThemeColors(deck);
    const given = (raw.colors && typeof raw.colors === 'object' ? raw.colors : {}) as
      Record<string, unknown>;
    for (const key of ['title', 'axis', 'grid', 'halo'] as const) {
      if (!(key in given)) spec.colors[key] = theme[key];
    }
  }

  return spec;
}

/** Return the plot a fresh dialog opens on: a little data to type over. */
export function defaultPlotSpec(deck: Deck, kind: PlotSpec['kind'] = 'line'): PlotSpec {
  return completePlotSpec({
    kind,
    xValues: kind === 'bar' ? ['A', 'B', 'C', 'D'] : [1, 2, 3, 4, 5],
    series: [
      { name: 'Series 1', values: kind === 'bar' ? [4, 6.5, 5, 8] : [8, 6, 5, 4.4, 4.1] },
      { name: 'Series 2', values: kind === 'bar' ? [3, 5, 6, 6.5] : [7, 4.6, 3.6, 3.1, 2.9] },
    ],
  }, deck);
}

/** A plot's data as text cells: a header row, then one row per x value. */
export interface PlotGrid {
  /** Series names, one per data column. */
  names: string[];
  /** `rows[r][0]` is the x cell; `rows[r][c + 1]` belongs to series `c`. */
  rows: string[][];
}

function cellText(value: number | string | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/** Parse a typed number; blank or unreadable cells are missing samples. */
export function parsePlotNumber(cell: string): number | null {
  const text = cell.trim().replace(/−/g, '-');

  if (text === '') return null;

  // A lone decimal comma is how half the world's spreadsheets write 3.5.
  const value = Number(/^-?\d+,\d+$/.test(text) ? text.replace(',', '.') : text);
  return Number.isFinite(value) ? value : null;
}

/** Lay a plot's data out as the grid the dialog edits. */
export function plotGrid(spec: Pick<PlotSpec, 'xValues' | 'series'>): PlotGrid {
  return {
    names: spec.series.map((series) => series.name),
    rows: spec.xValues.map((x, row) => [
      cellText(x),
      ...spec.series.map((series) => cellText(series.values[row])),
    ]),
  };
}

/**
 * Read a grid of cells back into plot data.
 *
 * Rows with nothing in them are dropped. The x column stays numeric only when
 * every x cell is a number; one label makes the whole axis categorical.
 *
 * Args:
 *     grid: The cells as edited.
 *     colors: The colour of each series, by column; missing ones take the
 *         default cycle.
 *
 * Returns:
 *     The `xValues` and `series` of a plot spec.
 */
export function plotDataFromGrid(
  grid: PlotGrid,
  colors: Array<string | undefined> = [],
): Pick<PlotSpec, 'xValues' | 'series'> {
  const rows = grid.rows.filter((row) => row.some((cell) => cell.trim() !== ''));
  const numbers = rows.map((row) => parsePlotNumber(row[0] ?? ''));
  const numeric = rows.length > 0 && numbers.every((value) => value !== null);
  return {
    xValues: rows.map((row, index) => (numeric ? numbers[index] as number : (row[0] ?? '').trim())),
    series: grid.names.map((name, column) => ({
      name,
      color: colors[column] ?? plotSeriesColor(column),
      values: rows.map((row) => parsePlotNumber(row[column + 1] ?? '')),
    })),
  };
}

/**
 * Interpret pasted or imported rows as a whole plot grid.
 *
 * Args:
 *     cells: Rows of cell text, as a spreadsheet or CSV file gives them.
 *
 * Returns:
 *     The grid, with the first row taken as series names when any of its data
 *     cells is not a number; `null` when there is no data column.
 */
export function plotGridFromCells(cells: string[][]): PlotGrid | null {
  const rows = cells.filter((row) => row.some((cell) => cell.trim() !== ''));
  const columns = Math.max(0, ...rows.map((row) => row.length));

  if (rows.length === 0 || columns < 2) return null;

  const padded = rows.map((row) =>
    Array.from({ length: columns }, (_, i) => (row[i] ?? '').trim()));
  const header = padded[0].slice(1).some((cell) => cell !== '' && parsePlotNumber(cell) === null);
  return {
    names: header
      ? padded[0].slice(1)
      : Array.from({ length: columns - 1 }, (_, i) => `Series ${i + 1}`),
    rows: header ? padded.slice(1) : padded,
  };
}

/** Guess the separator of pasted text: tabs from spreadsheets, else commas. */
export function plotDelimiter(text: string): string {
  if (text.includes('\t')) return '\t';

  return text.includes(';') && !text.includes(',') ? ';' : ',';
}

const PLOT_SPEC_KEYS = Object.keys(PlotSpecSchema.shape) as Array<keyof PlotSpec>;

/** Return just the plot description carried by a plot element. */
export function plotSpecOf(element: PlotSpec): PlotSpec {
  const spec: Partial<Record<keyof PlotSpec, unknown>> = {};
  for (const key of PLOT_SPEC_KEYS) spec[key] = element[key];

  return structuredClone(spec) as PlotSpec;
}
