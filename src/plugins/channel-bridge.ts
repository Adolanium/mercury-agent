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
 */
import { basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
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
  private seen = new Set<string>();
  private statusListeners = new Set<(s: ChannelStatus) => void>();

  constructor(
    private readonly manifest: PluginManifest,
    private readonly transport: ChannelTransport,
    /** The plugin's current settings (owner, members, allowGroups). */
    private readonly settings: () => Record<string, unknown>,
    private readonly notifyOwner: (message: string) => void,
  ) {
    super();
    this.type = manifest.contributes.channel!.type as ChannelType;
  }

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
    let content = text;
    if (files.length) {
      const list = files.map((f) => `${f.kind}: ${f.path}`).join('\n');
      content = `${content}${content ? '\n' : ''}[Attachments]\n${list}`;
    }
    if (!content) return;

    const msg: ChannelMessage = {
      id,
      channelId: `${this.type}:${p.chatId}`,
      channelType: this.type,
      senderId: sender,
      senderName: typeof p.senderName === 'string' ? p.senderName.slice(0, 100) : undefined,
      senderRole: role,
      content,
      timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
      metadata: { pluginId: this.manifest.id, chatId: p.chatId, isGroup: p.isGroup === true, attachments: files },
    };
    this.emit(msg);
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
    const chatId = this.chatOf(targetId);
    for (const chunk of splitMessage(toWhatsAppText(content))) {
      await this.transport.request('mercury/channel/send', { chatId, text: chunk }, SEND_TIMEOUT_MS);
    }
  }

  async sendFile(filePath: string, targetId?: string): Promise<void> {
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
    return this.ask(`🔐 ${prompt}\n\nReply *1* (yes), *2* (no) or *3* (always for this chat).`, targetId);
  }

  async askToContinue(question: string, targetId?: string): Promise<boolean> {
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
