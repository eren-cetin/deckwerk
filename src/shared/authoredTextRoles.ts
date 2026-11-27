import type { Deck, SlideElement, ThemeStyle } from './deck.js';
import { THEME_TEXT_PROPERTIES, effectiveThemeStyle, hexToRgb, type ThemeTextRole } from './themes.js';

/**
 * Putting text from a page an author wrote onto the deck's theme.
 *
 * A standalone authoring page owns its CSS, so the compile measures what its
 * browser computed and writes that onto every text box. Left there, each box
 * carries a complete copy of its typography and belongs to no role: the theme
 * can neither find it nor restyle it. This module gives such a box a role and
 * keeps only what genuinely differs from that role, as the box's overrides.
 */

type TextElement = Extract<SlideElement, { type: 'text' }>;
type AuthoredRole = Exclude<ThemeTextRole, 'base'>;

const ROLE_CLASS = /^role-(title|heading|body|caption|base)$/;
const HEADING_TAGS = /^h[2-6]$/;
const CAPTION_TAGS = /^(?:figcaption|caption|small|cite)$/;
/** How far a size may sit from a role's and still be taken for that role. */
const SIZE_TOLERANCE = 0.2;

/** What settling one text box found, for the author's report. */
export interface AuthoredTypeFinding {
  /** The role given to a box that named none, or null when it named one or none fits. */
  inferred: AuthoredRole | null;
  /** True when the box named no role and none could be inferred. */
  untagged: boolean;
  /** Theme-owned properties the box still sets for itself. */
  overrides: string[];
}

/** Return the role class a text box names, if any. */
function namedRole(element: TextElement): ThemeTextRole | null {
  const found = element.class.find((name) => ROLE_CLASS.test(name));
  return (found?.slice(5) as ThemeTextRole | undefined) ?? null;
}

function pixels(value: string | undefined): number | null {
  const match = /^(-?\d*\.?\d+)px$/.exec((value ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Infer the role of a text box that names none.
 *
 * Headings say what they are by their tag. Everything else is prose, and prose
 * is body or caption only when it is set near that role's size: a small label
 * inside a diagram is neither, and tagging it body would hand it the body size
 * the next time the theme is applied.
 */
function inferRole(tag: string, size: number | null, style: ThemeStyle): AuthoredRole | null {
  if (tag === 'h1') return 'title';
  if (HEADING_TAGS.test(tag)) return 'heading';
  if (CAPTION_TAGS.test(tag)) return 'caption';
  if (size === null) return 'body';

  const near = (role: AuthoredRole): boolean =>
    Math.abs(size - style.fonts[role].size) <= style.fonts[role].size * SIZE_TOLERANCE;
  if (near('body')) return 'body';

  return near('caption') ? 'caption' : null;
}

function familyKey(value: string): string {
  return value.replace(/["']/g, '').replace(/\s*,\s*/g, ',').trim().toLowerCase();
}

function rgbKey(value: string): string | null {
  const hex = hexToRgb(value);
  if (hex) return hex.join(',');

  const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (!match) return null;

  // A translucent colour is not the theme's opaque one, whatever its channels.
  if (match[4] !== undefined && !/^(?:1(?:\.0*)?|100%)$/.test(match[4])) return null;

  return `${Number(match[1])},${Number(match[2])},${Number(match[3])}`;
}

function weightNumber(value: string): number {
  if (value === 'normal') return 400;

  return value === 'bold' ? 700 : Number(value);
}

/** A length as pixels at `size`: the browser reports px, the theme writes em or px. */
function lengthAt(value: string, size: number): number | null {
  const text = value.trim();
  if (text === 'normal' || text === '0') return 0;

  const em = /^(-?\d*\.?\d+)em$/.exec(text);
  return em ? Number(em[1]) * size : pixels(text);
}

/** Whether a box's own declaration says exactly what its role already says. */
function repeatsTheme(
  property: string, value: string, role: ThemeTextRole, style: ThemeStyle, size: number,
): boolean {
  const font = style.fonts[role];
  switch (property) {
    case 'font-family': return familyKey(value) === familyKey(font.family);
    case 'font-weight': return weightNumber(value) === font.weight;
    case 'font-style': return value === 'normal';
    case 'font-size': {
      const own = pixels(value);
      return own !== null && Math.abs(own - font.size) < 0.6;
    }
    case 'line-height': {
      const own = pixels(value);
      if (own !== null) return Math.abs(own - font.lineHeight * size) < 0.6;

      return Math.abs(Number(value) - font.lineHeight) < 0.005;
    }
    case 'letter-spacing': {
      const own = lengthAt(value, size);
      const themed = lengthAt(font.letterSpacing, size);
      return own !== null && themed !== null && Math.abs(own - themed) < 0.3;
    }
    case 'color': {
      const own = rgbKey(value);
      return own !== null
        && own === rgbKey(font.color ?? (role === 'caption' ? style.colors.muted : style.colors.text));
    }
    default: return false;
  }
}

/**
 * Give an authored text box its role and drop the type that only repeats it.
 *
 * Args:
 *     element: A text element built from a standalone page; changed in place.
 *     tag: The HTML tag it was written as.
 *     deck: The deck it is going into, whose theme it is compared against.
 *
 * Returns:
 *     What was inferred and what the box still sets for itself.
 */
export function settleAuthoredType(element: TextElement, tag: string, deck: Deck): AuthoredTypeFinding {
  const style = effectiveThemeStyle(deck);
  const named = namedRole(element);
  const inferred = named === null ? inferRole(tag, pixels(element.style['font-size']), style) : null;
  const role = named ?? inferred;
  if (inferred) element.class = [...element.class, `role-${inferred}`];

  // The base role's size and leading come from the editor's own stylesheet,
  // not the theme, so there is nothing of the theme's to compare against.
  if (role === null || role === 'base') {
    return { inferred: null, untagged: role === null, overrides: [] };
  }

  // Leading and tracking are stored against the size the box was measured at.
  const size = pixels(element.style['font-size']) ?? style.fonts[role].size;
  const kept: Record<string, string> = {};
  for (const [property, value] of Object.entries(element.style)) {
    if (!repeatsTheme(property, value, role, style, size)) kept[property] = value;
  }
  element.style = kept;
  const overrides = THEME_TEXT_PROPERTIES.filter((property) => kept[property] !== undefined);
  if (overrides.length > 0) element.overrides = overrides;

  return { inferred, untagged: false, overrides };
}

/**
 * Word what a section's text findings mean for whoever wrote the page.
 *
 * Args:
 *     section: The section's 1-based position in the page.
 *     findings: One finding per text box that was settled.
 *
 * Returns:
 *     Warning lines; none when every box named a role and follows it.
 */
export function authoredTypeWarnings(section: number, findings: AuthoredTypeFinding[]): string[] {
  const warnings: string[] = [];
  const inferred = findings.filter((finding) => finding.inferred !== null);
  const untagged = findings.filter((finding) => finding.untagged);
  const overriding = findings.filter((finding) => finding.overrides.length > 0);
  if (inferred.length > 0) {
    const roles = [...new Set(inferred.map((finding) => finding.inferred))].join(', ');
    warnings.push(`Section ${section}: ${inferred.length} text box(es) named no role and were given one `
      + `from their tag or size (${roles}). Say it yourself with a role-title/-heading/-body/-caption `
      + 'class, or use a data-layout-slot.');
  }

  if (untagged.length > 0) {
    warnings.push(`Section ${section}: ${untagged.length} text box(es) have no role and fit none by size, `
      + 'so the theme cannot style them. Give them a role-* class if they are slide text.');
  }

  if (overriding.length > 0) {
    const properties = [...new Set(overriding.flatMap((finding) => finding.overrides))].join(', ');
    warnings.push(`Section ${section}: ${overriding.length} text box(es) set their own ${properties} `
      + 'instead of following the theme, and the next theme change replaces them. Drop the declaration '
      + 'to follow the role; change the theme if the role itself should look different.');
  }

  return warnings;
}
