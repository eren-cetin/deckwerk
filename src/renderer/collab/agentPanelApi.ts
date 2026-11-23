import type { AgentPanelState } from '@shared/ipc.js';
import type { AgentPanelApi } from '../editor/agentPanel.js';

export interface AgentPanelBrowserApi {
  api: AgentPanelApi;
  participantId: string;
  /** Reopen the state stream under the deck's current id (after a rename). */
  reconnect: () => void;
  close: () => void;
}

/**
 * Private browser transport for filesystem-bridge status and scratchpad.
 *
 * Args:
 *   deckId: The open deck's id, read whenever a URL is built, since a live
 *     rename changes it.
 */
export function createAgentPanelApi(deckId: () => string): AgentPanelBrowserApi {
  const participantId = browserParticipantId();
  const listeners = new Set<(state: AgentPanelState) => void>();
  const deckUrl = (path: string): string => {
    const url = new URL(path, location.origin);
    url.searchParams.set('deck', deckId());
    url.searchParams.set('participant', participantId);
    return url.href;
  };
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetch(deckUrl(path));
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error ?? `Agent panel request failed (${response.status})`);
    return value as T;
  };
  const open = (): EventSource => {
    const source = new EventSource(deckUrl('/api/agent-panel/events'));
    source.onmessage = (event) => {
      const state = JSON.parse(event.data) as AgentPanelState;
      for (const listener of listeners) listener(state);
    };
    return source;
  };
  let events = open();
  return {
    api: {
      getState: () => request('/api/agent-panel/state'),
      onState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    participantId,
    reconnect: () => {
      events.close();
      events = open();
    },
    close: () => events.close(),
  };
}

export function browserParticipantId(): string {
  const requested = new URLSearchParams(location.search).get('agentParticipant');
  if (requested && /^[a-zA-Z0-9_-]{8,80}$/.test(requested)) return requested;
  const storageKey = 'deckwerk.agent-panel-participant-id';
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing)) return existing;
    const created = newParticipantId();
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return newParticipantId();
  }
}

/**
 * A fresh participant id, without `crypto.randomUUID`.
 *
 * The invite the desktop app hands out is a LAN or tailscale address over
 * plain HTTP, and only `localhost` counts as a secure context: everywhere the
 * link is actually used, `crypto.randomUUID` is undefined. Calling it threw
 * inside the /api/config handler, which is the one that opens the session's
 * WebSocket — so the deck never arrived and the visitor sat in front of one
 * blank slide. `crypto.getRandomValues` is available on any origin.
 */
function newParticipantId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `participant-${hex}`;
}
