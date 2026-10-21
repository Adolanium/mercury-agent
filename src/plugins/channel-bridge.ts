/**
 * Plugin API 1.1: a chat channel provided by an out-of-process plugin.
 *
 * The plugin owns the connection to the chat service (e.g. WhatsApp as a
 * linked device). Mercury owns everything that decides what reaches the
 * agent: who is allowed to talk to it (the owner's number and listed
 * members, checked here, not in the plugin), approvals, chunking and
 * formatting. A plugin can't widen access by sending messages Mercury
 * didn't ask for.
 *
 * Protocol (JSON-RPC over the plugin's stdio, alongside MCP):
 *   plugin → Mercury notifications
 *     mercury/channel/status   { state, detail?, account?, qr?, pairCode? }
 *     mercury/channel/message  { id, chatId, senderId, senderPhone?, senderName?,
 *                                isGroup?, fromMe?, text?, attachments?, timestamp? }
 *   Mercury → plugin requests
 *     mercury/channel/send     { chatId, text }
 *     mercury/channel/sendFile { chatId, path, caption? }
 *     mercury/channel/typing   { chatId, on }
 *     mercury/channel/pair     { method: 'qr' | 'code', phone? }
 *     mercury/channel/unlink   {}
 *   Voice calls (plugin → Mercury)
 *     mercury/call/incoming    request  { callId, from, fromPhone?, voiceReady } → { accept, instructions? }
 *     mercury/call/briefing    request  { callId } → { instructions }
 *     mercury/call/ask         request  { callId, question } → { answer }   (runs a Mercury turn)
 *     mercury/call/ended       notification { callId, direction, outcome, durationSec, transcript, reason? }
 *   Mercury → plugin during a call
 *     mercury/call/progress    notification { callId, activity }   (what an ask_mercury turn is doing now)
 *     mercury/call/context     notification { callId, text }       (something happened in the chat, e.g. a photo arrived)
 *     mercury/call/approval    notification { callId, approvalId, prompt }   (ask the owner by voice)
 *     mercury/call/approval-resolved notification { callId, approvalId, decision, via }
 *   plugin → Mercury
 *     mercury/call/approve     request { callId, approvalId, approved } (after checking the owner said yes)
 *
 * Approvals during a call are asked by voice and in the chat at once; the
 * first answer wins. The plugin accepts a spoken yes only when the owner's own
 * transcribed words say yes, and a spoken yes never becomes "always".
 */
import { basename } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { BaseChannel, type Channel } from '../channels/base.js';
import type { ChannelMessage, ChannelType } from '../types/channel.js';
import { logger } from '../utils/logger.js';
import type { PluginManifest } from './types.js';

export const CHANNEL_STATES = ['starting', 'needs-pairing', 'pairing', 'connected', 'disconnected', 'logged-out', 'error'] as const;
export type ChannelState = (typeof CHANNEL_STATES)[number];

export interface ChannelStatus {
  state: ChannelState;
  detail?: string;
  /** The linked account, e.g. the spare number Mercury runs on. */
  account?: string;
  qr?: string;
  pairCode?: string;
  at: number;
}

export interface ChannelTransport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  /** One-way message to the plugin (e.g. call progress). */
  notify?(method: string, params: unknown): void;
}

/** What a tool is doing, in words a voice can say. */
export function describeTool(name: string): string {
  if (name === 'web_search') return 'searching the web';
  if (name === 'fetch_url') return 'reading a web page';
  if (name === 'search_memory') return 'checking what I know about you';
  if (name === 'save_memory') return 'making a note';
  if (name === 'use_skill' || name === 'list_skills') return 'using a skill';
  if (name === 'read_file' || name === 'list_dir') return 'looking through your files';
  if (name === 'run_command') return 'running a command';
  if (/^git_|github|_pr$|issue/.test(name)) return 'checking GitHub';
  if (name.startsWith('spotify_')) return 'talking to Spotify';
  if (name === 'dispatch_bot' || name === 'delegate_task') return 'asking one of my helpers';
  if (name.includes('__')) return 'using a plugin';
  return 'working on it';
}

/** Where plugin channels are registered (the runtime's ChannelRegistry). */
export interface ChannelHost {
  register(type: ChannelType, channel: Channel): void;
  unregister(type: ChannelType, channel: Channel): void;
}

let host: ChannelHost | null = null;
const live = new Map<string, PluginChannel>();

export function setChannelHost(h: ChannelHost | null): void {
  host = h;
  if (h) for (const ch of live.values()) h.register(ch.type, ch);
}

export function getPluginChannel(pluginId: string): PluginChannel | undefined {
  return live.get(pluginId);
}

const MAX_MESSAGE_LENGTH = 4000;
const SEND_TIMEOUT_MS = 30_000;
const FILE_TIMEOUT_MS = 5 * 60_000;
const APPROVAL_TIMEOUT_MS = 120_000;
const FILE_LIMIT_BYTES = 100 * 1024 * 1024;

const AFFIRMATIVE = new Set(['yes', 'y', 'ok', 'okay', 'sure', 'allow', 'approve', 'yeah', 'yep', 'yup', '1']);
const NEGATIVE = new Set(['no', 'n', 'nope', 'deny', 'stop', 'cancel', 'never', '2']);
const ALWAYS_WORDS = new Set(['always', 'allow all', 'allow-all', 'forever', '3']);

function normalizeReply(raw: string): 'yes' | 'no' | 'always' | null {
  const t = raw.trim().toLowerCase().replace(/[.!]/g, '');
  if (ALWAYS_WORDS.has(t)) return 'always';
  if (AFFIRMATIVE.has(t)) return 'yes';
  if (NEGATIVE.has(t)) return 'no';
  return null;
}

export function digits(s: string | undefined): string {
  return (s ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** Markdown → WhatsApp formatting (*bold*, _italic_, ~strike~, ```mono```). */
export function toWhatsAppText(md: string): string {
  return md
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/(?<![*\w])__(.+?)__(?![*\w])/g, '_$1_')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)');
}

export function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

interface IncomingParams {
  id?: unknown;
  chatId?: unknown;
  senderId?: unknown;
  senderPhone?: unknown;
  senderName?: unknown;
  isGroup?: unknown;
  fromMe?: unknown;
  text?: unknown;
  attachments?: unknown;
  timestamp?: unknown;
}

export class PluginChannel extends BaseChannel {
  readonly type: ChannelType;
  private status: ChannelStatus = { state: 'starting', at: Date.now() };
  private pending = new Map<string, { resolve: (v: string) => void; timer: ReturnType<typeof setTimeout> }>();
  /**
   * Approvals asked on a call. Answerable by voice (the plugin checks the
   * owner actually said yes) or by replying in the chat; first answer wins.
   */
  private callApprovals = new Map<string, { callId: string; prompt: string; resolve: (v: string) => void; timer: ReturnType<typeof setTimeout> }>();
  private approvalSeq = 0;
  /** The owner's chat as WhatsApp addresses it (often a LID, not their phone JID). */
  private ownerChatId: string | undefined;
  private seen = new Set<string>();
  private statusListeners = new Set<(s: ChannelStatus) => void>();
  /** In-flight `ask_mercury` turns, by call target (`call:<callId>`). */
  private callAsks = new Map<string, { chunks: string[]; resolve: (answer: string) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Call targets whose turn outlived the call question: later output goes to the owner's chat. */
  private overflow = new Set<string>();
  /** Calls in progress, and the files the owner sent in the chat during each (for the voice to ask about). */
  private activeCalls = new Map<string, { since: number; files: Array<{ path: string; kind: string; name: string; mime?: string }> }>();

  private callStarted(callId: string): void {
    if (!callId) return;
    this.activeCalls.set(callId, { since: Date.now(), files: [] });
    // A call that never reported its end is forgotten after 2 hours.
    for (const [id, c] of this.activeCalls) if (Date.now() - c.since > 2 * 3600_000) this.activeCalls.delete(id);
  }

  private currentCall(): [string, { since: number; files: Array<{ path: string; kind: string; name: string; mime?: string }> }] | undefined {
    let latest: [string, { since: number; files: Array<{ path: string; kind: string; name: string; mime?: string }> }] | undefined;
    for (const e of this.activeCalls) if (!latest || e[1].since > latest[1].since) latest = e;
    return latest;
  }

  constructor(
    private readonly manifest: PluginManifest,
    private readonly transport: ChannelTransport,
    /** The plugin's current settings (owner, members, allowGroups). */
    private readonly settings: () => Record<string, unknown>,
    private readonly notifyOwner: (message: string) => void,
    /** Persist a plugin setting without restarting it (access level, members). */
    private readonly saveSetting: (key: string, value: unknown) => Promise<void> = async () => {},
    /** Speech to text for voice notes; null when no provider can do it. */
    private readonly transcribe: ((path: string) => Promise<string>) | null = null,
  ) {
    super();
    this.type = manifest.contributes.channel!.type as ChannelType;
  }

  /** Phone chats: no per-step messages or "Working…" heartbeats; keep "typing…" alive instead. */
  readonly quietProgress = true;


  get pluginId(): string {
    return this.manifest.id;
  }

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  onStatus(fn: (s: ChannelStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  // ── lifecycle (driven by the plugin runtime) ──────────────────────────

  attach(): void {
    live.set(this.manifest.id, this);
    host?.register(this.type, this);
  }

  detach(): void {
    if (live.get(this.manifest.id) === this) live.delete(this.manifest.id);
    host?.unregister(this.type, this);
    this.ready = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve('no');
    }
    this.pending.clear();
  }

  /** The plugin process went away; it will be restarted by the supervisor. */
  down(): void {
    this.setStatus({ state: 'disconnected', detail: 'the plugin process stopped', at: Date.now() });
  }

  handleNotification(method: string, params: unknown): void {
    if (method === 'mercury/channel/status') this.onStatusNotification(params);
    else if (method === 'mercury/channel/message') this.onMessageNotification(params as IncomingParams);
    else if (method === 'mercury/call/ended') this.onCallEnded(params);
  }

  async handleRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'mercury/call/incoming': {
        const from = typeof p.fromPhone === 'string' && p.fromPhone ? p.fromPhone : String(p.from ?? '');
        if (this.roleOf(from) !== 'admin') return { accept: false, reason: 'only the owner can call Mercury' };
        if (p.voiceReady !== true) {
          const why = typeof p.voiceProblem === 'string' && p.voiceProblem ? p.voiceProblem : 'voice calls need an OpenAI provider: add your OpenAI key once in the dashboard (Providers) or with `mercury doctor`';
          void this.send(`📞 I couldn't answer your call: ${why}.`).catch(() => {});
          return { accept: false, reason: 'voice engine not ready' };
        }
        this.callStarted(String(p.callId ?? ''));
        return { accept: true, instructions: voiceBriefing() };
      }
      case 'mercury/call/briefing':
        this.callStarted(String(p.callId ?? ''));
        return { instructions: voiceBriefing() };
      case 'mercury/call/approve': {
        // The plugin only sends this after checking the owner's own words on the call.
        const approvalId = String(p.approvalId ?? '');
        const ok = this.resolveCallApproval(approvalId, p.approved === true ? 'yes' : 'no', 'voice');
        return { ok, reason: ok ? undefined : 'that approval is no longer open (answered in the chat, or timed out)' };
      }
      case 'mercury/call/ask': {
        const callId = typeof p.callId === 'string' ? p.callId.replace(/[^\w.-]/g, '').slice(0, 80) : '';
        const question = typeof p.question === 'string' ? p.question.trim().slice(0, 4000) : '';
        if (!callId || !question) throw new Error('callId and question are required');
        return { answer: await this.askDuringCall(callId, question) };
      }
      default:
        throw new Error(`Mercury does not support ${method}`);
    }
  }

  /** Run a Mercury turn for a question asked on a call; resolves with its answer. */
  private askDuringCall(callId: string, question: string): Promise<string> {
    const target = `call:${callId}`;
    const owner = this.defaultTarget();
    if (!owner) return Promise.resolve('No owner number is set, so Mercury can\'t act on this call.');
    return new Promise((resolve) => {
      const previous = this.callAsks.get(target);
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve('(superseded by a newer question)');
      }
      const giveUp = () => {
        // Waiting on the owner's approval isn't "stuck": keep the question open.
        if ([...this.callApprovals.values()].some((a) => a.callId === callId)) {
          const entry = this.callAsks.get(target);
          if (entry) entry.timer = setTimeout(giveUp, 30_000);
          return;
        }
        this.callAsks.delete(target);
        this.overflow.add(target);
        resolve('Mercury is still working on that. It will send the answer to WhatsApp when it\'s done.');
      };
      const timer = setTimeout(giveUp, 90_000);
      this.callAsks.set(target, { chunks: [], resolve, timer });
      const files = this.activeCalls.get(callId)?.files ?? [];
      const sentNote = files.length
        ? `\n[During this call the owner sent ${files.map((f) => `a ${f.kind === 'image' ? 'photo' : f.kind} (${f.name})`).join(', ')} in the WhatsApp chat; ${files.length === 1 ? 'it is' : 'they are'} attached to this message. "It", "this" or "the photo" means ${files.length === 1 ? 'that file' : 'the latest one'}.]`
        : '';
      this.emit({
        id: `call-${callId}-${Date.now()}`,
        channelId: `${this.type}:${target}`,
        channelType: this.type,
        senderId: digits(owner),
        senderRole: 'admin',
        content: `[Voice call: the owner asked this out loud. Use your tools to get the real answer: web_search for news and anything current, fetch_url, memory, skills. Then answer in one to three short spoken sentences, with no markdown, lists, links or code. Go ahead and do what they ask, including saving files or running things: if an action needs approval, Mercury asks the owner on the call and in the chat, and continues once they say yes. Don't ask them to confirm by message yourself.]${sentNote}\n${question}`,
        timestamp: Date.now(),
        metadata: { pluginId: this.manifest.id, voiceCall: true, callId, attachments: files.slice(-4), channelAccess: this.accessFor('admin'), channelGuidance: this.guidance('admin', false, true) },
      });
    });
  }

  /** The agent finished a turn (called by the agent for every channel that has endTask). */
  endTask(channelId: string): void {
    const target = channelId.startsWith(`${this.type}:`) ? channelId.slice(this.type.length + 1) : channelId;
    const ask = this.callAsks.get(target);
    if (ask) {
      clearTimeout(ask.timer);
      this.callAsks.delete(target);
      const answer = ask.chunks.filter((c) => !/^(☿|⚙|⏳|\s*\[)/.test(c.trim())).pop() ?? ask.chunks.pop() ?? '';
      ask.resolve(answer.trim() || 'Done.');
    }
    this.overflow.delete(target);
  }

  private onCallEnded(params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    this.activeCalls.delete(String(p.callId ?? ''));
    for (const [id, a] of this.callApprovals) if (a.callId === String(p.callId ?? '')) this.resolveCallApproval(id, 'no', 'timeout');
    const secs = typeof p.durationSec === 'number' ? Math.round(p.durationSec) : 0;
    const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    const outcome = String(p.outcome ?? '');
    const reason = typeof p.reason === 'string' ? p.reason.slice(0, 300) : '';
    let text: string;
    if (outcome === 'no_answer' || outcome === 'declined' || outcome === 'busy') {
      text = `📞 I tried to call you${reason ? ` about: ${reason}` : ''}. ${outcome === 'declined' ? 'You declined' : 'No answer'}, so here it is in writing.`;
    } else if (outcome.startsWith('failed') && secs === 0) {
      text = `📞 A call couldn't start: ${outcome.replace(/^failed:?\s*/, '') || 'unknown error'}.`;
    } else {
      const lines = (Array.isArray(p.transcript) ? p.transcript : [])
        .map((t) => t as { role?: unknown; text?: unknown })
        .filter((t) => typeof t.text === 'string' && t.text)
        .map((t) => `${t.role === 'owner' ? '🗣 You' : t.role === 'ask_mercury' ? '🔎 Asked Mercury' : '☿ Mercury'}: ${String(t.text).slice(0, 300)}`);
      let body = lines.join('\n');
      if (body.length > 2500) body = `…\n${body.slice(-2500)}`;
      text = `📞 Call ${p.direction === 'outgoing' ? 'to you' : 'with you'} ended · ${dur}${outcome.startsWith('failed') ? ` (${outcome})` : ''}${body ? `\n\n${body}` : ''}`;
    }
    void this.send(text).catch(() => {});
  }

  private onStatusNotification(params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const state = CHANNEL_STATES.includes(p.state as ChannelState) ? (p.state as ChannelState) : 'error';
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
    const prev = this.status.state;
    this.setStatus({
      state,
      detail: str(p.detail, 500),
      account: str(p.account, 100),
      qr: str(p.qr, 4000),
      pairCode: str(p.pairCode, 32),
      at: Date.now(),
    });
    if (state === 'connected' && prev === 'pairing') {
      // A fresh link (not a reconnect): confirm it where the owner set it up.
      this.notifyOwner(`✅ ${this.manifest.name} linked${this.status.account ? ` as +${this.status.account}` : ''}. Message that number from your own to talk to me. Settings: /plugins ${this.manifest.id}`);
    }
    if (state === 'logged-out' && prev !== 'logged-out') {
      this.notifyOwner(`⚠️ ${this.manifest.name} was logged out${this.status.detail ? `: ${this.status.detail}` : ''}. Link it again with /plugins pair ${this.manifest.id}.`);
    }
  }

  private setStatus(s: ChannelStatus): void {
    this.status = s;
    this.ready = s.state === 'connected';
    for (const fn of this.statusListeners) {
      try { fn(this.getStatus()); } catch { /* listener */ }
    }
  }

  /** Who may talk to Mercury here: 'admin' for the owner, 'member' for listed members, null otherwise. */
  roleOf(sender: string): 'admin' | 'member' | null {
    const s = this.settings();
    const d = digits(sender);
    if (!d) return null;
    if (d === digits(String(s.owner ?? ''))) return 'admin';
    const members = String(s.members ?? '').split(/[,\s]+/).map(digits).filter(Boolean);
    return members.includes(d) ? 'member' : null;
  }

  private onMessageNotification(p: IncomingParams): void {
    if (typeof p.chatId !== 'string' || typeof p.senderId !== 'string') return;
    if (p.fromMe === true) return; // never answer ourselves
    const id = typeof p.id === 'string' ? p.id : `${p.chatId}:${Date.now()}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);

    const settings = this.settings();
    if (p.isGroup === true && settings.allowGroups !== true) return;
    const sender = typeof p.senderPhone === 'string' && p.senderPhone ? p.senderPhone : p.senderId;
    const role = this.roleOf(sender);
    if (!role) {
      if (!digits(String(settings.owner ?? ''))) {
        logger.warn({ plugin: this.manifest.id }, 'Channel message ignored: no owner number set');
      }
      return; // unknown senders are ignored, silently
    }

    const text = typeof p.text === 'string' ? p.text.slice(0, 20_000) : '';
    if (role === 'admin' && p.isGroup !== true) this.ownerChatId = p.chatId;
    if (role === 'admin' && text && this.callApprovals.size) {
      const answer = normalizeReply(text);
      if (answer) {
        // The oldest open approval from a call; the chat reply answers it.
        const [approvalId] = this.callApprovals.keys();
        this.resolveCallApproval(approvalId, answer, 'chat');
        return;
      }
    }
    const pending = this.pending.get(p.chatId);
    if (pending && text) {
      const answer = normalizeReply(text);
      if (answer) {
        clearTimeout(pending.timer);
        this.pending.delete(p.chatId);
        pending.resolve(answer);
        return;
      }
    }

    const files = Array.isArray(p.attachments)
      ? (p.attachments as Array<Record<string, unknown>>)
        .filter((a) => typeof a?.path === 'string')
        .slice(0, 10)
        .map((a) => ({ path: a.path as string, kind: String(a.kind ?? 'document'), name: typeof a.name === 'string' ? a.name : basename(a.path as string), mime: typeof a.mime === 'string' ? a.mime : undefined }))
      : [];
    // Voice notes become text first (in arrival order per chat), then go to the agent.
    const voice = files.filter((f) => f.kind === 'voice' || f.kind === 'audio');
    const others = files.filter((f) => !voice.includes(f));
    const chatId = p.chatId;
    const prev = this.chatQueue.get(chatId) ?? Promise.resolve();
    const next = prev.then(async () => {
      let content = text;
      let voiceNote = false;
      for (const v of voice) {
        if (!this.transcribe) {
          await this.send('🎤 I can\'t listen to voice notes yet: that needs an OpenAI provider. Add your OpenAI key once in the dashboard (Providers) or with `mercury doctor`. Meanwhile, please type it.', `${this.type}:${chatId}`).catch(() => {});
          continue;
        }
        try {
          const said = await this.transcribe(v.path);
          if (said) {
            content = `${content}${content ? '\n' : ''}${said}`;
            voiceNote = true;
          }
        } catch (err) {
          await this.send(`🎤 I couldn't understand that voice note (${(err as Error).message.slice(0, 160)}). Could you type it?`, `${this.type}:${chatId}`).catch(() => {});
        }
      }
      // On a call: files sent in the chat belong to the conversation on the
      // phone. Keep them for the voice to ask about, and tell it they arrived.
      const call = role === 'admin' && others.length ? this.currentCall() : undefined;
      if (call) {
        call[1].files.push(...others);
        if (call[1].files.length > 8) call[1].files.splice(0, call[1].files.length - 8);
        const what = others.map((f) => (f.kind === 'image' ? 'a photo' : f.kind === 'document' ? `a document (${f.name})` : `a ${f.kind}`)).join(' and ');
        this.transport.notify?.('mercury/call/context', {
          callId: call[0],
          text: `The owner just sent ${what} in the WhatsApp chat${content ? ` with the message "${content.slice(0, 200)}"` : ''}. Mercury can see it: if they ask about it (or to confirm you got it), use ask_mercury.`,
        });
        if (!content) return; // a bare photo during a call is for the call, not a separate chat reply
      }
      if (others.length) {
        const list = others.map((f) => `${f.kind}: ${f.path}`).join('\n');
        content = `${content}${content ? '\n' : ''}[Attachments: the files are attached to this message; these are their paths on this computer]\n${list}`;
      }
      if (!content) return;
      this.emitMessage(id, p, sender, role, content, others, voiceNote);
    }).catch(() => {});
    this.chatQueue.set(chatId, next);
    void next.finally(() => { if (this.chatQueue.get(chatId) === next) this.chatQueue.delete(chatId); });
  }

  private chatQueue = new Map<string, Promise<void>>();

  private emitMessage(
    id: string,
    p: IncomingParams,
    sender: string,
    role: 'admin' | 'member',
    content: string,
    files: Array<{ path: string; kind: string; name: string; mime?: string }>,
    voiceNote: boolean,
  ): void {

    const msg: ChannelMessage = {
      id,
      channelId: `${this.type}:${p.chatId as string}`,
      channelType: this.type,
      senderId: sender,
      senderName: typeof p.senderName === 'string' ? p.senderName.slice(0, 100) : undefined,
      senderRole: role,
      content,
      timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
      metadata: {
        pluginId: this.manifest.id,
        chatId: p.chatId,
        isGroup: p.isGroup === true,
        attachments: files,
        voiceNote,
        channelAccess: this.accessFor(role),
        channelGuidance: this.guidance(role, p.isGroup === true) + (voiceNote ? '\nThey sent this as a voice note (transcribed above); reply in text as usual.' : ''),
      },
    };
    this.emit(msg);
  }

  // ── access levels ────────────────────────────────────────────────────

  /** The owner's level (chosen during setup; General until they pick Extended). */
  ownerAccess(): 'general' | 'extended' {
    return String(this.settings().access ?? 'general') === 'extended' ? 'extended' : 'general';
  }

  /** What a sender may do here. Members never exceed the owner's level. */
  accessFor(role: 'admin' | 'member'): 'general' | 'extended' {
    const owner = this.ownerAccess() === 'extended' ? 'extended' : 'general';
    if (role === 'admin') return owner;
    return owner === 'extended' && String(this.settings().memberAccess ?? 'general') === 'extended' ? 'extended' : 'general';
  }

  /** Told to the model every turn: where it is, who it's talking to, what it may do, how to write. */
  guidance(role: 'admin' | 'member', isGroup: boolean, voiceCall = false): string {
    const name = this.manifest.name;
    const who = role === 'admin' ? 'the owner (the person you work for)' : 'an approved member, not the owner';
    const where = voiceCall ? `a ${name} voice call` : `${name}${isGroup ? ', in a group chat' : ''}, a phone chat app`;
    const lines = [
      `## Channel: ${name}`,
      `You're talking with ${who} on ${where}.`,
      voiceCall
        ? 'Your answer is spoken aloud: one to three short sentences, no markdown, lists, links or code. Use your tools as usual during a call; approvals are asked on the call and answered by voice or in the chat.'
        : `Write like a text message: short and conversational. ${name} formatting only (*bold*, _italic_, ~strike~). No code blocks, tables, headings or long lists. If they need code, a document or long output, write it to a file and send it with send_file, then summarise it in a sentence. Never paste raw file contents, logs or stack traces.`,
    ];
    if (this.accessFor(role) === 'extended') {
      lines.push(role === 'admin'
        ? 'Access: Extended. Use your tools, skills, files and memory exactly as you would anywhere else; don\'t hold back because this is a chat app. For news, current events, prices or facts that may have changed, call web_search (kind "news" for headlines) and answer from the results. Actions that need approval are confirmed by the owner replying 1 (yes), 2 (no) or 3 (always) in this chat: ask once, clearly, saying what will happen.'
        : 'Access: Extended for members. You may use tools, but never share the owner\'s private details (memory, files, contacts, accounts) with this member unless the owner told you to.');
    } else {
      lines.push(role === 'admin'
        ? `Access: General. In this chat you have no tools, files or personal memory. Help with conversation and general knowledge. If something needs tools or personal context, say so in one line, and that they can switch this chat to Extended in /plugins ${this.manifest.id}.`
        : 'Access: General. You have no tools, files or memory here, and must not share anything personal about the owner. Help with general questions only. If they ask for more, say only the owner can allow it.');
    }
    return lines.join('\n');
  }

  // ── Channel ──────────────────────────────────────────────────────────

  async start(): Promise<void> { /* the plugin runtime drives the connection */ }
  async stop(): Promise<void> { /* stopped with the plugin */ }

  private chatOf(targetId?: string): string {
    const t = targetId ?? this.defaultTarget();
    if (!t) throw new Error(`${this.manifest.name}: no chat to send to (set the owner number in the plugin settings)`);
    return t.startsWith(`${this.type}:`) ? t.slice(this.type.length + 1) : t;
  }

  /** Notifications with no chat go to the owner's own chat. */
  private defaultTarget(): string | undefined {
    const owner = digits(String(this.settings().owner ?? ''));
    return owner ? `${owner}@s.whatsapp.net` : undefined;
  }

  async send(content: string, targetId?: string): Promise<void> {
    if (!content.trim()) return;
    const call = this.callTarget(targetId);
    if (call) {
      const ask = this.callAsks.get(call);
      if (ask) {
        ask.chunks.push(content);
        return;
      }
      // The call question timed out but the turn kept going: deliver in chat.
      return this.send(`📞 From your call:\n${content}`);
    }
    const chatId = this.chatOf(targetId);
    for (const chunk of splitMessage(toWhatsAppText(content))) {
      await this.transport.request('mercury/channel/send', { chatId, text: chunk }, SEND_TIMEOUT_MS);
    }
  }

  /**
   * A tool started in a turn for this channel. On a call, the plugin is told
   * what Mercury is doing so the voice can say "still searching the web…"
   * instead of leaving the caller in silence.
   */
  toolStarted(channelId: string, toolName: string): void {
    const call = this.callTarget(channelId);
    if (!call) return;
    this.transport.notify?.('mercury/call/progress', { callId: call.slice('call:'.length), activity: describeTool(toolName) });
  }

  /** `whatsapp:call:<id>` → `call:<id>`; undefined for normal chats. */
  private callTarget(targetId?: string): string | undefined {
    if (!targetId) return undefined;
    const t = targetId.startsWith(`${this.type}:`) ? targetId.slice(this.type.length + 1) : targetId;
    return t.startsWith('call:') ? t : undefined;
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
    if (this.callTarget(targetId)) targetId = undefined; // files from a call go to the owner's chat
    if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error(`Not a file: ${filePath}`);
    if (statSync(filePath).size > FILE_LIMIT_BYTES) throw new Error('File is larger than 100 MB');
    await this.transport.request('mercury/channel/sendFile', { chatId: this.chatOf(targetId), path: filePath }, FILE_TIMEOUT_MS);
  }

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    // WhatsApp can't edit a message as it streams: send the whole reply.
    let full = '';
    for await (const chunk of content) full += chunk;
    await this.send(full, targetId);
    return full;
  }

  async typing(targetId?: string): Promise<void> {
    if (this.callTarget(targetId)) return;
    try {
      await this.transport.request('mercury/channel/typing', { chatId: this.chatOf(targetId), on: true }, 10_000);
    } catch { /* cosmetic */ }
  }

  private ask(prompt: string, targetId: string | undefined): Promise<string> {
    const chatId = this.chatOf(targetId);
    const previous = this.pending.get(chatId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve('no');
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(chatId);
        resolve('no');
      }, APPROVAL_TIMEOUT_MS);
      this.pending.set(chatId, { resolve, timer });
      this.send(prompt, targetId).catch(() => {
        clearTimeout(timer);
        this.pending.delete(chatId);
        resolve('no');
      });
    });
  }

  /** Approval prompt answered by text: 1/yes, 2/no, 3/always. No reply in 2 minutes is no. */
  async askPermission(prompt: string, targetId?: string): Promise<string> {
    const call = this.callTarget(targetId);
    if (call) return this.askOnCall(call.slice('call:'.length), prompt);
    return this.ask(`🔐 ${prompt}\n\nReply *1* (yes), *2* (no) or *3* (always for this chat).`, targetId);
  }

  /**
   * An approval needed by a turn running for a call: asked by voice and in
   * the chat at once. A spoken yes approves this once (never "always").
   */
  private askOnCall(callId: string, prompt: string): Promise<string> {
    const approvalId = `ap${++this.approvalSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolveCallApproval(approvalId, 'no', 'timeout'), APPROVAL_TIMEOUT_MS);
      this.callApprovals.set(approvalId, { callId, prompt, resolve, timer });
      this.transport.notify?.('mercury/call/approval', { callId, approvalId, prompt: prompt.slice(0, 600) });
      const chat = this.ownerChatId ? `${this.type}:${this.ownerChatId}` : undefined;
      void this.send(`🔐 From your call: ${prompt}\n\nSay *yes* on the call, or reply *1* (yes) or *2* (no) here.`, chat).catch(() => {});
    });
  }

  private resolveCallApproval(approvalId: string, answer: string, via: 'voice' | 'chat' | 'timeout'): boolean {
    const a = this.callApprovals.get(approvalId);
    if (!a) return false;
    clearTimeout(a.timer);
    this.callApprovals.delete(approvalId);
    // A spoken answer never widens to "always".
    const decision = via === 'voice' && answer === 'always' ? 'yes' : answer;
    a.resolve(decision);
    this.transport.notify?.('mercury/call/approval-resolved', { callId: a.callId, approvalId, decision, via });
    if (via === 'chat') {
      void this.send(decision === 'no' ? '✖ Declined. I told the call.' : '✅ Approved. Carrying on in the call.', this.ownerChatId ? `${this.type}:${this.ownerChatId}` : undefined).catch(() => {});
    }
    return true;
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
    if (this.callTarget(targetId)) return false;
    return (await this.ask(`${question}\n\nReply *yes* to continue or *no* to stop.`, targetId)) !== 'no';
  }

  // ── owner actions ────────────────────────────────────────────────────

  async pair(method: 'qr' | 'code', phone?: string): Promise<void> {
    await this.transport.request('mercury/channel/pair', { method, ...(phone ? { phone: digits(phone) } : {}) }, 30_000);
  }

  async unlink(): Promise<void> {
    await this.transport.request('mercury/channel/unlink', {}, 30_000);
  }
}

/**
 * Who Mercury is on a call: its soul and persona, trimmed. Read fresh for
 * each call so edits to the soul files apply to the next call.
 */
export function voiceBriefing(): string {
  const parts: string[] = [];
  for (const name of ['soul.md', 'persona.md']) {
    try {
      const text = readFileSync(join(getMercuryHome(), 'soul', name), 'utf8').trim();
      if (text) parts.push(text.slice(0, 1500));
    } catch { /* optional */ }
  }
  return parts.length ? `Who you are (from Mercury's soul files; keep this voice on the call):\n${parts.join('\n\n')}` : '';
}
