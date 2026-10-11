import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { PermissionManager } from '../permissions.js';
import { checkGitReadPath, gitReadInvocation, runGit } from './git-path.js';

export function createGitDiffTool(permissions: PermissionManager, getCwd: () => string) {
  return tool({
    description: 'Show changes between commits, commit and working tree, etc. Shows what has been modified.',
    inputSchema: zodSchema(z.object({
      path: z.string().optional().describe('File or directory to diff'),
      staged: z.boolean().optional().describe('Show staged changes (cached) instead of unstaged'),
    })),
    execute: async ({ path, staged }) => {
      const args = ['diff'];
      if (staged) args.push('--cached');
      if (path) {
        // Model-chosen path: read-scope check first, then a single argv
        // element after `--` so it can never be parsed as an option.
        const check = await checkGitReadPath(permissions, getCwd, path);
        if (check.error) return check.error;
        args.push('--', path);
      }
      try {
        const git = gitReadInvocation(args);
        if ('error' in git) return git.error;
        const result = await runGit(git.file, git.args, { timeoutMs: 30000, cwd: getCwd(), env: git.env });
        if (!result.trim()) return 'No differences found.';
        const truncated = result.length > 15000 ? result.slice(0, 15000) + '\n... (truncated)' : result;
        return truncated;
      } catch (err: any) {
        return `Error: ${err.stderr?.trim() || err.message}`;
      }
    },
  });
}
