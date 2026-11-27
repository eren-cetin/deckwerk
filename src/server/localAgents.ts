import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentPanelMessage, AgentPanelState } from '../shared/ipc.js';

/** Connection/activity state for user-owned filesystem agents. */
const MESSAGE_LIMIT = 200;

export interface LocalAgentLink {
  clientId: string;
  name: string;
  connectedAt: string;
}

export interface LocalAgentEvent {
  text: string;
  busy?: boolean;
  error?: boolean;
}

interface ParticipantAgent {
  /** Every bridge attached under this participant, oldest first; one person may run several agents. */
  links: Map<string, LocalAgentLink>;
  messages: AgentPanelMessage[];
  scratchpad: AgentPanelState['scratchpad'];
  busy: boolean;
  activity: string | null;
}

/**
 * The server never runs an agent. It only reports whether a participant's
 * slide-agent filesystem bridge is attached, what it is doing, and the latest
 * compile preview available in that participant's scratchpad.
 */
export class LocalAgentRegistry {
  readonly name: string;
  private readonly agents = new Map<string, ParticipantAgent>();
  private readonly listeners = new Set<(state: AgentPanelState, participantId: string) => void>();

  constructor(options: { name?: string } = {}) {
    this.name = options.name?.trim() || 'Your agent';
  }

  attach(deckPath: string, participantId: string, link: LocalAgentLink): AgentPanelState {
    const agent = this.agent(deckPath, participantId);
    agent.links.delete(link.clientId);
    agent.links.set(link.clientId, link);
    agent.busy = false;
    agent.activity = null;
    this.note(agent, 'system', `${link.name} connected and mirrored the deck.`);
    return this.emit(deckPath, participantId);
  }

  detach(deckPath: string, participantId: string, clientId: string): AgentPanelState | null {
    const agent = this.agents.get(key(deckPath, participantId));
    const link = agent?.links.get(clientId);
    if (!agent || !link) return null;
    agent.links.delete(clientId);
    if (agent.links.size === 0) {
      agent.busy = false;
      agent.activity = null;
    }

    const name = link.name;
    this.note(agent, 'system', `${name} disconnected.`);
    return this.emit(deckPath, participantId);
  }

  event(deckPath: string, participantId: string, event: LocalAgentEvent): AgentPanelState {
    const agent = this.agent(deckPath, participantId);
    agent.busy = event.busy ?? false;
    agent.activity = agent.busy ? event.text : null;
    this.note(agent, 'assistant', event.text, event.error);
    return this.emit(deckPath, participantId);
  }

  /** Return the most recently attached bridge for a participant, if any is attached. */
  linked(deckPath: string, participantId: string): LocalAgentLink | null {
    const links = this.agents.get(key(deckPath, participantId))?.links;
    return links && links.size > 0 ? [...links.values()].at(-1)! : null;
  }

  async getState(deckPath: string, participantId: string): Promise<AgentPanelState> {
    return this.state(deckPath, participantId);
  }

  setScratchpad(
    deckPath: string,
    participantId: string,
    scratchpad: AgentPanelState['scratchpad'],
  ): AgentPanelState {
    this.agent(deckPath, participantId).scratchpad = scratchpad;
    return this.emit(deckPath, participantId);
  }

  chatId(deckPath: string, participantId: string): string | null {
    return this.linked(deckPath, participantId) ? `local-agent:${participantId}` : null;
  }

  /**
   * Carry every participant's agent state over to a deck folder's new path
   * after a live rename, so a bridge that reconnects or reports activity finds
   * its history where it left it.
   */
  relocate(fromPath: string, toPath: string): void {
    const prefix = key(fromPath, '');
    const moved: string[] = [];
    for (const [k, agent] of [...this.agents]) {
      if (!k.startsWith(prefix)) continue;
      const participantId = k.slice(prefix.length);
      this.agents.delete(k);
      this.agents.set(key(toPath, participantId), agent);
      moved.push(participantId);
    }
    for (const participantId of moved) this.emit(toPath, participantId);
  }

  subscribe(listener: (state: AgentPanelState, participantId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.agents.clear();
  }

  private agent(deckPath: string, participantId: string): ParticipantAgent {
    const k = key(deckPath, participantId);
    let agent = this.agents.get(k);
    if (!agent) {
      agent = { links: new Map(), messages: [], scratchpad: null, busy: false, activity: null };
      this.agents.set(k, agent);
    }
    return agent;
  }

  private note(agent: ParticipantAgent, role: AgentPanelMessage['role'], text: string, error?: boolean): void {
    agent.messages.push({ id: randomUUID(), role, text, ...(error ? { error: true } : {}) });
    if (agent.messages.length > MESSAGE_LIMIT) agent.messages.splice(0, agent.messages.length - MESSAGE_LIMIT);
  }

  private state(deckPath: string, participantId: string): AgentPanelState {
    const link = this.linked(deckPath, participantId);
    const agent = this.agent(deckPath, participantId);
    return {
      deckPath: resolve(deckPath), connection: link ? 'ready' : 'unavailable',
      agentName: link?.name ?? null, scratchpad: agent.scratchpad,
      busy: agent.busy, activity: agent.activity, messages: [...agent.messages], error: null,
    };
  }

  private emit(deckPath: string, participantId: string): AgentPanelState {
    const state = this.state(deckPath, participantId);
    for (const listener of this.listeners) listener(state, participantId);
    return state;
  }
}

function key(deckPath: string, participantId: string): string {
  return `${resolve(deckPath)}\u0000${participantId}`;
}
