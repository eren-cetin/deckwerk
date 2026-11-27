import { describe, expect, it } from 'vitest';
import { LocalAgentRegistry } from '../src/server/localAgents.js';

const link = (clientId: string, name: string) => ({ clientId, name, connectedAt: '2026-11-26T00:00:00Z' });

describe('local agent registry', () => {
  it('stays connected while any of several agents on one participant is attached', () => {
    const registry = new LocalAgentRegistry();
    registry.attach('/deck', 'p1', link('a', 'Agent A'));
    registry.attach('/deck', 'p1', link('b', 'Agent B'));
    expect(registry.linked('/deck', 'p1')?.clientId).toBe('b');

    const afterB = registry.detach('/deck', 'p1', 'b');
    expect(afterB).toMatchObject({ connection: 'ready', agentName: 'Agent A' });

    const afterA = registry.detach('/deck', 'p1', 'a');
    expect(afterA).toMatchObject({ connection: 'unavailable', agentName: null });
    expect(registry.linked('/deck', 'p1')).toBeNull();
  });
});
