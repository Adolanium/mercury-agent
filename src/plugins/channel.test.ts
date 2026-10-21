import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionManager } from '../capabilities/permissions.js';
import type { Channel } from '../channels/base.js';
import type { ChannelMessage } from '../types/channel.js';
import { PluginManager, setProviderLookup } from './manager.js';
import { PluginChannel } from './channel-bridge.js';
import { getPluginChannel, setChannelHost, splitMessage, toWhatsAppText } from './channel-bridge.js';
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
let reqN = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) { log('replies.jsonl', msg); return; }
  const ok = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      log('init.jsonl', msg.params.capabilities);
      return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wa', version: '1' } });
    case 'notifications/initialized':
      return notify('mercury/channel/status', { state: 'needs-pairing' });
    case 'tools/list':
      return ok({ tools: ['inject', 'callsim', 'callend'].map((name) => ({ name, description: 'test', inputSchema: { type: 'object' } })) });
    case 'tools/call': {
      const a = msg.params.arguments;
      if (msg.params.name === 'callsim') {
        send({ jsonrpc: '2.0', id: 'wa-' + (++reqN), method: a.method, params: a.params });
        return ok({ content: [{ type: 'text', text: 'sent' }] });
      }
      if (msg.params.name === 'callend') {
        notify('mercury/call/ended', a);
        return ok({ content: [{ type: 'text', text: 'sent' }] });
      }
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
    case 'mercury/call/progress':
      return log('progress.jsonl', msg.params);
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
    contributes: { tools: ['inject', 'callsim', 'callend'].map((name) => ({ name, description: 'Test hook.', readOnly: true })), channel: { type: 'whatsapp' } },
    settings: { version: 1, fields: {
      owner: { type: 'string', default: '' },
      access: { type: 'enum', options: ['ask', 'general', 'extended'], default: 'ask' },
      members: { type: 'string', default: '' },
      memberAccess: { type: 'enum', options: ['general', 'extended'], default: 'general' },
      allowGroups: { type: 'boolean', default: false },
    } },
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
  setProviderLookup(() => undefined); // never the real ~/.mercury providers
  mgr = new PluginManager({ safeMode: false, notify: (m) => { notices.push(m); } });
});

afterEach(async () => {
  await mgr.shutdown();
  setChannelHost(null);
  resetToolBridge();
  env.restore();
});

async function inject(args: Record<string, unknown>, tool = 'inject'): Promise<void> {
  const t = getPluginTools(new PermissionManager())[`whatsapp__${tool}`] as Tool & { execute: (a: unknown, o: unknown) => Promise<unknown> };
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

  describe('voice calls', () => {
    const replies = () => {
      const f = join(pluginDataDir('whatsapp'), 'replies.jsonl');
      return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    };
    const sent = () => {
      const f = join(pluginDataDir('whatsapp'), 'out.jsonl');
      return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    };
    const callsim = (method: string, params: Record<string, unknown>) => inject({ method, params }, 'callsim');

    it('answers only the owner, and only with a voice provider', async () => {
      await installChannel();
      await callsim('mercury/call/incoming', { callId: 'c1', from: 'x@lid', fromPhone: '15550002', voiceReady: true });
      await callsim('mercury/call/incoming', { callId: 'c2', from: '19998887777@s.whatsapp.net', voiceReady: true });
      await callsim('mercury/call/incoming', { callId: 'c3', from: 'x@lid', fromPhone: '15550002', voiceReady: false });
      await waitFor(() => replies().length === 3);
      const r = replies();
      expect(r[0].result.accept).toBe(true);
      expect(r[1].result.accept).toBe(false);
      expect(r[2].result.accept).toBe(false);
      await waitFor(() => sent().some((m) => /OpenAI provider/.test(m.text ?? '')));
      expect(sent().find((m) => /OpenAI provider/.test(m.text))?.text).toMatch(/Providers/);
    });

    it('ask_mercury runs a turn and returns its answer, without messaging WhatsApp', async () => {
      const ch = await installChannel();
      await callsim('mercury/call/ask', { callId: 'c9', question: 'What is the weather?' });
      await waitFor(() => received.length === 1);
      const msg = received[0];
      expect(msg.channelId).toBe('whatsapp:call:c9');
      expect(msg.senderRole).toBe('admin');
      expect(msg.content).toMatch(/Voice call[\s\S]*What is the weather\?/);
      // The agent replies on the call target, then finishes the turn.
      expect(await ch.askPermission('Run git push?', msg.channelId)).toBe('no');
      await ch.send('☿ Working on it…', msg.channelId);
      await ch.send('It is sunny and 24 degrees.', msg.channelId);
      ch.endTask(msg.channelId);
      await waitFor(() => replies().length === 1);
      expect(replies()[0].result.answer).toBe('It is sunny and 24 degrees.');
      expect(sent().filter((m) => m.method === 'mercury/channel/send')).toEqual([]);
    });

    it('tells the plugin what Mercury is doing during a call, in words a voice can say', async () => {
      const ch = await installChannel();
      ch.toolStarted('whatsapp:call:c7', 'web_search');
      ch.toolStarted('whatsapp:call:c7', 'fetch_url');
      ch.toolStarted('whatsapp:15550002@s.whatsapp.net', 'web_search'); // a normal chat: nothing sent
      const f = join(pluginDataDir('whatsapp'), 'progress.jsonl');
      await waitFor(() => existsSync(f) && readFileSync(f, 'utf8').trim().split('\n').length === 2);
      expect(readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([
        { callId: 'c7', activity: 'searching the web' },
        { callId: 'c7', activity: 'reading a web page' },
      ]);
    });

    it('sends the owner a summary when a call ends, or a note when it was missed', async () => {
      await installChannel();
      await inject({ callId: 'c5', direction: 'incoming', outcome: 'completed', durationSec: 75, transcript: [{ role: 'owner', text: 'Any news?' }, { role: 'mercury', text: 'Two new emails.' }] }, 'callend');
      await inject({ callId: 'c6', direction: 'outgoing', outcome: 'no_answer', reason: 'The deploy failed', durationSec: 0, transcript: [] }, 'callend');
      await waitFor(() => sent().length >= 2);
      const texts = sent().map((m) => m.text as string);
      expect(texts[0]).toMatch(/Call with you ended · 1m 15s[\s\S]*You: Any news\?[\s\S]*Mercury: Two new emails\./);
      expect(texts[1]).toMatch(/tried to call you about: The deploy failed\. No answer/);
      expect(sent().every((m) => m.chatId === '15550002@s.whatsapp.net')).toBe(true);
    });
  });

  describe('access levels', () => {
    const sentTexts = () => {
      const f = join(pluginDataDir('whatsapp'), 'out.jsonl');
      return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).text as string) : [];
    };

    it('General by default, and Mercury is told it is on WhatsApp and where to change it', async () => {
      await installChannel();
      await inject({ id: 'g1', senderPhone: '15550002', text: 'hello' });
      expect(received[0].metadata?.channelAccess).toBe('general');
      const g = String(received[0].metadata?.channelGuidance);
      expect(g).toMatch(/talking with the owner \(the person you work for\) on WhatsApp, a phone chat app/);
      expect(g).toMatch(/No code blocks/);
      expect(g).toMatch(/Access: General[\s\S]*\/plugins whatsapp/);
      expect(sentTexts()).toEqual([]); // no unsolicited prompts in the chat
    });

    it('switching to Extended applies live, without restarting the plugin', async () => {
      await installChannel();
      await mgr.setSetting('whatsapp', 'access', 'extended');
      await inject({ id: 'e1', senderPhone: '15550002', text: 'what is on my calendar' });
      expect(received[0].metadata?.channelAccess).toBe('extended');
      expect(String(received[0].metadata?.channelGuidance)).toMatch(/Access: Extended/);
      expect(registered).toHaveLength(1); // same channel instance: no restart happened
    });

    it('a fresh link (not a reconnect) is confirmed to the owner', async () => {
      await installChannel();
      await mgr.pair('whatsapp', { method: 'qr' });
      await waitFor(() => notices.some((n) => /WhatsApp linked as \+15550001/.test(n)));
      expect(notices.find((n) => /linked/.test(n))).toMatch(/\/plugins whatsapp/);
    });

    it('members never exceed the owner, and default to General', async () => {
      await installChannel('+15550002', '15550003');
      await mgr.setSetting('whatsapp', 'access', 'extended');
      await inject({ id: 'm1', senderPhone: '15550003', text: 'hi' });
      expect(received[0].metadata?.channelAccess).toBe('general');
      expect(String(received[0].metadata?.channelGuidance)).toMatch(/approved member, not the owner[\s\S]*only the owner can allow/);
      await mgr.setSetting('whatsapp', 'memberAccess', 'extended');
      await inject({ id: 'm2', senderPhone: '15550003', text: 'hi again' });
      expect(received[1].metadata?.channelAccess).toBe('extended');
      await mgr.setSetting('whatsapp', 'access', 'general');
      await inject({ id: 'm3', senderPhone: '15550003', text: 'and now' });
      expect(received[2].metadata?.channelAccess).toBe('general');
    });
  });

  describe('voice notes', () => {
    function channelWith(transcribe: ((p: string) => Promise<string>) | null) {
      const sent: string[] = [];
      const got: ChannelMessage[] = [];
      const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(channelPlugin(src, 'voice-notes'), 'mercury-plugin.json'), 'utf8')));
      const ch = new PluginChannel(
        manifest,
        { request: async (method, params) => { if (method === 'mercury/channel/send') sent.push((params as { text: string }).text); return {}; } },
        () => ({ owner: '+15550002', access: 'extended' }),
        () => {},
        async () => {},
        transcribe,
      );
      ch.onMessage((m) => got.push(m));
      return { ch, sent, got };
    }
    const note = (id: string, text?: string) => ({ id, chatId: '15550002@s.whatsapp.net', senderId: 'x@lid', senderPhone: '15550002', text, attachments: [{ kind: 'voice', path: `/tmp/${id}.ogg` }] });

    it('are transcribed and reach the agent as text, in order', async () => {
      const { ch, got } = channelWith(async (p) => { if (p.includes('v1')) await sleep(60); return p.includes('v1') ? 'What is the news today?' : 'And the weather?'; });
      ch.handleNotification('mercury/channel/message', note('v1'));
      ch.handleNotification('mercury/channel/message', note('v2'));
      await waitFor(() => got.length === 2);
      expect(got.map((m) => m.content)).toEqual(['What is the news today?', 'And the weather?']);
      expect(got[0].metadata?.voiceNote).toBe(true);
      expect(String(got[0].metadata?.channelGuidance)).toMatch(/voice note/);
    });

    it('without a transcriber: the owner is told how to enable it; nothing reaches the agent', async () => {
      const { ch, sent, got } = channelWith(null);
      ch.handleNotification('mercury/channel/message', note('v3'));
      await waitFor(() => sent.length === 1);
      expect(sent[0]).toMatch(/OpenAI provider[\s\S]*Providers/);
      expect(got).toEqual([]);
    });

    it('a failed transcription asks the owner to type it', async () => {
      const { ch, sent } = channelWith(async () => { throw new Error('insufficient_quota'); });
      ch.handleNotification('mercury/channel/message', note('v4'));
      await waitFor(() => sent.length === 1);
      expect(sent[0]).toMatch(/couldn't understand that voice note \(insufficient_quota\)/);
    });
  });
});
