import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../utils/config.js';
import { UserMemoryStore } from './user-memory.js';
import { ftsSearchTerms, isBetterSqlite3Available } from './second-brain-db.js';

const tempDirs: string[] = [];
const sqliteAvailable = isBetterSqlite3Available();

function createStore(): UserMemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-sb-search-'));
  tempDirs.push(dir);
  const config = getDefaultConfig();
  config.memory.secondBrain = { enabled: true };
  return new UserMemoryStore(config, 'user:owner', join(dir, 'second-brain', 'second-brain.db'));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch {}
  }
});

/** A long pasted message: thousands of distinct tokens, paths, punctuation, FTS operators. */
function hugePaste(): string {
  const lines: string[] = ['I am running YuE2 in ComfyUI. My favorite test color is teal. Here is the log:'];
  for (let i = 0; i < 1200; i++) {
    lines.push(`[${i}] loading F:\\ComfyUI\\models\\yue2\\shard_${i}.safetensors (AND NOT "x" OR y*) step=${i * 7} tok${i}`);
  }
  return lines.join('\n');
}

describe('ftsSearchTerms', () => {
  it('keeps distinct words of 2+ characters, lowercased, in order', () => {
    expect(ftsSearchTerms('Teal is my favorite TEAL color, a b!')).toEqual(['teal', 'is', 'my', 'favorite', 'color']);
  });

  it('drops punctuation and FTS operators characters so they cannot break the query', () => {
    expect(ftsSearchTerms('"quoted" C:\\path\\file.md (x OR y*) NEAR/2')).toEqual(['quoted', 'path', 'file', 'md', 'or', 'near']);
  });

  it('caps a huge message at 32 terms', () => {
    expect(ftsSearchTerms(hugePaste())).toHaveLength(32);
  });

  it('handles non-Latin text', () => {
    expect(ftsSearchTerms('café naïve 東京')).toEqual(['café', 'naïve', '東京']);
  });
});

describe('memory search with a long pasted message', () => {
  it.skipIf(!sqliteAvailable)('does not throw "Expression tree is too large" and still finds relevant memories', () => {
    const store = createStore();
    store.remember([
      { type: 'preference', summary: 'Favorite test color is teal.', confidence: 0.9, importance: 0.8, durability: 0.9 },
    ]);
    expect(() => store.search(hugePaste())).not.toThrow();
    expect(() => store.searchAll(hugePaste())).not.toThrow();
    expect(store.search(hugePaste()).map((m) => m.summary)).toContain('Favorite test color is teal.');
  });

  it.skipIf(!sqliteAvailable)('still matches ordinary short queries', () => {
    const store = createStore();
    store.remember([
      { type: 'preference', summary: 'Favorite test color is teal.', confidence: 0.9, importance: 0.8, durability: 0.9 },
    ]);
    expect(store.search('what is my favorite color?').map((m) => m.summary)).toContain('Favorite test color is teal.');
  });
});
