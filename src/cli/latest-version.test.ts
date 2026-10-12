import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDevVersionFromReleaseName, parseVersionFromReleaseLocation } from './latest-version.js';

describe('latest version resolution (mercury upgrade is a no-op when current)', () => {
  it('reads the stable version from the /releases/latest redirect', () => {
    expect(parseVersionFromReleaseLocation('https://github.com/cosmicstack-labs/mercury-agent/releases/tag/v1.3.5')).toBe('1.3.5');
    expect(parseVersionFromReleaseLocation('https://github.com/x/y/releases/tag/1.4.0/')).toBe('1.4.0');
    expect(parseVersionFromReleaseLocation('https://github.com/x/y/releases')).toBeNull();
    expect(parseVersionFromReleaseLocation(null)).toBeNull();
  });

  it('reads the dev version from the rolling release title', () => {
    expect(parseDevVersionFromReleaseName('Mercury Dev — 1.3.1-dev.20261011.d40a112')).toBe('1.3.1-dev.20261011.d40a112');
    expect(parseDevVersionFromReleaseName('Mercury Dev')).toBeNull();
  });

  it('the launcher checks the channel version before stopping the daemon or running an installer', () => {
    const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
    const cmd = index.slice(index.indexOf(".command('upgrade')"), index.indexOf(".command('upgrade')") + 6000);
    const check = cmd.indexOf('fetchLatestVersion(');
    const stop = cmd.indexOf('await stopDaemon()');
    expect(check).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(check);
    expect(cmd).toContain("Already on the latest");
    expect(cmd).toContain("'--force'");
  });
});
