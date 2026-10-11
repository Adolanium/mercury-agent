/**
 * Commands the attach TUI must NOT forward to the daemon because they need
 * the in-process terminal (ADR-024 left `mercury` attaching by default).
 * `/code [dir]` hands the terminal over to Mercury Code — the same boot
 * `mercury code [dir]` performs — instead of toggling a mode flag on the
 * daemon's web channel and printing "Programming mode: Off".
 */
export type AttachHandoff =
  | { kind: 'code'; dir?: string }
  | { kind: 'notice'; text: string };

const CODE_MODE_WORDS = new Set(['plan', 'auto', 'off', 'diff', 'status', 'on']);

export function parseAttachHandoff(text: string): AttachHandoff | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\/code(?:\s+(.+))?$/);
  if (!m) return null;
  const arg = (m[1] ?? '').trim();
  if (!arg) return { kind: 'code' };
  if (CODE_MODE_WORDS.has(arg.toLowerCase())) {
    return { kind: 'notice', text: `Mercury Code runs in the terminal — send /code to open it, then /code ${arg} inside it.` };
  }
  return { kind: 'code', dir: arg };
}
