import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginManager, resetPluginManager } from './manager.js';
import { installedManifest } from './installer.js';
import { pluginDir, pluginSettingsPath, readState, resolvedSettings } from './store.js';
import { listLiveTools, resetToolBridge } from './tool-bridge.js';
import { runConformance, unresolvableImports } from './conformance.js';
import { manifestSchema } from './types.js';
import pluginRoutes from '../web/api/plugins.js';
import { inProcessPlugin, outOfProcessPlugin, tempHome } from './test-fixtures.js';

let env: ReturnType<typeof tempHome>;
let src: string;
let mgr: PluginManager;

beforeEach(() => {
  env = tempHome();
  src = join(env.home, 'src');
  mkdirSync(src, { recursive: true });
  resetToolBridge();
  mgr = new PluginManager({ safeMode: false, notify: () => {} });
});

afterEach(async () => {
  await mgr.shutdown();
  resetToolBridge();
  resetPluginManager();
  env.restore();
});

const v1Settings = {
  settings: {
    version: 1,
    fields: { units: { type: 'enum', options: ['celsius', 'fahrenheit'], default: 'celsius' }, city: { type: 'string', default: '' } },
  },
};
const v2Settings = {
  settings: {
    version: 2,
    fields: { unit: { type: 'enum', options: ['c', 'f'], default: 'c' }, city: { type: 'string', default: '' } },
    migrations: [{ to: 2, rename: { units: 'unit' }, mapValues: { unit: { celsius: 'c', fahrenheit: 'f' } } }],
  },
};

describe('settings migrations', () => {
  it('upgrades saved settings on update and restores the old ones on rollback', async () => {
    await mgr.install(inProcessPlugin(src, { id: 'weather', version: '1.0.0', manifest: v1Settings }));
    await mgr.setSetting('weather', 'units', 'fahrenheit');
    await mgr.setSetting('weather', 'city', 'Lahore');

    await mgr.install(inProcessPlugin(src, { id: 'weather', version: '2.0.0', manifest: v2Settings }));
    expect(readState().plugins.weather.version).toBe('2.0.0');
    const saved = JSON.parse(readFileSync(pluginSettingsPath('weather'), 'utf8'));
    expect(saved).toEqual({ settingsVersion: 2, values: { unit: 'f', city: 'Lahore' } });
    expect(resolvedSettings(installedManifest('weather', '2.0.0')!)).toEqual({ unit: 'f', city: 'Lahore' });
    expect(existsSync(join(pluginDir('weather'), 'settings.v1.json'))).toBe(true);

    await mgr.rollback('weather');
    expect(readState().plugins.weather.version).toBe('1.0.0');
    expect(resolvedSettings(installedManifest('weather', '1.0.0')!)).toEqual({ units: 'fahrenheit', city: 'Lahore' });
  });

  it('a corrupt settings file never stops the plugin: it starts on defaults', async () => {
    await mgr.install(inProcessPlugin(src, { id: 'weather', manifest: v1Settings }));
    writeFileSync(pluginSettingsPath('weather'), '{not json');
    await mgr.disable('weather');
    await mgr.enable('weather');
    expect(listLiveTools().some((t) => t.pluginId === 'weather')).toBe(true);
    expect(resolvedSettings(installedManifest('weather', '1.0.0')!)).toEqual({ units: 'celsius', city: '' });
  });

  it('rejects migrations that skip past the settings version or go backwards', () => {
    const base = JSON.parse(readFileSync(join(inProcessPlugin(src, { id: 'bad-mig' }), 'mercury-plugin.json'), 'utf8'));
    const bad = { ...base, settings: { version: 2, fields: {}, migrations: [{ to: 3 }] } };
    expect(manifestSchema.safeParse(bad).success).toBe(false);
    const backwards = { ...base, settings: { version: 3, fields: {}, migrations: [{ to: 3 }, { to: 2 }] } };
    expect(manifestSchema.safeParse(backwards).success).toBe(false);
  });
});

describe('conformance kit', () => {
  it('passes a well-formed in-process plugin, including stop and restart', async () => {
    const report = await runConformance(inProcessPlugin(src, { id: 'good-one', tools: [{ name: 'echo', description: 'Echo the input back to the caller.' }] }));
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['manifest', 'self-contained bundle', 'start', 'tools', 'start: stop', 'restart (hot plug)', 'restart (hot plug): stop']));
    expect(listLiveTools()).toEqual([]);
  });

  it('passes an out-of-process MCP plugin', async () => {
    const report = await runConformance(outOfProcessPlugin(src, { id: 'mcp-ok' }));
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('flags a plugin that imports packages instead of bundling them', async () => {
    const dir = inProcessPlugin(src, {
      id: 'unbundled',
      code: `import { z } from 'zod';\nexport async function activate(ctx) {}`,
    });
    const report = await runConformance(dir);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'self-contained bundle')?.ok).toBe(false);
  });

  it('flags a declared tool the plugin never registers', async () => {
    const dir = inProcessPlugin(src, { id: 'liar', code: 'export async function activate() {}' });
    const report = await runConformance(dir);
    expect(report.checks.find((c) => c.name === 'tools')).toMatchObject({ ok: false });
  });

  it('import scanner allows builtins and relative files only', () => {
    expect(unresolvableImports(`import fs from 'node:fs'; import path from "path"; import x from './x.js'; const y = await import('../y.mjs');`)).toEqual([]);
    expect(unresolvableImports(`import a from 'lodash'; export { b } from '@scope/pkg'; require('left-pad')`)).toEqual(['lodash', '@scope/pkg', 'left-pad']);
  });
});

describe('web API', () => {
  const loopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const lan = { incoming: { socket: { remoteAddress: '192.168.1.20' } } };
  const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('only accepts changes from this machine', async () => {
    const dir = inProcessPlugin(src, { id: 'web-test' });
    const denied = await pluginRoutes.request('/api/plugins/install', post({ source: dir }), lan);
    expect(denied.status).toBe(403);
    expect(readState().plugins['web-test']).toBeUndefined();

    const ok = await pluginRoutes.request('/api/plugins/install', post({ source: dir }), loopback);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string }).id).toBe('web-test');

    const list = await pluginRoutes.request('/api/plugins', {}, lan);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: Array<{ id: string }> }).items.map((i: { id: string }) => i.id)).toContain('web-test');

    expect((await pluginRoutes.request('/api/plugins/web-test/disable', post({}), lan)).status).toBe(403);
    expect((await pluginRoutes.request('/api/plugins/web-test', { method: 'DELETE' }, lan)).status).toBe(403);
    expect((await pluginRoutes.request('/api/plugins/web-test', { method: 'DELETE' }, loopback)).status).toBe(200);
    expect(readState().plugins['web-test']).toBeUndefined();
  });

  it('returns 404 for an unknown plugin and 400 for a bad source', async () => {
    expect((await pluginRoutes.request('/api/plugins/nope-nope/enable', post({}), loopback)).status).toBe(404);
    expect((await pluginRoutes.request('/api/plugins/install', post({ source: '' }), loopback)).status).toBe(400);
    expect((await pluginRoutes.request('/api/plugins/install', post({ source: 'http://insecure.example/p.tgz' }), loopback)).status).toBe(400);
  });
});

describe('optional secrets', () => {
  it('tells the owner once per version when an optional secret is missing', async () => {
    const { SECRET_NOTICE_DELAY } = await import('./manager.js');
    const saved = SECRET_NOTICE_DELAY.ms;
    SECRET_NOTICE_DELAY.ms = 20;
    const prev = process.env.FIXTURE_VOICE_KEY;
    delete process.env.FIXTURE_VOICE_KEY;
    const notices: string[] = [];
    const m = new PluginManager({ safeMode: false, notify: (n) => { notices.push(n); } });
    try {
      const manifest = { permissions: { network: [], secrets: ['FIXTURE_VOICE_KEY'], optionalSecrets: { FIXTURE_VOICE_KEY: 'Voice calls' } } };
      await m.install(inProcessPlugin(src, { id: 'voicey', manifest }));
      await new Promise((r) => setTimeout(r, 80));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/Voice calls: needs FIXTURE_VOICE_KEY/);
      expect((await m.info('voicey'))?.missingOptionalSecrets).toEqual([{ name: 'FIXTURE_VOICE_KEY', unlocks: 'Voice calls' }]);
      // Restarting the same version doesn't repeat it.
      await m.disable('voicey');
      await m.enable('voicey');
      await new Promise((r) => setTimeout(r, 80));
      expect(notices).toHaveLength(1);
      // With the key set, nothing is missing.
      process.env.FIXTURE_VOICE_KEY = 'k';
      expect((await m.info('voicey'))?.missingOptionalSecrets).toEqual([]);
    } finally {
      await m.shutdown();
      SECRET_NOTICE_DELAY.ms = saved;
      if (prev === undefined) delete process.env.FIXTURE_VOICE_KEY; else process.env.FIXTURE_VOICE_KEY = prev;
    }
  });

  it('an optional secret must also be declared in permissions.secrets', () => {
    const base = JSON.parse(readFileSync(join(inProcessPlugin(src, { id: 'bad-secret' }), 'mercury-plugin.json'), 'utf8'));
    const bad = { ...base, permissions: { network: [], secrets: [], optionalSecrets: { OPENAI_API_KEY: 'Voice calls' } } };
    expect(manifestSchema.safeParse(bad).success).toBe(false);
  });
});
