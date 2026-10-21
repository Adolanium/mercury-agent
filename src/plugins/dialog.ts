/**
 * Guided plugin dialogs: setup right after install, and the `/plugins <id>`
 * menu. One engine for every plugin and every surface. The plugin's
 * manifest says which settings to ask about (`setup: true`), in what words
 * (`label`, `optionLabels`), and whether a channel needs linking; nobody has
 * to remember per-plugin commands.
 *
 * A dialog is a stack of steps. Each step renders a prompt (text plus
 * numbered options, or free text) and handles one answer. Chats render the
 * options as buttons where they can (Telegram) and as a numbered list
 * elsewhere (WhatsApp, terminal); a reply of "2", the option's words, or a
 * button tap all work.
 */
import type { PluginService } from './service.js';
import { whenMatches, type PluginListItem } from './types.js';

export interface DialogOption {
  label: string;
  value: string;
}

export interface DialogPrompt {
  text: string;
  options?: DialogOption[];
  /** Free-text answer expected (a number, a name); options may still be offered. */
  freeText?: string;
}

interface Step {
  /** False to skip this step (a setting that doesn't apply to the current choices). */
  applies?(): Promise<boolean>;
  prompt(): Promise<DialogPrompt>;
  /** Handle an answer. Return a message to show before the next prompt, if any. */
  answer(input: string, option: DialogOption | undefined): Promise<StepOutcome>;
}

type StepOutcome =
  | { kind: 'next'; message?: string }
  | { kind: 'retry'; message: string }
  | { kind: 'push'; steps: Step[]; message?: string }
  | { kind: 'done'; message?: string };

type Setting = NonNullable<PluginListItem['settings']>[number];

const CANCEL = new Set(['cancel', 'stop', 'exit', 'quit', 'close', 'done', '0']);

export class PluginDialog {
  private steps: Step[] = [];
  private lastPrompt: DialogPrompt | null = null;
  readonly startedAt = Date.now();

  private constructor(readonly pluginId: string, readonly title: string, private readonly svc: PluginService, private readonly admin: boolean) {}

  /** Setup: each `setup: true` setting in order, then linking for channel plugins. */
  static async setup(svc: PluginService, id: string): Promise<PluginDialog | null> {
    const info = await svc.info(id);
    if (!info?.installedVersion) return null;
    const d = new PluginDialog(id, `${info.name} setup`, svc, true);
    const missing = new Set((info.missing ?? []).map((m) => m.key));
    // A setting with setupWhenMissing is only asked while that requirement is
    // missing (with an OpenAI key, the default voice just works).
    const fields = (info.settings ?? []).filter((s) => s.setup && (!s.setupWhenMissing || missing.has(s.setupWhenMissing)));
    fields.forEach((f, i) => d.steps.push(d.settingStep(f, { index: i + 1, total: fields.length + (info.channel ? 1 : 0), setup: true })));
    if (info.channel) d.steps.push(d.linkStep(info, true));
    d.steps.push(d.finishStep(info));
    if (d.steps.length === 1 && !info.channel && !fields.length) return null;
    return d;
  }

  /** The `/plugins <id>` menu. Members see status only. */
  static async menu(svc: PluginService, id: string, admin: boolean): Promise<PluginDialog | null> {
    const info = await svc.info(id);
    if (!info) return null;
    const d = new PluginDialog(id, info.name, svc, admin);
    d.steps.push(d.menuStep());
    return d;
  }

  // ── engine ───────────────────────────────────────────────────────────

  /** The prompt to show now, or null when the dialog has finished. */
  async current(): Promise<DialogPrompt | null> {
    while (this.steps[0]?.applies && !(await this.steps[0].applies())) this.steps.shift();
    const step = this.steps[0];
    if (!step) return null;
    this.lastPrompt = await step.prompt();
    return this.lastPrompt;
  }

  /** Feed one answer. Returns text to show (outcome message, then the next prompt is fetched by the caller). */
  async answer(raw: string): Promise<{ message?: string; finished: boolean }> {
    const input = raw.trim();
    if (CANCEL.has(input.toLowerCase())) {
      this.steps = [];
      return { message: 'Closed.', finished: true };
    }
    const step = this.steps[0];
    if (!step) return { finished: true };
    const option = this.match(input);
    let outcome: StepOutcome;
    try {
      outcome = await step.answer(input, option);
    } catch (err) {
      outcome = { kind: 'retry', message: `✗ ${(err as Error).message}` };
    }
    switch (outcome.kind) {
      case 'retry':
        return { message: outcome.message, finished: false };
      case 'next':
        this.steps.shift();
        return { message: outcome.message, finished: this.steps.length === 0 };
      case 'push':
        this.steps.shift();
        this.steps.unshift(...outcome.steps);
        return { message: outcome.message, finished: this.steps.length === 0 };
      case 'done':
        this.steps = [];
        return { message: outcome.message, finished: true };
    }
  }

  private match(input: string): DialogOption | undefined {
    const opts = this.lastPrompt?.options ?? [];
    const t = input.toLowerCase().replace(/^\/plugins\s+pick\s+/, '');
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= opts.length) return opts[n - 1];
    return opts.find((o) => o.value.toLowerCase() === t || o.label.toLowerCase() === t || o.label.toLowerCase().split(/[:·(]/)[0].trim() === t);
  }

  // ── steps ────────────────────────────────────────────────────────────

  private settingStep(s: Setting, ctx: { index?: number; total?: number; setup?: boolean } = {}): Step {
    const title = s.label ?? s.key;
    const counter = ctx.index ? ` (${ctx.index}/${ctx.total})` : '';
    const current = s.type === 'secret' ? (s.isSet ? 'set ✓' : 'not set') : s.value === undefined || s.value === '' ? 'not set' : String(s.optionLabels?.[String(s.value)] ?? s.value);
    const hasValue = s.type === 'secret' ? !!s.isSet : s.value !== undefined && s.value !== '';
    const keep = ctx.setup && hasValue ? [{ label: `Keep: ${current}`, value: '__keep' }] : [];
    return {
      applies: async () => settingApplies(s, (await this.svc.info(this.pluginId))?.settings ?? []),
      prompt: async () => {
        if (s.type === 'secret') {
          const head = `${ctx.setup ? `⚙️ ${this.title}${counter}\n` : ''}*${title}*${s.description ? `\n${s.description}` : ''}`;
          return {
            text: `${head}\nNow: ${current}`,
            freeText: 'Paste the key here. It\'s stored with Mercury\'s keys (never shown again), and only this plugin can use it. You can delete your message afterwards.',
            options: keep.length ? keep : (s.required ? undefined : [{ label: 'Skip', value: '__keep' }]),
          };
        }
        const head = `${ctx.setup ? `⚙️ ${this.title}${counter}\n` : ''}*${title}*${s.description ? `\n${s.description}` : ''}`;
        if (s.type === 'enum') {
          return { text: `${head}\nNow: ${current}`, options: (s.options ?? []).map((o) => ({ label: s.optionLabels?.[o] ?? o, value: o })) };
        }
        if (s.type === 'boolean') {
          return { text: `${head}\nNow: ${s.value === true ? 'yes' : 'no'}`, options: [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }] };
        }
        const hint = s.format === 'phone' ? 'Reply with the number, including the country code (e.g. +15551234567).' : `Reply with the new value${s.type === 'number' ? ' (a number)' : ''}.`;
        return { text: `${head}\nNow: ${current}`, freeText: hint, options: keep.length ? keep : (ctx.setup && !s.required ? [{ label: 'Skip', value: '__keep' }] : undefined) };
      },
      answer: async (input, option) => {
        if (option?.value === '__keep') return { kind: 'next' };
        if (s.type === 'secret') {
          if (!input || input.length < 8) return { kind: 'retry', message: 'Paste the whole key, or reply "skip".' };
          await this.svc.setSetting(this.pluginId, s.key, input.trim());
          return { kind: 'next', message: `✅ ${title} saved.` };
        }
        let value: string;
        if (s.type === 'enum' || s.type === 'boolean') {
          if (!option) return { kind: 'retry', message: 'Reply with one of the numbers.' };
          value = option.value;
        } else {
          if (!input) return { kind: 'retry', message: 'Reply with a value.' };
          value = input;
        }
        await this.svc.setSetting(this.pluginId, s.key, s.type === 'boolean' ? value === 'true' : s.type === 'number' ? Number(value) : value);
        const shown = s.type === 'enum' ? (s.optionLabels?.[value] ?? value).split(':')[0] : s.type === 'boolean' ? (value === 'true' ? 'yes' : 'no') : value;
        return { kind: 'next', message: `✅ ${title}: ${shown}` };
      },
    };
  }

  private linkStep(info: PluginListItem, setup: boolean): Step {
    return {
      prompt: async () => {
        const st = await this.svc.channelStatus(this.pluginId).catch(() => null);
        if (st?.state === 'connected') {
          return { text: `*Link account*\nAlready linked${st.account ? ` as +${st.account}` : ''}.`, options: [{ label: 'Continue', value: 'skip' }] };
        }
        return {
          text: `${setup ? `⚙️ ${this.title}\n` : ''}*Link the ${info.name} account Mercury runs on*\nUse a spare number, not your main one: the protocol is unofficial.`,
          options: [
            { label: 'Pairing code: type it on the spare phone', value: 'code' },
            { label: 'QR code: scan it (dashboard or `mercury plugins pair`)', value: 'qr' },
            { label: 'Later', value: 'skip' },
          ],
        };
      },
      answer: async (_input, option) => {
        if (!option) return { kind: 'retry', message: 'Reply 1, 2 or 3.' };
        if (option.value === 'skip') return { kind: 'next' };
        if (option.value === 'qr') {
          return { kind: 'next', message: `Open the dashboard → Plugins → ${info.name} → Link with QR code, or run \`mercury plugins pair ${this.pluginId}\` in a terminal.` };
        }
        return { kind: 'push', steps: [this.pairCodeStep(info)] };
      },
    };
  }

  private pairCodeStep(info: PluginListItem): Step {
    return {
      prompt: async () => ({ text: `*Which number will Mercury run on?*`, freeText: 'Reply with the spare number, including the country code.' }),
      answer: async (input) => {
        const digits = input.replace(/[^\d]/g, '');
        if (digits.length < 7) return { kind: 'retry', message: 'That doesn\'t look like a phone number. Include the country code, e.g. +639171234567.' };
        const st = await this.svc.pair(this.pluginId, { method: 'code', phone: digits });
        if (st.state === 'connected') return { kind: 'next', message: `Already linked${st.account ? ` as +${st.account}` : ''}.` };
        if (!st.pairCode) return { kind: 'retry', message: `Couldn't get a code${st.detail ? `: ${st.detail}` : ''}. Try again, or reply "later".` };
        return {
          kind: 'next',
          message: `🔗 Pairing code: *${st.pairCode}*\nOn the spare phone: ${info.name} → Settings → Linked devices → Link a device → Link with phone number instead, then type the code. It's valid for about 3 minutes; I'll confirm when it's linked.`,
        };
      },
    };
  }

  private finishStep(info: PluginListItem): Step {
    return {
      prompt: async () => ({
        text: `✅ ${info.name} is set up.\nOpen its menu anytime with /plugins ${this.pluginId} to change settings, link or unlink, or turn it off.`,
        options: [{ label: 'Done', value: 'done' }],
      }),
      answer: async () => ({ kind: 'done' }),
    };
  }

  private menuStep(): Step {
    return {
      prompt: async () => {
        const i = (await this.svc.info(this.pluginId))!;
        const lines = [`🧩 *${i.name}* ${i.installedVersion ?? i.latestVersion ?? ''}`, i.description];
        const status = i.installedVersion ? (i.enabled ? (i.status === 'enabled' ? 'on' : i.status) : 'off') : 'not installed';
        lines.push('', `Status: ${status}`);
        if (i.channel) lines.push(`Account: ${i.channel.state === 'connected' ? `linked${i.channel.account ? ` as +${i.channel.account}` : ''}` : (i.channel.state ?? 'not linked')}`);
        for (const g of i.settingGroups ?? []) {
          const first = (i.settings ?? []).find((x) => x.group === g.id && x.type === 'enum');
          const choice = first ? String(first.optionLabels?.[String(first.value)] ?? first.value ?? '').split(':')[0] : '';
          lines.push(`${g.label}: ${g.ready ? 'ready ✓' : 'not set up ⚠'}${choice ? ` (${choice})` : ''}`);
        }
        for (const s of (i.settings ?? []).filter((x) => !x.group && (x.setup || x.label) && settingApplies(x, i.settings ?? []))) {
          const v = s.type === 'secret' ? (s.isSet ? 'set ✓' : 'not set') : s.value === undefined || s.value === '' ? 'not set' : s.type === 'boolean' ? (s.value ? 'yes' : 'no') : String(s.optionLabels?.[String(s.value)]?.split(':')[0] ?? s.value);
          lines.push(`${s.label ?? s.key}: ${v}`);
        }
        for (const m of i.missing ?? []) lines.push(`⚠️ ${m.unlocks} is off: needs ${m.needs}.`);
        const options: DialogOption[] = [];
        if (!this.admin) return { text: lines.join('\n') };
        if (!i.installedVersion) {
          options.push({ label: 'Install', value: 'install' });
        } else {
          for (const g of i.settingGroups ?? []) options.push({ label: `${g.label}${g.ready ? '' : ' ⚠ set up'}`, value: `group:${g.id}` });
          if (i.settings?.some((x) => !x.group)) options.push({ label: 'Change a setting', value: 'settings' });
          if (i.channel && i.enabled) {
            if (i.channel.state === 'connected') {
              options.push({ label: 'Send me a test message', value: 'test' });
              options.push({ label: 'Unlink the account', value: 'unlink' });
            } else {
              options.push({ label: 'Link the account', value: 'link' });
            }
          }
          if (i.settings?.some((s) => s.setup)) options.push({ label: 'Run setup again', value: 'setup' });
          if (i.status === 'update-available') options.push({ label: `Update to ${i.latestVersion}`, value: 'update' });
          options.push(i.enabled ? { label: 'Turn off', value: 'disable' } : { label: 'Turn on', value: 'enable' });
          options.push({ label: 'Uninstall', value: 'uninstall' });
        }
        options.push({ label: 'Close', value: 'close' });
        return { text: lines.join('\n'), options };
      },
      answer: async (_input, option) => {
        if (!this.admin) return { kind: 'done' };
        if (!option) return { kind: 'retry', message: 'Reply with one of the numbers, or "cancel".' };
        const i = (await this.svc.info(this.pluginId))!;
        if (option.value.startsWith('group:')) {
          const gid = option.value.slice('group:'.length);
          return { kind: 'push', steps: [...this.groupSteps(i, gid), this.menuStep()] };
        }
        switch (option.value) {
          case 'close':
            return { kind: 'done', message: 'Closed.' };
          case 'settings':
            return { kind: 'push', steps: [this.pickSettingStep(i), this.menuStep()] };
          case 'link':
            return { kind: 'push', steps: [this.linkStep(i, false), this.menuStep()] };
          case 'setup': {
            const d = await PluginDialog.setup(this.svc, this.pluginId);
            return d ? { kind: 'push', steps: d.steps } : { kind: 'retry', message: 'Nothing to set up.' };
          }
          case 'test':
            return { kind: 'push', steps: [this.menuStep()], message: `✅ ${await this.svc.testChannel(this.pluginId)}` };
          case 'unlink':
            return { kind: 'push', steps: [this.confirmStep(`Log Mercury out of this ${i.name} account? You can link it again later.`, async () => { await this.svc.unlink(this.pluginId); return '🔌 Unlinked.'; }), this.menuStep()] };
          case 'update': {
            const changed = await this.svc.update(this.pluginId);
            return { kind: 'push', steps: [this.menuStep()], message: changed.length ? `⬆️ Updated to ${changed[0].to}.` : 'Already up to date.' };
          }
          case 'enable':
            await this.svc.enable(this.pluginId);
            return { kind: 'push', steps: [this.menuStep()], message: '▶️ Turned on.' };
          case 'disable':
            await this.svc.disable(this.pluginId);
            return { kind: 'push', steps: [this.menuStep()], message: '⏸ Turned off. Its data and settings are kept.' };
          case 'uninstall':
            return { kind: 'push', steps: [this.uninstallStep(i)] };
          case 'install': {
            const r = await this.svc.install(this.pluginId);
            const setup = await PluginDialog.setup(this.svc, r.id);
            return setup ? { kind: 'push', steps: setup.steps, message: `✅ Installed ${r.name} ${r.version}.` } : { kind: 'push', steps: [this.menuStep()], message: `✅ Installed ${r.name} ${r.version}.` };
          }
          default:
            return { kind: 'retry', message: 'Reply with one of the numbers.' };
        }
      },
    };
  }

  /** A menu section: its intro, then each of its settings that applies (keys asked only when needed). */
  private groupSteps(i: PluginListItem, gid: string): Step[] {
    const g = (i.settingGroups ?? []).find((x) => x.id === gid);
    const fields = (i.settings ?? []).filter((x) => x.group === gid);
    const intro: Step = {
      prompt: async () => ({
        text: `*${g?.label ?? gid}*${g?.description ? `\n${g.description}` : ''}\nNow: ${g?.ready ? 'ready ✓' : 'not set up yet ⚠'}`,
        options: [{ label: 'Change it', value: 'go' }, { label: 'Back', value: 'back' }],
      }),
      answer: async (_input, option) => {
        if (!option) return { kind: 'retry', message: 'Reply 1 or 2.' };
        return option.value === 'back' ? { kind: 'done' } : { kind: 'next' };
      },
    };
    // Re-read each setting fresh, so a key question follows the engine just chosen.
    const steps = fields.map((f, n) => this.liveSettingStep(f.key, { index: n + 1, total: fields.length }));
    return [intro, ...steps];
  }

  /** A setting step that looks the setting up when it's reached (values may have changed since). */
  private liveSettingStep(key: string, ctx: { index: number; total: number }): Step {
    let inner: Step | null = null;
    const load = async () => {
      const s = (await this.svc.info(this.pluginId))?.settings?.find((x) => x.key === key);
      inner = s ? this.settingStep(s, { setup: true }) : null;
      return inner;
    };
    return {
      applies: async () => { const st = await load(); return st ? (st.applies ? st.applies() : true) : false; },
      prompt: async () => (inner ?? (await load()))!.prompt(),
      answer: async (input, option) => (inner ?? (await load()))!.answer(input, option),
    };
  }

  private pickSettingStep(i: PluginListItem): Step {
    const settings = (i.settings ?? []).filter((x) => !x.group && settingApplies(x, i.settings ?? []));
    return {
      prompt: async () => ({
        text: '*Which setting?*',
        options: [...settings.map((s) => ({ label: s.label ?? s.key, value: s.key })), { label: 'Back', value: '__back' }],
      }),
      answer: async (_input, option) => {
        if (!option) return { kind: 'retry', message: 'Reply with one of the numbers.' };
        if (option.value === '__back') return { kind: 'next' };
        const fresh = (await this.svc.info(this.pluginId))?.settings?.find((s) => s.key === option.value);
        return fresh ? { kind: 'push', steps: [this.settingStep(fresh)] } : { kind: 'retry', message: 'That setting is gone.' };
      },
    };
  }

  private confirmStep(question: string, run: () => Promise<string>): Step {
    return {
      prompt: async () => ({ text: question, options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] }),
      answer: async (_input, option) => {
        if (!option) return { kind: 'retry', message: 'Reply 1 (yes) or 2 (no).' };
        return option.value === 'yes' ? { kind: 'next', message: await run() } : { kind: 'next' };
      },
    };
  }

  private uninstallStep(i: PluginListItem): Step {
    return {
      prompt: async () => ({
        text: `Uninstall ${i.name}?`,
        options: [
          { label: 'Uninstall, keep its data and settings', value: 'keep' },
          { label: 'Uninstall and delete its data', value: 'purge' },
          { label: 'Cancel', value: 'cancel' },
        ],
      }),
      answer: async (_input, option) => {
        if (!option) return { kind: 'retry', message: 'Reply 1, 2 or 3.' };
        if (option.value === 'cancel') return { kind: 'push', steps: [this.menuStep()] };
        await this.svc.uninstall(this.pluginId, option.value === 'purge');
        return { kind: 'done', message: `🗑 Uninstalled ${i.name}${option.value === 'purge' ? ' and deleted its data' : ''}.` };
      },
    };
  }
}

/** Does a setting apply, given the current values of the settings it depends on (`when`)? */
export function settingApplies(s: Setting, all: Setting[]): boolean {
  return whenMatches(s.when, Object.fromEntries(all.map((x) => [x.key, x.value])));
}

/** Plain-text rendering (WhatsApp, terminal, any chat without buttons). */
export function renderPrompt(p: DialogPrompt, buttons: boolean): string {
  const lines = [p.text];
  if (p.freeText) lines.push('', p.freeText);
  if (p.options?.length && !buttons) {
    lines.push('', ...p.options.map((o, i) => `*${i + 1}* · ${o.label}`), '', p.freeText ? 'Or reply with a number. "cancel" to stop.' : 'Reply with a number, or "cancel".');
  }
  return lines.join('\n');
}
