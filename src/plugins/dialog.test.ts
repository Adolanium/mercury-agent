import { describe, expect, it } from 'vitest';
import { PluginDialog, renderPrompt } from './dialog.js';
import type { PluginService } from './service.js';
import type { PluginListItem } from './types.js';

function fakeService(overrides: Partial<PluginListItem> = {}) {
  const values: Record<string, unknown> = { owner: '', access: 'general', answerCalls: true, members: '' };
  const calls: string[] = [];
  let linked = false;
  const item = (): PluginListItem => ({
    id: 'whatsapp', name: 'WhatsApp', description: 'Chat with Mercury.', kind: 'out-of-process', tier: 'official',
    status: 'enabled', installedVersion: '0.1.0', enabled: true, running: true, verified: true, tools: [], commands: [],
    channel: { type: 'whatsapp', state: linked ? 'connected' : 'needs-pairing', account: linked ? '639759021037' : undefined },
    settings: [
      { key: 'owner', type: 'string', description: '', value: values.owner, label: 'Which number will you chat from?', setup: true, required: true, format: 'phone' },
      { key: 'access', type: 'enum', description: '', options: ['general', 'extended'], value: values.access, label: 'What can Mercury do in your chat?', setup: true, optionLabels: { general: 'General: chat only', extended: 'Extended: memory, files, tools' } },
      { key: 'answerCalls', type: 'boolean', description: '', value: values.answerCalls, label: 'Answer your voice calls', setup: true },
      { key: 'members', type: 'string', description: '', value: values.members, label: 'Other numbers allowed to chat' },
    ],
    ...overrides,
  });
  const svc = {
    mode: 'local',
    info: async () => item(),
    setSetting: async (_id: string, key: string, value: unknown) => {
      if (key === 'owner' && String(value).replace(/\D/g, '').length < 7) throw new Error('Expected a phone number with country code, like +15551234567.');
      values[key] = key === 'owner' ? `+${String(value).replace(/\D/g, '')}` : value;
      calls.push(`set ${key}=${String(values[key])}`);
    },
    channelStatus: async () => ({ state: linked ? 'connected' : 'needs-pairing', at: Date.now() }),
    pair: async (_id: string, opts: { method: string; phone?: string }) => { calls.push(`pair ${opts.method} ${opts.phone}`); return { state: 'pairing', pairCode: 'ABCD1234', at: Date.now() }; },
    testChannel: async () => { calls.push('test'); return 'Sent a test message.'; },
    unlink: async () => { calls.push('unlink'); linked = false; },
    disable: async () => { calls.push('disable'); },
    enable: async () => { calls.push('enable'); },
    uninstall: async (_id: string, purge?: boolean) => { calls.push(`uninstall ${purge ? 'purge' : 'keep'}`); },
    update: async () => [],
  } as unknown as PluginService;
  return { svc, calls, values, link: () => { linked = true; } };
}

async function say(d: PluginDialog, ...answers: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const a of answers) {
    const r = await d.answer(a);
    if (r.message) out.push(r.message);
    const p = await d.current();
    if (p) out.push(renderPrompt(p, false));
  }
  return out;
}

describe('setup dialog', () => {
  it('asks each setup setting in order, validates, then offers linking', async () => {
    const { svc, calls, values } = fakeService();
    const d = (await PluginDialog.setup(svc, 'whatsapp'))!;
    const first = renderPrompt((await d.current())!, false);
    expect(first).toMatch(/WhatsApp setup \(1\/4\)[\s\S]*Which number will you chat from\?[\s\S]*country code/);

    const out = await say(d, 'abc', '+91 700 680 4336', '2', '1', '1', '+63 975 902 1037', 'ok');
    expect(out[0]).toMatch(/phone number/); // "abc" rejected, same question again
    expect(values.owner).toBe('+917006804336');
    expect(out.join('\n')).toMatch(/Extended: memory, files, tools/);
    expect(values.access).toBe('extended');
    expect(values.answerCalls).toBe(true);
    expect(calls).toContain('pair code 639759021037');
    expect(out.join('\n')).toMatch(/Pairing code: \*ABCD1234\*/);
    expect(out.join('\n')).toMatch(/is set up[\s\S]*\/plugins whatsapp/);
    expect(await d.current()).toBeNull();
  });

  it('options can be picked by number, button command or their words; cancel stops', async () => {
    const { svc, values } = fakeService();
    const d = (await PluginDialog.setup(svc, 'whatsapp'))!;
    await say(d, '+917006804336', '/plugins pick 2');
    expect(values.access).toBe('extended');
    await say(d, 'no');
    expect(values.answerCalls).toBe(false);
    const r = await d.answer('cancel');
    expect(r).toEqual({ message: 'Closed.', finished: true });
  });

  it('a plugin with nothing to set up has no setup dialog', async () => {
    const { svc } = fakeService({ settings: [], channel: undefined });
    expect(await PluginDialog.setup(svc, 'whatsapp')).toBeNull();
  });
});

describe('/plugins <id> menu', () => {
  it('shows status and settings, and its actions work', async () => {
    const { svc, calls, values, link } = fakeService();
    link();
    const d = (await PluginDialog.menu(svc, 'whatsapp', true))!;
    const menu = renderPrompt((await d.current())!, false);
    expect(menu).toMatch(/WhatsApp[\s\S]*Account: linked as \+639759021037[\s\S]*What can Mercury do in your chat\?: General/);
    expect(menu).toMatch(/Change a setting[\s\S]*Send me a test message[\s\S]*Unlink the account[\s\S]*Turn off[\s\S]*Uninstall[\s\S]*Close/);

    await say(d, 'Send me a test message');
    expect(calls).toContain('test');
    await say(d, '1', '2', '2'); // Change a setting → access → Extended
    expect(values.access).toBe('extended');
    await say(d, 'unlink', 'yes');
    expect(calls).toContain('unlink');
    const r = await d.answer('close');
    expect(r.finished).toBe(true);
  });

  it('members see status only, with no actions', async () => {
    const { svc } = fakeService();
    const d = (await PluginDialog.menu(svc, 'whatsapp', false))!;
    expect((await d.current())!.options).toBeUndefined();
  });
});
