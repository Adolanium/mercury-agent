import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionManager } from '../capabilities/permissions.js';
import type { Channel } from '../channels/base.js';
import type { ChannelMessage } from '../types/channel.js';
import { PluginManager } from './manager.js';
import { getPluginChannel, setChannelHost, splitMessage, toWhatsAppText, type PluginChannel } from './channel-bridge.js';
import { getPluginTools, resetToolBridge } from './tool-bridge.js';
import { pluginDataDir } from './store.js';
import { manifestSchema } from './types.js';
import { sleep, tempHome, waitFor } from './test-fixtures.js';

/** A fake WhatsApp plugin speaking the Plugin API 1.1 channel extension. */
const CHANNEL_SERVER = `
const fs = require('node:fs');
const path = require('node:path');
const data = process.env.MERCURY_PLUGIN_DATA_DIR;
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const log = (name, v) => fs.appendFileSync(path.join(data, name), JSON.stringify(v) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const ok = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      log('init.jsonl', msg.params.capabilities);
      return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wa', version: '1' } });
    case 'notifications/initialized':
      return notify('mercury/channel/status', { state: 'needs-pairing' });
    case 'tools/list':
      return ok({ tools: [{ name: 'inject', description: 'test', inputSchema: { type: 'object' } }] });
    case 'tools/call': {
      const a = msg.params.arguments;
      notify('mercury/channel/message', { id: a.id, chatId: a.chatId || '15550002@s.whatsapp.net', senderId: a.senderId || 'x@lid', senderPhone: a.senderPhone, isGroup: !!a.isGroup, fromMe: !!a.fromMe, text: a.text });
      return ok({ content: [{ type: 'text', text: 'injected' }] });
    }
    case 'mercury/channel/pair':
      ok({});
      notify('mercury/channel/status', { state: 'pairing', qr: 'QR-1' });
      return setTimeout(() => notify('mercury/channel/status', { state: 'connected', account: '15550001' }), 50);
    case 'mercury/channel/send':
    case 'mercury/channel/sendFile':
    case 'mercury/channel/typing':
      log('out.jsonl', { method: msg.method, ...msg.params });
      return ok({});
    case 'mercury/channel/unlink':
      ok({});
      return notify('mercury/channel/status', { state: 'logged-out', detail: 'unlinked by owner' });
  }
});
`;

function channelPlugin(root: string, id = 'whatsapp', extra: Record<string, unknown> = {}): string {
  const dir = join(root, `${id}-1.0.0`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mercury-plugin.json'), JSON.stringify({
    manifestVersion: 1, id, name: 'WhatsApp', version: '1.0.0', description: 'test channel', kind: 'out-of-process',
    engines: { mercury: '>=1.0.0', pluginApi: '^1.1.0' },
    server: { command: 'node', args: ['server.cjs'] },
    contributes: { tools: [{ name: 'inject', description: 'Inject a message for tests.', readOnly: true }], channel: { type: 'whatsapp' } },
    settings: { version: 1, fields: { owner: { type: 'string', default: '' }, members: { type: 'string', default: '' }, allowGroups: { type: 'boolean', default: false } } },
    ...extra,
  }));
  writeFileSync(join(dir, 'server.cjs'), CHANNEL_SERVER);
  return dir;
}

let env: ReturnType<typeof tempHome>;
let src: string;
let mgr: PluginManager;
let registered: Array<{ type: string; channel: Channel }>;
let received: ChannelMessage[];
let notices: string[];

beforeEach(() => {
  env = tempHome();
  src = join(env.home, 'src');
  mkdirSync(src, { recursive: true });
  resetToolBridge();
  registered = [];
  received = [];
  notices = [];
  setChannelHost({
    register: (type, channel) => { registered.push({ type, channel }); channel.onMessage((m) => received.push(m)); },
    unregister: (type, channel) => { registered = registered.filter((r) => r.channel !== channel); },
  });
  mgr = new PluginManager({ safeMode: false, notify: (m) => { notices.push(m); } });
});

afterEach(async () => {
  await mgr.shutdown();
  setChannelHost(null);
  resetToolBridge();
  env.restore();
});

async function inject(args: Record<string, unknown>): Promise<void> {
  const t = getPluginTools(new PermissionManager())['whatsapp__inject'] as Tool & { execute: (a: unknown, o: unknown) => Promise<unknown> };
  await t.execute(args, { toolCallId: 't', messages: [] });
  await sleep(40);
}

async function installChannel(owner = '+1 555 0002', members = ''): Promise<PluginChannel> {
  await mgr.install(channelPlugin(src));
  await mgr.setSetting('whatsapp', 'owner', owner);
  if (members) await mgr.setSetting('whatsapp', 'members', members);
  await waitFor(() => !!getPluginChannel('whatsapp') && registered.length === 1);
  return getPluginChannel('whatsapp')!;
}

describe('plugin channels (plugin API 1.1)', () => {
  it('registers with the runtime, negotiates the extension and goes away on disable', async () => {
    const ch = await installChannel();
    expect(registered[0].type).toBe('whatsapp');
    const init = readFileSync(join(pluginDataDir('whatsapp'), 'init.jsonl'), 'utf8');
    expect(init).toContain('mercury/channel');
    expect(ch.getStatus().state).toBe('needs-pairing');
    expect(ch.isReady()).toBe(false);
    await mgr.disable('whatsapp');
    expect(registered).toEqual([]);
    expect(getPluginChannel('whatsapp')).toBeUndefined();
  });

  it('pairs with a QR code and becomes ready', async () => {
    await installChannel();
    const st = await mgr.pair('whatsapp', { method: 'qr' });
    expect(st.qr).toBe('QR-1');
    await waitFor(() => mgr.channelStatus('whatsapp')?.state === 'connected');
    expect(getPluginChannel('whatsapp')!.isReady()).toBe(true);
    expect((await mgr.info('whatsapp'))?.channel).toMatchObject({ type: 'whatsapp', state: 'connected', account: '15550001' });
  });

  it('only the owner and listed members reach the agent; groups and our own messages never do', async () => {
    await installChannel('+1 (555) 0002', '15550003');
    await inject({ id: 'm1', senderPhone: '15550002', text: 'hi from owner' });
    await inject({ id: 'm2', senderPhone: '15550003', text: 'hi from member' });
    await inject({ id: 'm3', senderPhone: '19998887777', text: 'stranger' });
    await inject({ id: 'm4', senderPhone: '15550002', text: 'group', isGroup: true });
    await inject({ id: 'm5', senderPhone: '15550002', text: 'mine', fromMe: true });
    await inject({ id: 'm1', senderPhone: '15550002', text: 'duplicate' });
    expect(received.map((m) => [m.content, m.senderRole, m.channelId])).toEqual([
      ['hi from owner', 'admin', 'whatsapp:15550002@s.whatsapp.net'],
      ['hi from member', 'member', 'whatsapp:15550002@s.whatsapp.net'],
    ]);
  });

  it('no owner set means nobody gets through', async () => {
    await installChannel('');
    await inject({ id: 'n1', senderPhone: '15550002', text: 'hello' });
    expect(received).toEqual([]);
  });

  it('sends formatted, chunked text to the plugin', async () => {
    const ch = await installChannel();
    await ch.send('# Title\n**bold** and ~~gone~~ [link](https://x.y)', 'whatsapp:15550002@s.whatsapp.net');
    await ch.send('x'.repeat(9000), 'whatsapp:15550002@s.whatsapp.net');
    const out = readFileSync(join(pluginDataDir('whatsapp'), 'out.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(out[0]).toMatchObject({ method: 'mercury/channel/send', chatId: '15550002@s.whatsapp.net', text: '*Title*\n*bold* and ~gone~ link (https://x.y)' });
    expect(out.slice(1).every((o) => o.text.length <= 4000)).toBe(true);
    expect(out.slice(1).map((o) => o.text).join('')).toBe('x'.repeat(9000));
  });

  it('approvals are answered by a text reply that never reaches the agent', async () => {
    const ch = await installChannel();
    const answer = ch.askPermission('Run git push?', 'whatsapp:15550002@s.whatsapp.net');
    await sleep(40);
    await inject({ id: 'a1', senderPhone: '15550002', text: '3' });
    expect(await answer).toBe('always');
    expect(received).toEqual([]);
  });

  it('logged out: tells the owner how to relink', async () => {
    await installChannel();
    await mgr.unlinkChannel('whatsapp');
    await waitFor(() => notices.length > 0);
    expect(notices[0]).toMatch(/logged out.*\/plugins pair whatsapp/);
  });

  it('only one plugin can provide a channel type', async () => {
    await installChannel();
    await expect(mgr.install(channelPlugin(src, 'whatsapp-two'))).rejects.toThrow(/already provided by "whatsapp"/);
    const other = await mgr.info('whatsapp-two');
    expect(other?.disabled?.message).toMatch(/already provided by "whatsapp"/);
  });

  it('manifest rules: out-of-process only, plugin API 1.1+', () => {
    const base = JSON.parse(readFileSync(join(channelPlugin(src, 'rules'), 'mercury-plugin.json'), 'utf8'));
    expect(manifestSchema.safeParse(base).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, engines: { mercury: '>=1.0.0', pluginApi: '^1.0.0' } }).success).toBe(true); // ^1.0.0 includes 1.1
    expect(manifestSchema.safeParse({ ...base, engines: { mercury: '>=1.0.0', pluginApi: '~1.0.0' } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, contributes: { ...base.contributes, channel: { type: 'telegram' } } }).success).toBe(false);
    expect(existsSync(src)).toBe(true);
  });

  it('formatting helpers', () => {
    expect(toWhatsAppText('## Hi\n__x__')).toBe('*Hi*\n_x_');
    expect(splitMessage('a\nb', 2)).toEqual(['a', 'b']);
  });
});
