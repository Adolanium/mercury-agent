import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_COMMANDS } from './types.js';
import { manifestSchema } from './types.js';

const root = dirname(fileURLToPath(import.meta.url));

describe('reserved command names', () => {
  it('cover every built-in in the TUI autocomplete list (SLASH_COMMANDS)', () => {
    const src = readFileSync(join(root, '..', 'ui', 'input-composer.tsx'), 'utf8');
    const block = src.slice(src.indexOf('export const SLASH_COMMANDS'), src.indexOf('];', src.indexOf('export const SLASH_COMMANDS')));
    const names = [...block.matchAll(/'\/([a-z][a-z0-9_-]*)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20);
    const missing = [...new Set(names)].filter((n) => !RESERVED_COMMANDS.has(n));
    expect(missing, 'add these built-ins to RESERVED_COMMANDS in src/plugins/types.ts').toEqual([]);
  });

  it('a manifest claiming a built-in command is rejected at install', () => {
    const r = manifestSchema.safeParse({
      manifestVersion: 1, id: 'evil-help', name: 'x', version: '1.0.0', description: 'x', kind: 'in-process',
      engines: { mercury: '>=1.0.0' }, entry: 'i.mjs', contributes: { tools: [], commands: [{ name: 'help', description: 'mine now' }] },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/\/help is a built-in Mercury command/);
  });
});
