/**
 * Mercury plugin system: manifest v1, plugin API v1 and on-disk state.
 *
 * A plugin is a folder with a `mercury-plugin.json` manifest. It is either
 *   - in-process: one self-contained ES module loaded into the daemon with
 *     `import()`, talking to Mercury only through the `PluginContext` it is
 *     given in `activate(ctx)`; or
 *   - out-of-process: a child process speaking MCP (JSON-RPC 2.0) over stdio.
 *     A crash or hang there can never take the daemon down.
 *
 * In-process plugins must be bundled into a single file: a compiled Mercury
 * binary cannot resolve packages for them (verified: `import 'zod'` from a
 * plugin fails inside `bun build --compile` output). Anything a plugin needs
 * from Mercury comes through the context.
 */
import { z } from 'zod';
import semver from 'semver';

/** Manifest format version this Mercury understands. */
export const MANIFEST_VERSION = 1 as const;

/**
 * Plugin API (the PluginContext / MCP contract) this Mercury implements.
 * Minor bumps only add; a major bump is a breaking change and the previous
 * major stays supported for at least two Mercury minor releases.
 */
export const PLUGIN_API_VERSION = '1.1.0';

export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
/** Tool and command names a plugin declares (before namespacing). */
export const PLUGIN_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,29}$/;
/**
 * Built-in command names a plugin can never take. Kept in sync with the
 * TUI's SLASH_COMMANDS by src/plugins/commands.test.ts.
 */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set([
  'agents', 'bg', 'bot', 'bots', 'budget', 'chat', 'cloud', 'code', 'halt', 'help', 'log', 'memory', 'menu', 'models', 'model',
  'permissions', 'plugin', 'plugins', 'progress', 'research', 'reset', 'saver', 'session', 'sessions', 'skills', 'spotify',
  'status', 'stop', 'stream', 'tools', 'update', 'view', 'whatsnew', 'ws', 'start', 'skip', 'new', 'compact', 'clear',
  'approve', 'deny', 'yes', 'no', 'cancel', 'pair', 'unpair', 'telegram', 'discord', 'slack', 'signal', 'web', 'exit', 'quit',
  'usage', 'cost', 'doctor', 'settings', 'config', 'login', 'logout', 'upgrade', 'version', 'about',
]);

/** Channel types a plugin may provide (Plugin API 1.1). */
export const PLUGIN_CHANNEL_TYPES = ['whatsapp'] as const;
export type PluginChannelType = (typeof PLUGIN_CHANNEL_TYPES)[number];

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const PLATFORM_KEYS = [
  'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'android-arm64',
] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

/** Relative path inside the plugin folder: no absolute paths, no `..`. */
const relPath = z.string().min(1).max(200).refine(
  (p) => !p.startsWith('/') && !/^[a-zA-Z]:/.test(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0'),
  'must be a relative path inside the plugin folder',
);

const strictSemver = z.string().refine((v) => semver.valid(v) !== null && semver.clean(v) === v, 'must be a semver version like 1.2.3');
const semverRange = z.string().min(1).max(100).refine((r) => semver.validRange(r) !== null, 'must be a semver range like ">=1.4.0 <2.0.0"');

const toolDecl = z.object({
  name: z.string().regex(PLUGIN_TOOL_NAME_RE, 'lowercase letters, digits and underscores, max 30 characters'),
  description: z.string().min(1).max(1024),
  /** Read-only tools skip approval and are available in plan mode. */
  readOnly: z.boolean().default(false),
  /** Per-call timeout; capped by Mercury at 300s. */
  timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
}).strict();

const commandDecl = z.object({
  name: z.string().regex(PLUGIN_TOOL_NAME_RE),
  description: z.string().min(1).max(200),
}).strict();

const settingField = z.object({
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  description: z.string().max(300).default(''),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).max(50).optional(),
}).strict();

const settingKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/);

const settingsMigration = z.object({
  /** The settings version this step produces. */
  to: z.number().int().min(2).max(1000),
  /** old key → new key; the value moves over. */
  rename: z.record(settingKey, settingKey).default({}),
  /** Keys that no longer exist. */
  remove: z.array(settingKey).max(100).default([]),
  /** Values that change, old → new, per key (e.g. an enum option renamed). */
  mapValues: z.record(settingKey, z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).default({}),
}).strict();

const serverSpec = z.object({
  /** `node` (Mercury's own runtime) or a path inside the plugin folder. */
  command: z.union([z.literal('node'), relPath]),
  args: z.array(z.string().max(500)).max(32).default([]),
}).strict();

export const manifestSchema = z.object({
  manifestVersion: z.literal(MANIFEST_VERSION),
  id: z.string().regex(PLUGIN_ID_RE, '3-32 characters: lowercase letters, digits and hyphens, starting with a letter'),
  name: z.string().min(1).max(60),
  version: strictSemver,
  description: z.string().min(1).max(280),
  kind: z.enum(['in-process', 'out-of-process']),
  author: z.string().max(100).optional(),
  homepage: z.string().url().max(300).optional(),
  license: z.string().max(60).optional(),
  engines: z.object({
    mercury: semverRange,
    pluginApi: semverRange.default('^1.0.0'),
  }).strict(),
  /** Omit to support every platform Mercury runs on. */
  platforms: z.array(z.enum(PLATFORM_KEYS)).min(1).optional(),
  /** In-process: the bundled ES module that exports `activate`. */
  entry: relPath.optional(),
  /** Out-of-process: how to start the MCP server, optionally per platform. */
  server: serverSpec.extend({
    platforms: z.record(z.enum(PLATFORM_KEYS), serverSpec).optional(),
  }).optional(),
  contributes: z.object({
    tools: z.array(toolDecl).max(64).default([]),
    commands: z.array(commandDecl).max(32).default([]),
    /**
     * Plugin API 1.1: an out-of-process plugin can be a chat channel. Only
     * channel types Mercury knows (sessions, approvals and the work ledger
     * are keyed by them) can be provided by a plugin.
     */
    channel: z.object({ type: z.enum(PLUGIN_CHANNEL_TYPES) }).strict().optional(),
  }).strict().default({ tools: [], commands: [] }),
  /** What the plugin needs. Shown to the owner before install. */
  permissions: z.object({
    /** Hosts the plugin may reach through ctx.fetch, e.g. "api.example.com" or "*.example.com". */
    network: z.array(z.string().min(1).max(253)).max(32).default([]),
    /** Secret names from ~/.mercury/.env the plugin may read. Nothing else is visible to it. */
    secrets: z.array(z.string().regex(SECRET_NAME_RE)).max(16).default([]),
  }).strict().default({ network: [], secrets: [] }),
  settings: z.object({
    /** Bump when a field is renamed, removed or changes meaning, and add a migration. */
    version: z.number().int().min(1).max(1000).default(1),
    fields: z.record(settingKey, settingField).default({}),
    /**
     * Declarative upgrades for saved settings, applied in order when the saved
     * version is older. No code runs: an out-of-process plugin can migrate
     * too, and a bad migration can't touch anything but its own settings.
     */
    migrations: z.array(settingsMigration).max(100).default([]),
  }).strict().optional(),
  /** Native files inside the package whose SHA-256 is checked at install and before every start. */
  checksums: z.record(relPath, z.string().regex(/^[a-f0-9]{64}$/)).optional(),
}).strict().superRefine((m, ctx) => {
  if (m.kind === 'in-process' && !m.entry) ctx.addIssue({ code: 'custom', path: ['entry'], message: 'in-process plugins need an "entry" module' });
  if (m.kind === 'in-process' && m.server) ctx.addIssue({ code: 'custom', path: ['server'], message: 'in-process plugins cannot declare a "server"' });
  if (m.kind === 'out-of-process' && !m.server) ctx.addIssue({ code: 'custom', path: ['server'], message: 'out-of-process plugins need a "server"' });
  if (m.kind === 'out-of-process' && m.contributes.commands.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['contributes', 'commands'], message: 'slash commands are only supported for in-process plugins in plugin API 1.0' });
  }
  if (m.contributes.channel && m.kind !== 'out-of-process') {
    ctx.addIssue({ code: 'custom', path: ['contributes', 'channel'], message: 'only out-of-process plugins can provide a channel' });
  }
  if (m.contributes.channel && !semver.intersects(m.engines.pluginApi, '>=1.1.0', { includePrerelease: true })) {
    ctx.addIssue({ code: 'custom', path: ['engines', 'pluginApi'], message: 'channels need plugin API 1.1 or later (e.g. "^1.1.0")' });
  }
  for (const c of m.contributes.commands) {
    if (RESERVED_COMMANDS.has(c.name)) ctx.addIssue({ code: 'custom', path: ['contributes', 'commands'], message: `/${c.name} is a built-in Mercury command and can't be used by a plugin` });
  }
  if (m.settings) {
    let prev = 1;
    for (const step of m.settings.migrations) {
      if (step.to <= prev || step.to > m.settings.version) {
        ctx.addIssue({ code: 'custom', path: ['settings', 'migrations'], message: `migrations must go up in order and end at settings.version (${m.settings.version})` });
        break;
      }
      prev = step.to;
    }
  }
  const names = new Set<string>();
  for (const t of [...m.contributes.tools, ...m.contributes.commands]) {
    if (names.has(t.name)) ctx.addIssue({ code: 'custom', path: ['contributes'], message: `duplicate name "${t.name}"` });
    names.add(t.name);
  }
});

export type PluginManifest = z.infer<typeof manifestSchema>;
export type PluginToolDecl = PluginManifest['contributes']['tools'][number];

// ── state ────────────────────────────────────────────────────────────────

export type DisabledCode =
  | 'user'            // the owner disabled it
  | 'activation'      // activate() threw, timed out, or the server failed to start
  | 'errors'          // circuit breaker: too many failures in a row
  | 'crashed'         // out-of-process: crashed too often
  | 'incompatible'    // Mercury or plugin API version, or platform
  | 'boot-guard'      // the daemon failed to start twice right after this changed
  | 'integrity';      // files changed since install (checksum mismatch)

export interface PluginStateEntry {
  version: string;
  previousVersion?: string;
  enabled: boolean;
  kind: PluginManifest['kind'];
  source: { type: 'catalog' | 'path' | 'url' | 'github'; ref: string };
  /** True when installed from the catalog with a pinned checksum. */
  verified: boolean;
  installedAt: string;
  updatedAt: string;
  disabled?: { code: DisabledCode; message: string; at: string };
}

export interface PluginsState {
  stateVersion: 1;
  plugins: Record<string, PluginStateEntry>;
  boot: {
    /** True from daemon start until the plugins have run healthily for a while. */
    inProgress: boolean;
    failedBoots: number;
    lastChange?: { id: string; at: string };
  };
}

/** One row of `/plugins`: the merged view of the catalog and what is installed. */
export type PluginStatus = 'available' | 'installed' | 'enabled' | 'disabled' | 'update-available' | 'incompatible' | 'error';

export interface PluginListItem {
  id: string;
  name: string;
  description: string;
  kind: PluginManifest['kind'];
  tier: 'official' | 'community' | 'local';
  status: PluginStatus;
  installedVersion?: string;
  latestVersion?: string;
  sizeBytes?: number;
  enabled: boolean;
  running: boolean;
  verified: boolean;
  tools: string[];
  commands: string[];
  /** Plugin API 1.1: the chat channel this plugin provides, and its live state. */
  channel?: { type: string; state?: string; detail?: string; account?: string };
  permissions?: PluginManifest['permissions'];
  disabled?: PluginStateEntry['disabled'];
  lastError?: string;
  incompatibleReason?: string;
  /** Only in `info`: the settings the plugin declares, with current values. */
  settings?: Array<{ key: string; type: 'string' | 'number' | 'boolean' | 'enum'; description: string; options?: string[]; value: unknown }>;
}

// ── catalog ──────────────────────────────────────────────────────────────

const catalogArtifact = z.object({
  url: z.string().url().refine((u) => u.startsWith('https://'), 'artifacts must be served over HTTPS'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
}).strict();

export const catalogEntrySchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE),
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(280),
  version: strictSemver,
  kind: z.enum(['in-process', 'out-of-process']),
  tier: z.enum(['official', 'community']),
  homepage: z.string().url().optional(),
  engines: z.object({ mercury: semverRange, pluginApi: semverRange.default('^1.0.0') }).strict(),
  /** Either one artifact for every platform, or one per platform. */
  artifact: catalogArtifact.optional(),
  artifacts: z.record(z.enum(PLATFORM_KEYS), catalogArtifact).optional(),
  tools: z.array(z.string()).default([]),
  permissions: z.object({
    network: z.array(z.string()).default([]),
    secrets: z.array(z.string()).default([]),
  }).default({ network: [], secrets: [] }),
}).strict().refine((e) => !!e.artifact || !!e.artifacts, 'needs "artifact" or "artifacts"');

export const catalogSchema = z.object({
  catalogVersion: z.literal(1),
  updatedAt: z.string(),
  plugins: z.array(catalogEntrySchema).max(500),
}).strict();

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type Catalog = z.infer<typeof catalogSchema>;
