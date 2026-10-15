import { afterEach, describe, expect, it } from 'vitest';
import { isBunVirtualPath } from './bun-path.js';

const versions = process.versions as { bun?: string };
const original = versions.bun;

afterEach(() => {
  if (original === undefined) delete versions.bun;
  else versions.bun = original;
});

describe('isBunVirtualPath (standalone binary asset resolution, #189)', () => {
  it('recognises the POSIX and Windows virtual roots under Bun', () => {
    versions.bun = '1.3.14';
    expect(isBunVirtualPath('/$bunfs/root/web')).toBe(true);
    expect(isBunVirtualPath('B:\\~BUN\\root')).toBe(true);
    expect(isBunVirtualPath('B:/~BUN/root/dist')).toBe(true);
  });

  it('ignores ordinary paths, including folders merely named like the marker', () => {
    versions.bun = '1.3.14';
    expect(isBunVirtualPath('/Users/me/mercury/dist')).toBe(false);
    expect(isBunVirtualPath('C:\\Users\\me\\~BUNDLE\\dist')).toBe(false);
  });

  it('is false outside Bun (npm installs run on Node)', () => {
    delete versions.bun;
    expect(isBunVirtualPath('B:\\~BUN\\root')).toBe(false);
    expect(isBunVirtualPath('/$bunfs/root')).toBe(false);
  });
});
