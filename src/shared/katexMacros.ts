/**
 * TeX macros every KaTeX render in the app uses, so a formula reads the same
 * on the canvas, while presenting, in speaker notes and in an exported page.
 */

/** The part of KaTeX's macro context `mathbbMacro` reads. */
interface MacroContext {
  consumeArgs(count: number): Array<Array<{ text: string }>>;
}

/**
 * `\mathbb` that also draws digits and lowercase letters double-struck.
 *
 * KaTeX's AMS font has blackboard capitals only, so `\mathbb{1}` (the
 * indicator function) silently drew a plain 1. Those characters are spelled
 * as their Unicode code points instead (U+1D7D8 𝟘 … and U+1D552 𝕒 …), which
 * the bundled DeckWerk Double-Struck face draws (see katexDoubleStruck.css);
 * everything else is handed back to KaTeX's own `\Bbb`, an alias of the
 * original `\mathbb` that this macro does not intercept. `k` stays with KaTeX,
 * whose font does have it.
 *
 * Self-contained (no captures) because it is serialised into the exported
 * authoring page next to `renderAuthoredMath`.
 */
export function mathbbMacro(context: MacroContext): string {
  // KaTeX hands an argument's tokens over last-first.
  const tokens = context.consumeArgs(1)[0].map((token) => token.text).reverse();
  let out = '';
  let rest: string[] = [];
  const flush = () => {
    if (rest.length > 0) out += '\\Bbb{' + rest.join(' ') + '}';
    rest = [];
  };
  for (const text of tokens) {
    if (/^[0-9]$/.test(text)) {
      flush();
      out += String.fromCodePoint(0x1d7d8 + Number(text));
    } else if (/^[a-z]$/.test(text) && text !== 'k') {
      flush();
      out += String.fromCodePoint(0x1d552 + text.charCodeAt(0) - 97);
    } else {
      rest.push(text);
    }
  }
  flush();
  return out;
}

/**
 * A fresh macro table for one render. Fresh because KaTeX writes `\gdef`
 * definitions into the table it is given, and one formula's definitions must
 * not leak into another slide's.
 */
export function katexMacros(): Record<string, typeof mathbbMacro> {
  return { '\\mathbb': mathbbMacro };
}
