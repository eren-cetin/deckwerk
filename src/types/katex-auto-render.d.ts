declare module 'katex/contrib/auto-render' {
  interface AutoRenderOptions {
    delimiters?: Array<{ left: string; right: string; display: boolean }>;
    throwOnError?: boolean;
    strict?: boolean | 'ignore' | 'warn' | 'error';
    macros?: Record<string, unknown>;
  }
  export default function renderMathInElement(
    element: HTMLElement,
    options?: AutoRenderOptions,
  ): void;
}
