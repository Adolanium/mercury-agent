/**
 * Cheap sanity checks on API keys — the shapes vendors publish. A key that
 * fails one is wrong before any request is made (a pasted "2sk-proj…" cost
 * a fleet a day of 401s). Warnings only: shapes change, and an unknown
 * provider has no rule.
 */
export interface KeyShapeWarning { provider: string; problem: string }

const RULES: Record<string, { re: RegExp; expect: string }> = {
  openai: { re: /^sk-/, expect: 'starts with "sk-"' },
  anthropic: { re: /^sk-ant-/, expect: 'starts with "sk-ant-"' },
  deepseek: { re: /^sk-/, expect: 'starts with "sk-"' },
  grok: { re: /^xai-/, expect: 'starts with "xai-"' },
};

export function checkKeyShapes(providers: Record<string, { apiKey?: string; enabled?: boolean } | undefined>): KeyShapeWarning[] {
  const out: KeyShapeWarning[] = [];
  for (const [name, cfg] of Object.entries(providers)) {
    const rule = RULES[name];
    const key = cfg?.apiKey?.trim();
    if (!rule || !key || cfg?.enabled === false) continue;
    if (/\s/.test(key)) { out.push({ provider: name, problem: 'contains whitespace' }); continue; }
    if (!rule.re.test(key)) out.push({ provider: name, problem: `${rule.expect}; this one starts with "${key.slice(0, 6)}…"` });
  }
  return out;
}
