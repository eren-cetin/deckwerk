import type { PlotSpec } from './deck.js';

/**
 * A plot as SVG markup.
 *
 * Built as a string, like `shapeSvg`, so that everything that shows a plot
 * shares one drawing: the player parses it into a live element, the HTML
 * exporter and the `slide-agent plot` command write it into a file, and the
 * plot dialog previews it. The drawing is laid out at the element's own
 * `w × h` — resizing a plot gives the data more room rather than stretching
 * the type — and every measure hangs off `textSize`, so one number scales the
 * whole thing.
 *
 * The style is fixed on purpose: a left-aligned title, horizontal hairlines
 * only (the lowest one is the x axis), muted tick labels with no tick marks
 * or axis lines, straight 3px series with haloed round markers, and an
 * unboxed legend whose labels wear their series' colour. Text sets no font,
 * so it inherits the slide's.
 */

/** Tick-label size every other measure is expressed against. */
const BASE_TEXT = 22;

/** Share of a category's band that its group of bars fills. */
const BAR_GROUP_FILL = 0.72;

interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * Return the smallest step of the form 1, 2 or 5 × 10ⁿ that covers a span.
 *
 * Args:
 *     span: The length of the range to divide.
 *     target: The most intervals the range may be cut into.
 *
 * Returns:
 *     The step, or 1 when the span is not positive.
 */
export function niceStep(span: number, target = 5): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;

  const raw = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  // The tolerance keeps 0.5000000001 from being pushed up a whole step.
  const nice = fraction <= 1 + 1e-9 ? 1 : fraction <= 2 + 1e-9 ? 2 : fraction <= 5 + 1e-9 ? 5 : 10;
  return nice * magnitude;
}

/** Strip the float noise a multiple of a decimal step picks up. */
function clean(value: number): number {
  return Number(value.toPrecision(12));
}

/**
 * Return round tick values that enclose a data range.
 *
 * Args:
 *     min: The smallest value to cover.
 *     max: The largest value to cover.
 *     target: The most intervals to produce.
 *
 * Returns:
 *     Evenly spaced ticks whose first and last values bracket the range.
 */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];

  if (min > max) [min, max] = [max, min];

  if (min === max) {
    // A flat series still needs a band to sit in.
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }

  const step = niceStep(max - min, target);
  const first = Math.floor(min / step + 1e-9);
  const last = Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let i = first; i <= last; i += 1) ticks.push(clean(i * step));

  return ticks;
}

/** Return the multiples of a round step that fall inside a fixed range. */
function ticksWithin(min: number, max: number, target: number): number[] {
  const step = niceStep(max - min, target);
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  const ticks: number[] = [];
  for (let i = first; i <= last; i += 1) ticks.push(clean(i * step));

  return ticks;
}

/** Format a tick in its shortest form: `9`, `10.5`, `1e-7`. */
export function formatTick(value: number): string {
  const cleaned = clean(value);
  return String(Object.is(cleaned, -0) ? 0 : cleaned);
}

/**
 * Estimate the width of a label without a DOM to measure it in.
 *
 * Only layout decisions lean on this (how wide the left margin is, where a
 * right-hand legend starts, whether category labels collide), so a
 * per-character-class average is enough.
 */
export function estimateTextWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) {
    if (/[ilI.,:;'|!\s]/.test(ch) || ch === 'j' || ch === 't' || ch === 'f') em += 0.3;
    else if (/[mwMW@]/.test(ch)) em += 0.86;
    else if (/[A-Z]/.test(ch)) em += 0.68;
    else if (/[0-9]/.test(ch)) em += 0.56;
    else em += 0.54;
  }

  return em * size;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One decimal is finer than a projector pixel and keeps the markup short. */
function px(value: number): string {
  return String(Number(value.toFixed(1)));
}

function isNumeric(value: number | string): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finite(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/** Return whether a line plot's x column can be laid out on a numeric axis. */
export function hasNumericX(spec: Pick<PlotSpec, 'kind' | 'xValues'>): boolean {
  return spec.kind === 'line' && spec.xValues.length > 0 && spec.xValues.every(isNumeric);
}

function yScale(spec: PlotSpec, target: number, headroom = 0): Scale {
  const values = finite(spec.series.flatMap((s) => s.values.slice(0, spec.xValues.length)));
  let lo = values.length ? Math.min(...values) : 0;
  let hi = values.length ? Math.max(...values) : 1;

  if (spec.kind === 'bar') {
    // A bar's length is its value, so the axis has to start where bars do.
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }

  if (spec.yMin !== null) lo = spec.yMin;

  if (spec.yMax !== null) hi = spec.yMax;

  if (spec.yMin !== null && spec.yMax !== null && spec.yMin < spec.yMax) {
    return { min: lo, max: hi, ticks: ticksWithin(lo, hi, target) };
  }

  if (lo > hi) [lo, hi] = [hi, lo];

  const ticks = niceTicks(lo, hi, target);

  if (spec.yMax === null && ticks.length > 1) {
    // Extra steps above the data, asked for when a legend needs the room.
    const step = ticks[1] - ticks[0];
    const last = ticks[ticks.length - 1];
    for (let i = 1; i <= headroom; i += 1) ticks.push(clean(last + i * step));
  }

  // A pinned end stays exactly where it was put; the free end rounds outward.
  const min = spec.yMin !== null ? lo : ticks[0];
  const max = spec.yMax !== null ? hi : ticks[ticks.length - 1];
  return { min, max, ticks: ticks.filter((t) => t >= min - 1e-9 && t <= max + 1e-9) };
}

function xScale(spec: PlotSpec, target: number): Scale {
  const values = finite(spec.xValues as Array<number | null>);
  let min = spec.xMin ?? Math.min(...values);
  let max = spec.xMax ?? Math.max(...values);

  if (min > max) [min, max] = [max, min];

  if (min === max) {
    min -= 1;
    max += 1;
  }

  return { min, max, ticks: ticksWithin(min, max, target) };
}

/**
 * Draw a plot at a given size.
 *
 * Args:
 *     spec: The plot's data and styling.
 *     w: The width of the box, in canvas pixels.
 *     h: The height of the box, in canvas pixels.
 *     id: A page-unique token for the clip path that pinned axis limits
 *         need; the element id, normally.
 *
 * Returns:
 *     A complete `<svg>` element as markup.
 */
export function plotSvg(spec: PlotSpec, w: number, h: number, id = 'plot'): string {
  return draw(spec, w, h, id, 0);
}

/** `plotSvg`, with the number of spare y steps left above the data. */
function draw(spec: PlotSpec, w: number, h: number, id: string, headroom: number): string {
  const s = spec.textSize / BASE_TEXT;
  const tickSize = spec.textSize;
  const titleSize = 28 * s;
  const axisTitleSize = 20 * s;
  const titleInk = spec.colors.title ?? 'currentColor';
  const axisInk = spec.colors.axis ?? 'currentColor';
  const gridInk = spec.colors.grid ?? 'currentColor';
  // Without colours of their own, the muted parts are the slide's ink, thinned.
  const axisAlpha = spec.colors.axis ? '' : ' fill-opacity="0.62"';
  const gridAlpha = spec.colors.grid ? '' : ' stroke-opacity="0.14"';

  const rows = spec.xValues.length;
  const numericX = hasNumericX(spec);
  const top = spec.title ? 52 * s : 16 * s;
  const bottom = spec.xLabel ? 58 * s : 42 * s;
  const right = 24 * s;
  const plotH = Math.max(1, h - top - bottom);
  const y = yScale(spec, Math.max(2, Math.min(6, Math.floor(plotH / (70 * s)))), headroom);
  const yLabels = y.ticks.map(formatTick);
  const widestTick = Math.max(0, ...yLabels.map((label) => estimateTextWidth(label, tickSize)));
  const left = Math.max(78 * s, widestTick + 27 * s) + (spec.yLabel ? 30 * s : 0);
  const plotW = Math.max(1, w - left - right);
  const plotRight = left + plotW;
  const plotBottom = top + plotH;
  const yAt = (value: number): number =>
    plotBottom - ((value - y.min) / (y.max - y.min || 1)) * plotH;

  const out: string[] = [];

  if (spec.title) {
    out.push(
      `<text x="${px(left)}" y="${px(30 * s)}" fill="${escapeXml(titleInk)}"`
      + ` font-size="${px(titleSize)}" font-weight="600">${escapeXml(spec.title)}</text>`,
    );
  }

  // Horizontal rules. The lowest is the x axis and is drawn even with the
  // grid off, so the plot always has a floor.
  const floor = y.ticks.length ? y.ticks[0] : y.min;
  for (const tick of y.ticks) {
    const ty = yAt(tick);

    if (spec.grid || tick === floor) {
      out.push(
        `<line x1="${px(left)}" x2="${px(plotRight)}" y1="${px(ty)}" y2="${px(ty)}"`
        + ` stroke="${escapeXml(gridInk)}"${gridAlpha} stroke-width="${px(Math.max(1, s))}"/>`,
      );
    }

    out.push(
      `<text x="${px(left - 12 * s)}" y="${px(ty + 8 * s)}" fill="${escapeXml(axisInk)}"${axisAlpha}`
      + ` font-size="${px(tickSize)}" text-anchor="end">${escapeXml(formatTick(tick))}</text>`,
    );
  }

  // Where each row sits along x, and the labels under the axis.
  let xAt: (row: number) => number;
  const xLabels: Array<{ x: number; label: string }> = [];
  const band = plotW / Math.max(1, rows);

  if (numericX) {
    const x = xScale(spec, Math.max(2, Math.min(8, Math.floor(plotW / (90 * s)))));
    const at = (value: number): number => left + ((value - x.min) / (x.max - x.min)) * plotW;
    xAt = (row) => at(spec.xValues[row] as number);
    for (const tick of x.ticks) xLabels.push({ x: at(tick), label: formatTick(tick) });
  } else {
    xAt = spec.kind === 'bar'
      ? (row) => left + band * (row + 0.5)
      // Categories on a line plot run edge to edge, like a numeric axis does.
      : (row) => (rows > 1 ? left + (row / (rows - 1)) * plotW : left + plotW / 2);
    const labels = spec.xValues.map((value) => String(value));
    const widest = Math.max(0, ...labels.map((label) => estimateTextWidth(label, tickSize)));
    const room = spec.kind === 'bar' ? band : plotW / Math.max(1, rows - 1);
    // Thin the labels rather than let neighbours run into each other.
    const every = Math.max(1, Math.ceil((widest + 12 * s) / Math.max(1, room)));
    labels.forEach((label, row) => {
      if (row % every === 0) xLabels.push({ x: xAt(row), label });
    });
  }

  for (const { x, label } of xLabels) {
    out.push(
      `<text x="${px(x)}" y="${px(plotBottom + 34 * s)}" fill="${escapeXml(axisInk)}"${axisAlpha}`
      + ` font-size="${px(tickSize)}" text-anchor="middle">${escapeXml(label)}</text>`,
    );
  }

  if (spec.xLabel) {
    out.push(
      `<text x="${px(left + plotW / 2)}" y="${px(plotBottom + 57 * s)}" fill="${escapeXml(axisInk)}"`
      + `${axisAlpha} font-size="${px(axisTitleSize)}" text-anchor="middle">`
      + `${escapeXml(spec.xLabel)}</text>`,
    );
  }

  if (spec.yLabel) {
    const cx = axisTitleSize;
    const cy = top + plotH / 2;
    out.push(
      `<text x="${px(cx)}" y="${px(cy)}" fill="${escapeXml(axisInk)}"${axisAlpha}`
      + ` font-size="${px(axisTitleSize)}" text-anchor="middle"`
      + ` transform="rotate(-90 ${px(cx)} ${px(cy)})">${escapeXml(spec.yLabel)}</text>`,
    );
  }

  // Pinned limits can leave data outside the plot area; only then is a clip
  // worth the id it costs.
  const pinned = spec.yMin !== null || spec.yMax !== null
    || (numericX && (spec.xMin !== null || spec.xMax !== null));
  const clipId = `plot-clip-${id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const marks: string[] = [];
  const bars: Array<{ x0: number; x1: number; top: number }> = [];

  if (spec.kind === 'bar') {
    const count = Math.max(1, spec.series.length);
    const gap = Math.min(2 * s, (band * BAR_GROUP_FILL) / count / 4);
    const barW = Math.max(0.5, (band * BAR_GROUP_FILL - gap * (count - 1)) / count);
    const base = yAt(Math.min(Math.max(0, y.min), y.max));
    spec.series.forEach((series, index) => {
      for (let row = 0; row < rows; row += 1) {
        const value = series.values[row];

        if (typeof value !== 'number' || !Number.isFinite(value)) continue;

        const x0 = xAt(row) - (band * BAR_GROUP_FILL) / 2 + index * (barW + gap);
        marks.push(barPath(x0, base, barW, yAt(value), 4 * s, series.color));
        bars.push({ x0, x1: x0 + barW, top: Math.min(base, yAt(value)) });
      }
    });
  } else {
    const radius = spec.lineWidth * 2;
    const halo = spec.colors.halo
      ? ` stroke="${escapeXml(spec.colors.halo)}" stroke-width="${px(spec.lineWidth / 2)}"`
      : '';
    for (const series of spec.series) {
      const points: Array<[number, number]> = [];
      for (let row = 0; row < rows; row += 1) {
        const value = series.values[row];

        if (typeof value === 'number' && Number.isFinite(value)) {
          points.push([xAt(row), yAt(value)]);
        }
      }

      // Missing samples are skipped, not broken on: series sampled at
      // different x values share one column and must still read as lines.
      if (numericX) points.sort((a, b) => a[0] - b[0]);

      if (points.length > 1) {
        const d = points.map(([x, py], i) => `${i ? 'L' : 'M'}${px(x)},${px(py)}`).join(' ');
        marks.push(
          `<path d="${d}" fill="none" stroke="${escapeXml(series.color)}"`
          + ` stroke-width="${px(spec.lineWidth)}"/>`,
        );
      }

      if (spec.markers || points.length === 1) {
        for (const [x, py] of points) {
          marks.push(
            `<circle cx="${px(x)}" cy="${px(py)}" r="${px(radius)}"`
            + ` fill="${escapeXml(series.color)}"${halo}/>`,
          );
        }
      }
    }
  }

  if (pinned) {
    // The clip is a marker's reach larger than the plot area, so a point
    // sitting exactly on a limit keeps its whole dot.
    const reach = spec.kind === 'bar' ? 0 : spec.lineWidth * 2.5;
    out.push(
      `<defs><clipPath id="${clipId}"><rect x="${px(left - reach)}" y="${px(top - reach)}"`
      + ` width="${px(plotW + reach * 2)}" height="${px(plotH + reach * 2)}"/></clipPath></defs>`
      + `<g clip-path="url(#${clipId})">${marks.join('')}</g>`,
    );
  } else {
    out.push(...marks);
  }

  const key = legendLayout(spec, { left, top, plotRight, plotBottom, s });

  // A legend printed over filled bars is unreadable, and unlike a line a bar
  // cannot be seen through. With the top of the axis free, buy the legend its
  // room by adding steps above the data instead.
  if (
    key && spec.kind === 'bar' && spec.legend.startsWith('top') && spec.yMax === null
    && headroom < 8
    && bars.some((bar) => bar.x1 > key.x0 && bar.x0 < key.x1 && bar.top < key.y1)
  ) {
    return draw(spec, w, h, id, headroom + 1);
  }

  out.push(...legend(spec, key));

  // Block layout, like a shape: an inline SVG would sit on a text baseline.
  return `<svg width="100%" height="100%" viewBox="0 0 ${px(w)} ${px(h)}"`
    + ' preserveAspectRatio="none" style="display:block; overflow:visible">'
    + `${out.join('')}</svg>`;
}

/** A bar from the baseline to its value, rounded only at the value end. */
function barPath(
  x: number, base: number, width: number, end: number, radius: number, color: string,
): string {
  const r = Math.min(radius, width / 2, Math.abs(end - base));
  // Screen y grows downward, so a positive bar has `end` above `base`.
  const dir = end <= base ? 1 : -1;
  const d = `M${px(x)},${px(base)} L${px(x)},${px(end + dir * r)}`
    + ` Q${px(x)},${px(end)} ${px(x + r)},${px(end)}`
    + ` L${px(x + width - r)},${px(end)}`
    + ` Q${px(x + width)},${px(end)} ${px(x + width)},${px(end + dir * r)}`
    + ` L${px(x + width)},${px(base)} Z`;
  return `<path d="${d}" fill="${escapeXml(color)}"/>`;
}

interface LegendLayout {
  entries: PlotSpec['series'];
  /** Left edge of the swatches and the bounds of the whole block. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  swatch: number;
  labelGap: number;
  step: number;
  s: number;
}

/** Place the legend, or return null when there is nothing to list. */
function legendLayout(
  spec: PlotSpec,
  area: { left: number; top: number; plotRight: number; plotBottom: number; s: number },
): LegendLayout | null {
  const entries = spec.series.filter((series) => series.name.trim() !== '');

  if (spec.legend === 'none' || entries.length === 0) return null;

  const { s } = area;
  // Lines are keyed by a stroke, bars by a chip of their fill.
  const swatch = (spec.kind === 'bar' ? 18 : 40) * s;
  const labelGap = 10 * s;
  const step = 34 * s;
  const inset = 16 * s;
  const widest = Math.max(...entries.map((e) => estimateTextWidth(e.name, spec.textSize)));
  const x0 = spec.legend.endsWith('right')
    ? Math.max(area.left + inset, area.plotRight - inset - swatch - labelGap - widest)
    : area.left + inset;
  const y0 = spec.legend.startsWith('top')
    ? area.top + 28 * s
    : area.plotBottom - 28 * s - step * (entries.length - 1);
  return {
    entries, x0, x1: x0 + swatch + labelGap + widest, y0,
    y1: y0 + step * (entries.length - 1) + 14 * s, swatch, labelGap, step, s,
  };
}

function legend(spec: PlotSpec, layout: LegendLayout | null): string[] {
  if (!layout) return [];

  const { entries, x0, y0, swatch, labelGap, step, s } = layout;

  return entries.map((entry, index) => {
    const cy = y0 + index * step;
    const color = escapeXml(entry.color);
    const mark = spec.kind === 'bar'
      ? `<rect x="${px(x0)}" y="${px(cy - 9 * s)}" width="${px(swatch)}"`
        + ` height="${px(swatch)}" rx="${px(3 * s)}" fill="${color}"/>`
      : `<line x1="${px(x0)}" x2="${px(x0 + swatch)}" y1="${px(cy)}" y2="${px(cy)}"`
        + ` stroke="${color}" stroke-width="${px(spec.lineWidth + 1)}"/>`;
    return `${mark}<text x="${px(x0 + swatch + labelGap)}" y="${px(cy + 8 * s)}" fill="${color}"`
      + ` font-size="${px(spec.textSize)}">${escapeXml(entry.name)}</text>`;
  });
}
