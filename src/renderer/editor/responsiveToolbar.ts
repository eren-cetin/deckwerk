const LAYOUT_CLASSES = [
  'toolbar-short-deck-path',
  'toolbar-hide-deck-name',
  'toolbar-compact-file',
  'toolbar-compact-secondary',
  'toolbar-icons-only',
  'toolbar-hide-brand',
] as const;

const COLLISION_GAP = 8;

function visibleWidth(element: HTMLElement): number {
  return element.getBoundingClientRect().width;
}

function centeredGroupsFit(toolbar: HTMLElement): boolean {
  const left = toolbar.querySelector<HTMLElement>(':scope > .bar-group:first-child');
  const center = toolbar.querySelector<HTMLElement>(':scope > .bar-center');
  const right = toolbar.querySelector<HTMLElement>(':scope > .bar-right');
  if (!left || !center || !right) return true;

  const leftBox = left.getBoundingClientRect();
  const centerBox = center.getBoundingClientRect();
  const rightBox = right.getBoundingClientRect();
  // The desktop welcome screen hides the deck-only center and right groups.
  // Leave its New/Open/Import controls expanded; there is nothing to collide
  // with, and the compact File control is deck-only as well.
  if (centerBox.width === 0 || rightBox.width === 0) return true;
  return leftBox.right + COLLISION_GAP <= centerBox.left
    && centerBox.right + COLLISION_GAP <= rightBox.left;
}

function flowingGroupsFit(toolbar: HTMLElement): boolean {
  const groups = [...toolbar.querySelectorAll<HTMLElement>(':scope > .bar-group')];
  const style = getComputedStyle(toolbar);
  const available = toolbar.clientWidth
    - Number.parseFloat(style.paddingLeft || '0')
    - Number.parseFloat(style.paddingRight || '0');
  const gaps = Math.max(0, groups.length - 1) * COLLISION_GAP;
  return groups.reduce((sum, group) => sum + visibleWidth(group), gaps) <= available;
}

/** Narrower than this, the path is not worth showing beside the folder's name. */
const MIN_DECK_PATH = 160;

/**
 * Give the deck's folder path the room left of the centred Insert group, so
 * it trims its leading folders rather than disappearing. False when there is
 * too little room for that to be worth it.
 */
function fitDeckPath(toolbar: HTMLElement): boolean {
  const label = toolbar.querySelector<HTMLElement>('.bar-deck-name');
  const left = toolbar.querySelector<HTMLElement>(':scope > .bar-group:first-child');
  const center = toolbar.querySelector<HTMLElement>(':scope > .bar-center');
  if (!label || label.hidden || !left || !center) return false;
  const centerBox = center.getBoundingClientRect();
  if (centerBox.width === 0) return false;
  const overlap = left.getBoundingClientRect().right + COLLISION_GAP - centerBox.left;
  const room = label.getBoundingClientRect().width - overlap;
  if (room < MIN_DECK_PATH) return false;
  label.style.maxWidth = `${Math.floor(room)}px`;
  return centeredGroupsFit(toolbar);
}

/** Recompute the compactness immediately; exported for deterministic UI tests. */
export function refreshResponsiveToolbar(toolbar: HTMLElement): void {
  toolbar.classList.remove(...LAYOUT_CLASSES);
  const label = toolbar.querySelector<HTMLElement>('.bar-deck-name');
  if (label) label.style.maxWidth = '';

  if (centeredGroupsFit(toolbar)) return;
  if (fitDeckPath(toolbar)) return;
  if (label) label.style.maxWidth = '';
  // The deck's folder gives up the path leading to it before its name.
  toolbar.classList.add('toolbar-short-deck-path');
  if (centeredGroupsFit(toolbar)) return;
  toolbar.classList.add('toolbar-hide-deck-name');
  if (centeredGroupsFit(toolbar)) return;

  // The File menu is the only file control at any width (editor.css); this
  // stage only trades the centred Insert group for a grid that keeps the
  // three groups from touching.
  toolbar.classList.add('toolbar-compact-file');
  if (flowingGroupsFit(toolbar)) return;

  toolbar.classList.add('toolbar-compact-secondary');
  if (flowingGroupsFit(toolbar)) return;

  // Half a laptop screen (macOS Split View): Insert keeps its icons, which
  // carry their names as tooltips, and then the wordmark steps aside; About
  // stays in the application menu.
  toolbar.classList.add('toolbar-icons-only');
  if (flowingGroupsFit(toolbar)) return;
  toolbar.classList.add('toolbar-hide-brand');
}

/**
 * Keep the three toolbar groups apart as their labels and the window change.
 *
 * The wide layout deliberately centers Insert independently of the side
 * groups, so CSS alone cannot know when those groups have reached it. Measure
 * the real controls, progressively compact them, and only give up strict
 * centering once the file controls need to become a menu.
 */
export function installResponsiveToolbar(toolbar: HTMLElement): () => void {
  let frame = 0;
  const refresh = (): void => {
    frame = 0;
    refreshResponsiveToolbar(toolbar);
  };
  const schedule = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(refresh);
  };

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(toolbar);
  for (const group of toolbar.querySelectorAll<HTMLElement>(':scope > .bar-group')) {
    observer?.observe(group);
  }
  schedule();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    observer?.disconnect();
  };
}
