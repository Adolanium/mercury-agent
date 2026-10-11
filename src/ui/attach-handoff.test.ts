import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAttachHandoff } from './attach-handoff.js';

/**
 * Regression: after ADR-024 `mercury` attaches by default, and `/code` typed
 * in the attach TUI was forwarded to the daemon's web channel — which has no
 * terminal to switch into — so it printed "Programming mode: Off" and
 * Mercury Code was unreachable from the default launch.
 */
describe('attach TUI hand-off for /code', () => {
  it('/code and /code <dir> hand the terminal to Mercury Code', () => {
    expect(parseAttachHandoff('/code')).toEqual({ kind: 'code' });
    expect(parseAttachHandoff('  /code  ')).toEqual({ kind: 'code' });
    expect(parseAttachHandoff('/code ~/projects/x')).toEqual({ kind: 'code', dir: '~/projects/x' });
    expect(parseAttachHandoff('/code .')).toEqual({ kind: 'code', dir: '.' });
  });

  it('mode words are explained locally, never forwarded as a no-op', () => {
    expect(parseAttachHandoff('/code plan')?.kind).toBe('notice');
    expect(parseAttachHandoff('/code off')?.kind).toBe('notice');
  });

  it('everything else is forwarded as before', () => {
    expect(parseAttachHandoff('/codex')).toBeNull();
    expect(parseAttachHandoff('/bots')).toBeNull();
    expect(parseAttachHandoff('hello')).toBeNull();
  });

  it('the launcher boots Mercury Code when the attach TUI hands off', () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(index).toContain("if (result === 'code') {");
    expect(index.match(/await attachOrCode\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(index).not.toMatch(/const result = await runAttach\(\);\n\s*if \(result === 'attached'\) return;/);
  });
});
