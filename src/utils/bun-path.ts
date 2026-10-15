/**
 * True when `dir` is inside Bun's virtual filesystem, i.e. Mercury runs as
 * a `bun build --compile` standalone binary and files shipped next to the
 * executable (web/, the brain fallback assets) must be resolved from
 * `process.execPath`, not `__dirname`.
 *
 * The virtual root differs by OS: `/$bunfs/root` on macOS and Linux,
 * `B:\~BUN\root` (or `B:/~BUN/root`) on Windows.
 */
export function isBunVirtualPath(dir: string): boolean {
  if (typeof (process.versions as { bun?: string }).bun !== 'string') return false;
  return dir.includes('$bunfs') || /[\\/]~BUN[\\/]/.test(dir);
}
