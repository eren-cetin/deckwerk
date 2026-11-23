import { applyTemplateToDeck } from '@shared/deckTemplates.js';
import type { CssEditor } from './cssEditor.js';
import type { OperationHandle } from './operationProgress.js';
import type { EditorStore } from './store.js';
import { confirmReplaceTemplate, showTemplateNameDialog, showTemplatePicker } from './templateDialogs.js';
import type { TemplateActions } from './themePanel.js';

/**
 * Save as Template and Apply Template, shared by the desktop and browser
 * shells. The template library itself sits behind `window.api` — IPC to the
 * main process on desktop, HTTP to the collab server in the browser — and the
 * stylesheet goes wherever the shell persists theme.css.
 */
export interface TemplateFlowDeps {
  store: EditorStore;
  cssEditor: CssEditor;
  setStatusMessage: (text: string) => void;
  runOperation: <T>(message: string, action: (operation: OperationHandle) => Promise<T>) => Promise<T>;
  /** Persist theme.css: to disk on desktop, to the room in the browser. */
  persistThemeCss: (css: string) => Promise<void> | void;
  /** The Design tab lists templates too; called after the library changed. */
  refreshTemplates: () => void;
}

export interface TemplateFlows {
  /** Keep this deck's design under a name. True once saved. */
  saveAsTemplate(): Promise<boolean>;
  /** Dress the open deck in a saved design; asks which unless `chosen` names one. */
  applyTemplate(chosen?: string): Promise<void>;
  /** What the Design tab's template list does with the library. */
  panelActions(): TemplateActions;
}

export function createTemplateFlows(deps: TemplateFlowDeps): TemplateFlows {
  const { store, cssEditor, setStatusMessage } = deps;

  async function saveAsTemplate(): Promise<boolean> {
    const { dir, deck } = store.get();
    if (!dir) {
      setStatusMessage('Open a presentation to save its design as a template');
      return false;
    }
    const name = await showTemplateNameDialog(deck.title);
    if (!name) return false;
    try {
      await cssEditor.flush();
      let result = await window.api.saveTemplate(name, store.get().deck, cssEditor.getValue());
      if (result.status === 'exists') {
        if (!(await confirmReplaceTemplate(name))) return false;
        result = await window.api.saveTemplate(name, store.get().deck, cssEditor.getValue(), true);
      }
      if (result.status !== 'saved') return false;
      setStatusMessage(`Saved template “${result.template.name}”`);
      deps.refreshTemplates();
      return true;
    } catch (err) {
      setStatusMessage(`Could not save the template: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * One undoable change. The stylesheet is set before the change lands, so
   * the theme block the editor writes for it goes into the new stylesheet.
   */
  async function applyTemplate(chosen?: string): Promise<void> {
    if (!store.get().dir) {
      setStatusMessage('Open a presentation to apply a template to it');
      return;
    }
    const id = chosen ?? await showTemplatePicker({
      heading: 'Apply template',
      actionLabel: 'Apply',
      detail: 'Every slide takes on the template’s theme; its layouts, page numbers and stylesheet rules '
        + 'join this deck. Undo puts the slides back; the stylesheet rules stay.',
    });
    // The picker can delete templates; the Design tab lists them too.
    if (!chosen) deps.refreshTemplates();
    if (!id) return;
    try {
      await deps.runOperation('Applying template…', async (operation) => {
        operation.update('Copying the template’s files');
        const template = await window.api.takeTemplate(id);
        operation.update(`Restyling slides with ${template.name}`);
        const before = cssEditor.getValue();
        const css = applyTemplateToDeck(structuredClone(store.get().deck), template, before);
        cssEditor.setValue(css);
        store.commit((deck) => {
          applyTemplateToDeck(deck, template, before);
        }, { label: `Apply template ${template.name}` });
        await deps.persistThemeCss(css);
        setStatusMessage(`Applied template “${template.name}”`);
      });
    } catch (err) {
      setStatusMessage(`Could not apply the template: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    saveAsTemplate,
    applyTemplate,
    panelActions: () => ({
      list: () => window.api.listTemplates(),
      save: () => saveAsTemplate(),
      apply: (id) => applyTemplate(id),
      // Feature-tested like the picker's Delete: the browser leaves it out
      // for people who may not change the server's shared library.
      ...(typeof window.api.deleteTemplate === 'function'
        ? { remove: (id: string) => window.api.deleteTemplate(id) }
        : {}),
    }),
  };
}
