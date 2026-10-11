import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ChannelRegistry } from '../channels/registry.js';
import { getDefaultConfig, type MercuryConfig } from '../utils/config.js';

// CRLF-normalised: Windows checkouts convert line endings and the contracts below match across lines.
const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

/**
 * ONE runtime owns the fleet (ADR-024). Launching `mercury` with no daemon
 * used to spawn the daemon AND boot a second full runtime in the terminal:
 * every bot turn then ran on the thread that paints keystrokes, and two
 * Telegram pollers made Telegram answer 409 to both. The terminal attaches
 * to the daemon; a foreground runtime beside a live daemon is a terminal
 * for the main agent only.
 */
describe('single runtime', () => {
  it('launch and recovery spawn the daemon and attach — never spawn and boot a second runtime', () => {
    // The one remaining spawn-then-boot is `mercury code`, which needs the
    // in-process TUI — and runAgent() beside the daemon is a terminal only.
    const spawnThenBoot = index.match(/autoDaemonize\(\);\n\s*await runAgent\(\);/g) ?? [];
    expect(spawnThenBoot).toHaveLength(1);
    expect(index.slice(0, index.indexOf(spawnThenBoot[0] ?? "")).trimEnd()).toMatch(/Mercury Code needs the in-process TUI[^\n]*\n[^\n]*\(ADR-024\)\.$/);
    expect(index).toContain('async function bootDaemonThenAttach()');
    expect(index.split('await bootDaemonThenAttach();').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('a foreground runtime beside a live daemon runs no bots, no channels, no web', () => {
    expect(index).toContain('const daemonOwnsRuntime = !isDaemon && getDaemonStatus().running;');
    expect(index).toContain('new ChannelRegistry(config, { cliOnly: daemonOwnsRuntime })');
    expect(index).toContain('if (config.bots?.enabled && !daemonOwnsRuntime) {');
    expect(index).toContain('Web, channels and bots are served by the background daemon');
    expect(index).toContain('agent.terminalOnly = daemonOwnsRuntime;');
  });

  it('ChannelRegistry cliOnly wires the terminal and nothing else', () => {
    const config = getDefaultConfig() as MercuryConfig;
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = '123:abc';
    const full = new ChannelRegistry(config);
    const cliOnly = new ChannelRegistry(config, { cliOnly: true });
    expect(full.get('telegram')).toBeDefined();
    expect(cliOnly.get('telegram')).toBeUndefined();
    expect(cliOnly.get('cli')).toBeDefined();
  });
});
