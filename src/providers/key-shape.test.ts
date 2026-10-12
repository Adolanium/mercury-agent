import { describe, expect, it } from 'vitest';
import { checkKeyShapes } from './key-shape.js';

describe('API key shape check (doctor)', () => {
  it('flags a pasted prefix typo and whitespace, passes real shapes and unknown providers', () => {
    const w = checkKeyShapes({
      openai: { apiKey: '2sk-proj-abc', enabled: true },
      anthropic: { apiKey: 'sk-ant-xyz', enabled: true },
      deepseek: { apiKey: 'sk-1 23', enabled: true },
      grok: { apiKey: 'xai-ok', enabled: true },
      ollamaCloud: { apiKey: 'whatever', enabled: true },
      disabled: { apiKey: 'nope', enabled: false },
    });
    expect(w.map((x) => x.provider).sort()).toEqual(['deepseek', 'openai']);
    expect(w.find((x) => x.provider === 'openai')?.problem).toContain('"2sk-pr…"');
  });
});
