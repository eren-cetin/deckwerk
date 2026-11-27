import type { Deck, PlotSpec } from '@shared/deck.js';
import { PLOT_LEGEND_POSITIONS } from '@shared/deck.js';
import { parseDelimitedRows } from '@shared/paragraphs.js';
import {
  PLOT_DEFAULT_SIZE, PLOT_LEGEND_LABELS, parsePlotNumber, plotDataFromGrid, plotDelimiter, plotGrid, plotGridFromCells,
  plotSeriesColor, type PlotGrid,
} from '@shared/plot.js';
import { plotSvg } from '@shared/plotSvg.js';
import { effectiveThemeStyle } from '@shared/themes.js';
import { colorField } from './colorPicker.js';
import { checkboxField, numberField, segmentedSelectField, selectField } from './inspector.js';
import { button, openDialog } from './templateDialogs.js';
import { closePopover } from './ui.js';

/**
 * The plot dialog: a small spreadsheet for the data, the handful of options a
 * plot has, and a live preview drawn by the same builder the slide uses. It
 * serves both inserting a plot and editing one, and works on a private copy —
 * nothing reaches the deck until the dialog is confirmed.
 */

const LINE_GLYPH =
  '<path d="M2 12.5 6 7l3.2 2.6L14 3.5" fill="none" stroke="currentColor" stroke-width="1.5"'
  + ' stroke-linecap="round" stroke-linejoin="round"/>';
const BAR_GLYPH =
  '<path d="M3.5 13.5v-5M8 13.5v-10M12.5 13.5v-7" fill="none" stroke="currentColor"'
  + ' stroke-width="2.4" stroke-linecap="round"/>';

/** The most rows and series the grid will grow to; the schema allows more. */
const MAX_ROWS = 500;
const MAX_SERIES = 12;

export interface PlotDialogOptions {
  /** Whether the dialog creates a plot or changes an existing one. */
  mode: 'insert' | 'edit';
  /** The box the preview is drawn for; the insert size when omitted. */
  size?: { w: number; h: number };
}

function textField(label: string, value: string, onInput: (value: string) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.spellcheck = false;
  input.addEventListener('input', () => onInput(input.value));
  wrap.append(span, input);
  return wrap;
}

/** A number field whose blank state means "fit the data". */
function limitField(
  label: string, value: number | null, onInput: (value: number | null) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-number';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  input.placeholder = 'auto';
  input.value = value === null ? '' : String(value);
  input.addEventListener('input', () => {
    const parsed = input.value.trim() === '' ? null : Number(input.value);
    onInput(parsed !== null && Number.isFinite(parsed) ? parsed : null);
  });
  wrap.append(span, input);
  return wrap;
}

function heading(text: string): HTMLElement {
  const element = document.createElement('h3');
  element.className = 'plot-dialog-heading';
  element.textContent = text;
  return element;
}

/**
 * Open the plot dialog.
 *
 * Args:
 *     deck: The deck the plot belongs to; its theme dresses the preview.
 *     initial: The plot to start from.
 *     options: Whether this inserts or edits, and the preview size.
 *
 * Returns:
 *     The confirmed plot, or null when the dialog was cancelled.
 */
export function openPlotDialog(
  deck: Deck,
  initial: PlotSpec,
  options: PlotDialogOptions,
): Promise<PlotSpec | null> {
  return new Promise((resolve) => {
    const cancelDialog = () => {
      closePopover();
      resolve(null);
    };
    const { overlay, dialog, actions, finishWith } = openDialog(
      'plot-dialog', options.mode === 'insert' ? 'Insert plot' : 'Edit plot', cancelDialog,
    );
    const spec: PlotSpec = structuredClone(initial);
    const grid: PlotGrid = plotGrid(spec);
    const colors: string[] = spec.series.map((series) => series.color);
    const size = options.size ?? PLOT_DEFAULT_SIZE;
    const theme = effectiveThemeStyle(deck);

    if (grid.rows.length === 0) grid.rows.push(['', ...grid.names.map(() => '')]);

    const body = document.createElement('div');
    body.className = 'plot-dialog-body';
    const dataPane = document.createElement('div');
    dataPane.className = 'plot-dialog-data';
    const sidePane = document.createElement('div');
    sidePane.className = 'plot-dialog-side';
    body.append(dataPane, sidePane);

    // --- Preview ---------------------------------------------------------
    const preview = document.createElement('div');
    preview.className = 'plot-dialog-preview';
    preview.style.background = theme.colors.background;
    preview.style.color = theme.colors.text;
    preview.style.fontFamily = theme.fonts.base.family;
    preview.style.aspectRatio = `${size.w} / ${size.h}`;
    preview.setAttribute('role', 'img');
    preview.setAttribute('aria-label', 'Plot preview');

    const insert = button(options.mode === 'insert' ? 'Insert' : 'Apply', true);
    const current = (): PlotSpec => ({ ...spec, ...plotDataFromGrid(grid, colors) });
    const refresh = () => {
      const next = current();
      preview.innerHTML = plotSvg(next, size.w, size.h, 'dialog-preview');
      insert.disabled = next.series.length === 0 || next.xValues.length === 0;
    };

    // --- Data grid -------------------------------------------------------
    const table = document.createElement('table');
    table.className = 'plot-grid';
    const scroller = document.createElement('div');
    scroller.className = 'plot-grid-scroll';
    scroller.appendChild(table);

    const cellInput = (row: number, column: number): HTMLInputElement | null =>
      table.querySelector<HTMLInputElement>(`input[data-row="${row}"][data-column="${column}"]`);
    const focusCell = (row: number, column: number) => {
      const input = cellInput(row, column);
      input?.focus();
      input?.select();
    };
    const addRow = () => {
      if (grid.rows.length >= MAX_ROWS) return false;

      grid.rows.push(['', ...grid.names.map(() => '')]);
      return true;
    };
    const addSeries = () => {
      if (grid.names.length >= MAX_SERIES) return false;

      grid.names.push(`Series ${grid.names.length + 1}`);
      colors.push(plotSeriesColor(colors.length));
      for (const row of grid.rows) row.push('');

      return true;
    };

    /** Write a block of pasted cells into the grid, growing it to fit. */
    const pasteBlock = (cells: string[][], row: number, column: number) => {
      let block = cells;
      const whole = column === 0 ? plotGridFromCells(cells) : null;

      // A block that brings its own header row names the series it covers.
      if (whole && cells[0].slice(1).some((cell) => cell.trim() !== '' && parsePlotNumber(cell) === null)) {
        whole.names.forEach((name, index) => {
          while (grid.names.length <= index && addSeries());

          if (index < grid.names.length) grid.names[index] = name;
        });
        block = whole.rows;
      }

      block.forEach((cellsInRow, r) => {
        while (grid.rows.length <= row + r && addRow());

        cellsInRow.forEach((cell, c) => {
          while (grid.names.length < column + c && addSeries());

          const target = grid.rows[row + r];

          if (target && column + c <= grid.names.length) target[column + c] = cell.trim();
        });
      });
    };

    const renderGrid = () => {
      table.replaceChildren();
      const head = table.createTHead().insertRow();
      const corner = document.createElement('th');
      corner.className = 'plot-grid-corner';
      corner.textContent = spec.kind === 'bar' ? 'Category' : 'x';
      head.appendChild(corner);
      grid.names.forEach((name, column) => {
        const th = document.createElement('th');
        const cell = document.createElement('div');
        cell.className = 'plot-grid-series';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = name;
        input.spellcheck = false;
        input.placeholder = `Series ${column + 1}`;
        input.setAttribute('aria-label', `Series ${column + 1} name`);
        input.addEventListener('input', () => {
          grid.names[column] = input.value;
          refresh();
        });
        const color = colorField(`Series ${column + 1} colour`, colors[column], (value) => {
          colors[column] = value ?? plotSeriesColor(column);
          refresh();

          // Clearing falls back to the cycle; show the swatch it fell back to.
          if (value === null) renderGrid();
        }, { clear: { kind: 'none', label: 'Default colour' } });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'plot-grid-remove';
        remove.textContent = '×';
        remove.title = 'Remove series';
        remove.setAttribute('aria-label', `Remove series ${column + 1}`);
        remove.disabled = grid.names.length <= 1;
        remove.addEventListener('click', () => {
          grid.names.splice(column, 1);
          colors.splice(column, 1);
          for (const row of grid.rows) row.splice(column + 1, 1);

          renderGrid();
          refresh();
        });
        cell.append(color, input, remove);
        th.appendChild(cell);
        head.appendChild(th);
      });
      head.appendChild(document.createElement('th'));

      const tbody = table.createTBody();
      grid.rows.forEach((cells, row) => {
        const tr = tbody.insertRow();
        for (let column = 0; column <= grid.names.length; column += 1) {
          const td = tr.insertCell();
          const input = document.createElement('input');
          input.type = 'text';
          input.inputMode = column === 0 && spec.kind === 'bar' ? 'text' : 'decimal';
          input.value = cells[column] ?? '';
          input.spellcheck = false;
          input.dataset.row = String(row);
          input.dataset.column = String(column);
          input.setAttribute(
            'aria-label',
            column === 0 ? `Row ${row + 1} x` : `Row ${row + 1}, ${grid.names[column - 1] || `series ${column}`}`,
          );
          input.addEventListener('input', () => {
            cells[column] = input.value;
            refresh();
          });
          td.appendChild(input);
        }

        const tail = tr.insertCell();
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'plot-grid-remove';
        remove.textContent = '×';
        remove.title = 'Remove row';
        remove.setAttribute('aria-label', `Remove row ${row + 1}`);
        remove.tabIndex = -1;
        remove.disabled = grid.rows.length <= 1;
        remove.addEventListener('click', () => {
          grid.rows.splice(row, 1);
          renderGrid();
          refresh();
        });
        tail.appendChild(remove);
      });
    };

    // Spreadsheet movement: Enter and the vertical arrows walk rows; the
    // horizontal arrows leave a cell only from the end of its text.
    table.addEventListener('keydown', (event) => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;

      if (!input?.dataset.row || event.isComposing) return;

      const row = Number(input.dataset.row);
      const column = Number(input.dataset.column);
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const atEnd = input.selectionStart === input.value.length
        && input.selectionEnd === input.value.length;

      if (event.key === 'Enter' || event.key === 'ArrowDown') {
        event.preventDefault();

        if (row === grid.rows.length - 1 && event.key === 'Enter' && addRow()) renderGrid();

        focusCell(Math.min(row + 1, grid.rows.length - 1), column);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusCell(Math.max(0, row - 1), column);
      } else if (event.key === 'ArrowLeft' && atStart && column > 0) {
        event.preventDefault();
        focusCell(row, column - 1);
      } else if (event.key === 'ArrowRight' && atEnd && column < grid.names.length) {
        event.preventDefault();
        focusCell(row, column + 1);
      }
    });
    table.addEventListener('paste', (event) => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      const text = event.clipboardData?.getData('text/plain') ?? '';

      // One value pastes into its cell as text always does.
      if (!input?.dataset.row || !/[\t\n\r]/.test(text.trim())) return;

      event.preventDefault();
      const row = Number(input.dataset.row);
      const column = Number(input.dataset.column);
      pasteBlock(parseDelimitedRows(text, plotDelimiter(text)), row, column);
      renderGrid();
      refresh();
      focusCell(row, column);
    });

    const gridActions = document.createElement('div');
    gridActions.className = 'plot-grid-actions';
    const addRowButton = button('Add row');
    addRowButton.addEventListener('click', () => {
      if (!addRow()) return;

      renderGrid();
      focusCell(grid.rows.length - 1, 0);
    });
    const addSeriesButton = button('Add series');
    addSeriesButton.addEventListener('click', () => {
      if (!addSeries()) return;

      renderGrid();
      refresh();
    });
    const pasteHint = document.createElement('span');
    pasteHint.className = 'plot-grid-hint';
    pasteHint.textContent = 'Paste cells from a spreadsheet or CSV into the grid. Blank cells are skipped.';
    gridActions.append(addRowButton, addSeriesButton, pasteHint);

    const kindField = segmentedSelectField('Type', [
      { value: 'line', title: 'Line plot', icon: LINE_GLYPH, text: 'Line' },
      { value: 'bar', title: 'Bar plot', icon: BAR_GLYPH, text: 'Bars' },
    ], spec.kind, (value) => {
      spec.kind = value as PlotSpec['kind'];
      renderGrid();
      syncKind();
      refresh();
    });
    dataPane.append(kindField, heading('Data'), scroller, gridActions);

    // --- Options ---------------------------------------------------------
    const labels = document.createElement('div');
    labels.className = 'field-grid field-grid-2';
    labels.append(
      textField('X label', spec.xLabel, (value) => { spec.xLabel = value; refresh(); }),
      textField('Y label', spec.yLabel, (value) => { spec.yLabel = value; refresh(); }),
    );
    const axes = document.createElement('div');
    axes.className = 'field-grid';
    const xMin = limitField('X min', spec.xMin, (value) => { spec.xMin = value; refresh(); });
    const xMax = limitField('X max', spec.xMax, (value) => { spec.xMax = value; refresh(); });
    axes.append(
      limitField('Y min', spec.yMin, (value) => { spec.yMin = value; refresh(); }),
      limitField('Y max', spec.yMax, (value) => { spec.yMax = value; refresh(); }),
      xMin, xMax,
    );
    const style = document.createElement('div');
    style.className = 'field-grid plot-dialog-style';
    const legendLabels = PLOT_LEGEND_POSITIONS.map((position) => PLOT_LEGEND_LABELS[position]);
    const lineWidth = numberField('Line width', spec.lineWidth, (value) => {
      spec.lineWidth = Math.min(24, Math.max(0.5, value));
      refresh();
    }, { step: 0.5 });
    style.append(
      selectField('Legend', legendLabels, PLOT_LEGEND_LABELS[spec.legend], (value) => {
        spec.legend = PLOT_LEGEND_POSITIONS[legendLabels.indexOf(value)] ?? 'top-right';
        refresh();
      }),
      numberField('Text size', spec.textSize, (value) => {
        spec.textSize = Math.min(120, Math.max(6, value));
        refresh();
      }),
      lineWidth,
    );
    const toggles = document.createElement('div');
    toggles.className = 'plot-dialog-toggles';
    const markers = checkboxField('Point markers', spec.markers, (value) => {
      spec.markers = value;
      refresh();
    });
    toggles.append(
      checkboxField('Grid lines', spec.grid, (value) => { spec.grid = value; refresh(); }),
      markers,
    );
    const inks = document.createElement('div');
    inks.className = 'field-grid plot-dialog-inks';
    const ink = (label: string, key: 'title' | 'axis' | 'grid') =>
      colorField(label, spec.colors[key], (value) => {
        spec.colors[key] = value;
        refresh();
      }, { clear: { kind: 'theme', label: 'Follow the slide' } });
    inks.append(ink('Title', 'title'), ink('Labels', 'axis'), ink('Grid', 'grid'));

    // Controls that mean nothing for bars are disabled rather than hidden,
    // so the dialog does not reflow when the type changes.
    const syncKind = () => {
      const bars = spec.kind === 'bar';
      for (const field of [xMin, xMax, lineWidth, markers]) {
        field.classList.toggle('is-disabled', bars);
        for (const control of field.querySelectorAll<HTMLInputElement>('input')) control.disabled = bars;
      }
    };

    sidePane.append(
      preview,
      textField('Title', spec.title, (value) => { spec.title = value; refresh(); }),
      labels, heading('Axes'), axes, heading('Style'), style, toggles, inks,
    );

    const cancel = button('Cancel');
    actions.append(cancel, insert);
    dialog.append(body, actions);
    document.body.appendChild(overlay);

    cancel.addEventListener('click', () => finishWith(cancelDialog));
    insert.addEventListener('click', () => {
      const result = current();
      finishWith(() => {
        closePopover();
        resolve(result);
      });
    });

    renderGrid();
    syncKind();
    refresh();
    focusCell(0, 0);
  });
}
