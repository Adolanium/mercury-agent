import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from './openai-compat.js';
import { resetModelPrefsCache, setModelPref } from '../utils/model-prefs.js';
import type { ProviderConfig } from '../utils/config.js';

const config = (name: string): ProviderConfig => ({
  name,
  apiKey: '',
  baseUrl: 'http://ollama.test/v1',
  model: 'qwen3.8:27b',
  enabled: true,
});

/** Minimal Chat Completions reply so generateText resolves. */
function completion(): Response {
  return new Response(JSON.stringify({
    id: 'c1', object: 'chat.completion', created: 0, model: 'qwen3.8:27b',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenAICompatProvider reasoning preference', () => {
  let home: string;
  const previousHome = process.env.MERCURY_HOME;
  let sent: Record<string, unknown>[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mercury-reasoning-'));
    process.env.MERCURY_HOME = home;
    resetModelPrefsCache();
    sent = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return completion();
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetModelPrefsCache();
    if (previousHome === undefined) delete process.env.MERCURY_HOME;
    else process.env.MERCURY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function send(name: string) {
    const provider = new OpenAICompatProvider(config(name), { useChatApi: true });
    await generateText({ model: provider.getModelInstance(), prompt: 'hi' });
    return sent[0]!;
  }

  it('sends reasoning_effort "none" when thinking is turned off for an Ollama model', async () => {
    setModelPref('ollamaLocal', 'qwen3.8:27b', { reasoning: 'off' });
    expect((await send('ollamaLocal')).reasoning_effort).toBe('none');
  });

  it('sends the chosen level even for model ids the SDK does not know are reasoning models', async () => {
    setModelPref('ollamaLocal', 'qwen3.8:27b', { reasoning: 'high' });
    expect((await send('ollamaLocal')).reasoning_effort).toBe('high');
  });

  it('sends nothing on auto', async () => {
    expect(await send('ollamaLocal')).not.toHaveProperty('reasoning_effort');
  });

  it('never sends an effort to an OpenAI model that rejects it, even if one was saved', async () => {
    setModelPref('openai', 'qwen3.8:27b', { reasoning: 'high' });
    expect(await send('openai')).not.toHaveProperty('reasoning_effort');
  });

  it('leaves providers without a reasoning control untouched', async () => {
    setModelPref('lmStudio', 'qwen3.8:27b', { reasoning: 'high' });
    expect(await send('lmStudio')).not.toHaveProperty('reasoning_effort');
  });
});
