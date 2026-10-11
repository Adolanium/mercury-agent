import { tool, zodSchema } from 'ai';
import { runGit } from './git-path.js';
import { z } from 'zod';
import type { PermissionManager } from '../permissions.js';

export function createGitAddTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Add file contents to the index (staging area). Prepares files for commit.',
    inputSchema: zodSchema(z.object({
      paths: z.array(z.string()).describe('File paths to stage'),
    })),
    execute: async ({ paths }) => {
      try {
        const permission = await permissions.checkShellCommand(`git add -- ${paths.join(' ')}`);
        if (!permission.allowed) return `Permission denied: ${permission.reason || 'git add requires approval'}`;
        const result = await runGit('git', ['add', '--', ...paths], { timeoutMs: 20000, cwd: getCwd() });
        return `Staged ${paths.length} file(s): ${paths.join(', ')}`;
      } catch (err: any) {
        return `Error: ${err.stderr?.trim() || err.message}`;
      }
    },
  });
}
