/**
 * What is the newest build on a channel? Asked by `mercury upgrade` BEFORE
 * it stops the daemon and re-runs an installer: an upgrade that is already
 * installed must be a no-op, not a restart.
 */
const REPO = 'cosmicstack-labs/mercury-agent';

/** `/releases/latest` redirects to `/releases/tag/vX.Y.Z` — the version is in the Location. */
export function parseVersionFromReleaseLocation(location: string | null | undefined): string | null {
  const m = String(location ?? '').match(/\/releases\/tag\/v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\/?$/);
  return m ? m[1] : null;
}

/** The rolling dev release is titled "Mercury Dev — <version>"; the version is the truth. */
export function parseDevVersionFromReleaseName(name: string | null | undefined): string | null {
  const m = String(name ?? '').match(/(\d+\.\d+\.\d+-dev\.\d{8}\.[0-9a-f]+)/);
  return m ? m[1] : null;
}

export async function fetchLatestVersion(channel: 'stable' | 'dev', timeoutMs = 8000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (channel === 'dev') {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/mercury-dev-latest`, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mercury-agent-upgrade' },
      });
      if (!res.ok) return null;
      const body = await res.json() as { name?: string };
      return parseDevVersionFromReleaseName(body.name);
    }
    const res = await fetch(`https://github.com/${REPO}/releases/latest`, { signal: controller.signal, redirect: 'manual' });
    return parseVersionFromReleaseLocation(res.headers.get('location'));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
