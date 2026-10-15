import { describe, expect, it } from 'vitest';
import { Agent } from './agent.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';

/**
 * #191: POST /api/chat/models/switch passes provider + model straight into
 * Agent.switchProvider. The model pin must never write through an unknown
 * key (e.g. "__proto__") or for a provider that isn't configured.
 */
function agentWith(config: MercuryConfig): Agent {
  const agent = Object.create(Agent.prototype) as Agent;
  Object.assign(agent, { config, switchSessionProvider: async (name: string) => ({ ok: true, message: `switched to ${name}` }) });
  return agent;
}

describe('switchProvider model pin', () => {
  it('rejects __proto__ without polluting Object.prototype', async () => {
    const agent = agentWith(getDefaultConfig() as MercuryConfig);
    const res = await agent.switchProvider('__proto__', 'evil');
    expect(res.ok).toBe(false);
    expect(({} as { model?: string }).model).toBeUndefined();
  });

  it('rejects providers that are not configured, and bad model ids', async () => {
    const agent = agentWith(getDefaultConfig() as MercuryConfig);
    expect((await agent.switchProvider('notAProvider', 'x')).ok).toBe(false);
    expect((await agent.switchProvider('openai', 'a'.repeat(300))).ok).toBe(false);
    expect((await agent.switchProvider('openai', 'bad\nid')).ok).toBe(false);
  });

  it('pins the model on a configured provider', async () => {
    const config = getDefaultConfig() as MercuryConfig;
    config.providers.openai.apiKey = 'sk-test';
    config.providers.openai.enabled = true;
    const agent = agentWith(config);
    const res = await agent.switchProvider('openai', 'gpt-4.1');
    expect(res.ok).toBe(true);
    expect(config.providers.openai.model).toBe('gpt-4.1');
  });
});
