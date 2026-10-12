import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPrompter } from './ask.js';

/**
 * Regression: the setup wizard exited 0 at the first arrow-key menu (1.3.1
 * – 1.3.6). ask() releases its shared readline on a deferred setImmediate;
 * readline.close() pauses the input. The menu had already resumed stdin,
 * the deferred pause landed after it, nothing was reading the terminal and
 * the process ran out of work.
 */
describe('shared readline release vs the next stdin consumer', () => {
  it('close() after an answered question is synchronous and cancels the deferred release', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = createPrompter({ input, output });
    const answer = p.ask('name? ');
    input.write('Tester\n');
    expect(await answer).toBe('Tester');
    // A consumer takes over right away (the arrow menu): release now…
    p.close();
    let pausedLater = false;
    const orig = input.pause.bind(input);
    (input as unknown as { pause: () => unknown }).pause = () => { pausedLater = true; return orig(); };
    // …and the deferred release must not pause the input afterwards.
    await new Promise((r) => setImmediate(() => setImmediate(r)));
    expect(pausedLater).toBe(false);
  });

  it('the arrow menu releases the shared readline before it owns stdin', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'utils', 'arrow-select.ts'), 'utf8').replace(/\r\n/g, '\n');
    const close = src.indexOf('closeAsk();');
    const keypress = src.indexOf('readline.emitKeypressEvents(process.stdin);');
    expect(close).toBeGreaterThan(0);
    expect(keypress).toBeGreaterThan(close);
  });
});
void EventEmitter;
