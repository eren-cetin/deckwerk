import type { Deck } from '@shared/deck.js';
import type { DeckTemplate } from '@shared/deckTemplates.js';
import type {
  AssetImportProgress, ImportedAsset, MediaInfo, TemplateSaveResult, TemplateSummary,
} from '@shared/ipc.js';
import { clipboardImageName, type ClipboardImageSource } from '@shared/clipboardImages.js';

/**
 * The browser collab client's stand-in for the Electron preload bridge.
 *
 * Only the surface the reused editor components actually touch is real:
 * assets resolve to the collab server's deck-scoped HTTP routes, drops upload
 * bytes, and theme saves go to the WebSocket (injected by the shell).
 * Everything else on the full Api type is desktop-only and intentionally
 * absent — the collab shell never calls it, and shared code paths feature-test
 * with optional chaining.
 */
export interface NetApiOptions {
  /** The open deck's id, read on every call: a live rename changes it. */
  deckId: () => string;
  saveTheme: (css: string) => void;
}

const progressListeners = new Set<(p: AssetImportProgress) => void>();

function emitProgress(p: AssetImportProgress): void {
  for (const fn of progressListeners) fn(p);
}

/**
 * XHR rather than fetch: only XHR exposes upload progress. Once the bytes are
 * up, the server hashes/copies/transcodes before responding — that stretch is
 * reported as an indeterminate 'processing' phase.
 */
function uploadFile(deck: string, file: File, token?: string): Promise<ImportedAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?deck=${deck}&name=${encodeURIComponent(file.name)}`);
    xhr.responseType = 'json';
    if (token) {
      xhr.upload.addEventListener('progress', (e) => {
        emitProgress({
          token,
          phase: 'upload',
          ratio: e.lengthComputable ? e.loaded / e.total : null,
        });
      });
      xhr.upload.addEventListener('load', () =>
        emitProgress({ token, phase: 'processing', ratio: null }),
      );
    }
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as ImportedAsset);
      } else {
        const body = xhr.response as { error?: string } | null;
        reject(new Error(body?.error ?? `upload failed (${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('upload failed (network)')));
    xhr.send(file);
  });
}

export function installNetApi(options: NetApiOptions): void {
  const deck = (): string => encodeURIComponent(options.deckId());
  const api = {
    assetUrl: (src: string): string =>
      `/decks/${deck()}/${src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`,

    importAssetFiles: async (files: File[], progressToken?: string): Promise<ImportedAsset[]> => {
      const imported: ImportedAsset[] = [];
      for (const file of files) {
        imported.push(await uploadFile(deck(), file, progressToken));
      }
      return imported;
    },

    /**
     * Import an image a drag only pointed at. A `data:` payload is already
     * bytes and uploads like any drop; a remote URL is fetched by the server,
     * which is both the only party that can reach it without CORS and the one
     * that guards against a client aiming the fetcher at its own network.
     */
    importImageUrl: async (source: ClipboardImageSource): Promise<ImportedAsset | null> => {
      try {
        if (source.kind === 'data') {
          const binary = atob(source.base64);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          const name = clipboardImageName(source.mime) ?? 'Pasted image.png';
          return await uploadFile(deck(), new File([bytes], name, { type: source.mime }));
        }
        const response = await fetch(`/api/import-url?deck=${deck()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: source.url }),
        });
        if (!response.ok) return null;
        return await response.json() as ImportedAsset;
      } catch (err) {
        console.error('Could not import the dropped image:', err);
        return null;
      }
    },

    onAssetImportProgress: (fn: (p: AssetImportProgress) => void): (() => void) => {
      progressListeners.add(fn);
      return () => progressListeners.delete(fn);
    },

    // The drop handler prefers importAssetFiles; these exist so shared code
    // that feature-tests them degrades quietly.
    importAssets: async (): Promise<ImportedAsset[]> => [],
    pathForFile: (): string => '',

    probeAsset: async (src: string): Promise<MediaInfo> => {
      const response = await fetch(`/api/probe?deck=${deck()}&src=${encodeURIComponent(src)}`);
      if (!response.ok) return { width: null, height: null, duration: null };
      return response.json() as Promise<MediaInfo>;
    },

    loadTheme: async (): Promise<string> => {
      const response = await fetch(`/api/theme?deck=${deck()}`);
      return response.ok ? response.text() : '';
    },
    saveTheme: async (css: string): Promise<void> => {
      options.saveTheme(css);
    },

    // Persistence belongs to the server; edits reach it as transactions.
    saveDeck: async (): Promise<void> => {},
  };

  (window as unknown as { api: typeof api }).api = api;
}

async function templateRequest<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch(path, { method });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || body === null) throw new Error(body?.error ?? `template request failed (${response.status})`);
  return body;
}

/**
 * The template library, over the collab server's /api/templates routes, in
 * the shape the desktop preload gives it — so the shared template dialogs and
 * flows (templateDialogs.ts, templateActions.ts) run unchanged. Installed once
 * the server's config says it keeps templates, which a hosted session does
 * not. Without a deck (the picker page) only listing is offered, and
 * `deleteTemplate` exists only for someone allowed to change the library:
 * the shared code feature-tests it to decide whether to offer Delete.
 */
export function installTemplateApi(options: { deckId: (() => string) | null; canManage: boolean }): void {
  const target = ((window as unknown as { api?: Record<string, unknown> }).api ??= {});
  target.listTemplates = (): Promise<TemplateSummary[]> => templateRequest('/api/templates');
  const deckId = options.deckId;
  if (deckId !== null) {
    // Read per call: a live rename moves the open deck to another id.
    const deck = (): string => encodeURIComponent(deckId());
    // The server saves from its live room, which holds everyone's edits, so
    // the deck and stylesheet this side would send are not needed.
    target.saveTemplate = (name: string, _deck: Deck, _css: string, replace = false): Promise<TemplateSaveResult> =>
      templateRequest(
        `/api/templates?deck=${deck()}&name=${encodeURIComponent(name)}${replace ? '&replace=1' : ''}`,
        'POST',
      );
    target.takeTemplate = (id: string): Promise<DeckTemplate> =>
      templateRequest(`/api/templates/take?deck=${deck()}&id=${encodeURIComponent(id)}`, 'POST');
  }
  if (options.canManage) {
    target.deleteTemplate = async (id: string): Promise<void> => {
      await templateRequest(`/api/templates?id=${encodeURIComponent(id)}`, 'DELETE');
    };
  }
}
