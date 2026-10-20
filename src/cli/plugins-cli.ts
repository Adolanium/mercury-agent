/**
 * `mercury plugins …` from a shell. Same commands and wording as `/plugins`
 * in chat (it runs the same handler), forwarded to the background Mercury
 * when one is running, so that process starts and stops the plugins itself.
 * `validate` is the author-side conformance kit and runs here.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import type { ChannelMessage } from '../types/channel.js';

async function run(line: string): Promise<void> {
  const { handlePluginsCommand } = await import('../plugins/commands.js');
  const msg: ChannelMessage = {
    id: `cli-plugins-${Date.now()}`,
    channelId: 'cli',
    channelType: 'cli',
    senderId: 'owner',
    content: line,
    timestamp: Date.now(),
  };
  let failed = false;
  await handlePluginsCommand(line, msg, {
    type: 'cli',
    send: async (text) => {
      if (text.startsWith('✗')) failed = true;
      // Chat wording says "/plugins x"; in a shell it's "mercury plugins x".
      console.log(text.replace(/(^|[\s:(])\/plugins\b/g, '$1mercury plugins'));
    },
  });
  if (failed) process.exitCode = 1;
}

function quote(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

export function registerPluginsCli(program: Command): void {
  const plugins = program
    .command('plugins')
    .alias('plugin')
    .description('Install, enable, disable, update and remove plugins');

  plugins.command('list', { isDefault: true }).alias('ls').description('Installed and available plugins').action(() => run('/plugins list'));
  plugins.command('search <text...>').description('Find plugins in the catalog').action((text: string[]) => run(`/plugins search ${quote(text)}`));
  plugins.command('info <id>').description('Details, tools and permissions').action((id: string) => run(`/plugins info ${id}`));
  plugins
    .command('install <source>')
    .alias('add')
    .description('Install from the catalog (id), a folder, a .tgz, an https URL or github:owner/repo')
    .option('-y, --yes', 'Skip the confirmation')
    .action((source: string, opts: { yes?: boolean }) => run(`/plugins install ${source}${opts.yes ? ' --yes' : ''}`));
  plugins.command('enable <id>').description('Turn a plugin on').action((id: string) => run(`/plugins enable ${id}`));
  plugins.command('disable <id>').description('Turn a plugin off (keeps its data and settings)').action((id: string) => run(`/plugins disable ${id}`));
  plugins.command('update [id]').description('Update one plugin, or all from the catalog').action((id?: string) => run(`/plugins update ${id ?? 'all'}`));
  plugins.command('rollback <id>').description('Go back to the previous installed version').action((id: string) => run(`/plugins rollback ${id}`));
  plugins
    .command('uninstall <id>')
    .alias('remove')
    .description('Remove a plugin (keeps its data unless --purge)')
    .option('--purge', 'Also delete its data and settings')
    .option('-y, --yes', 'Skip the confirmation')
    .action((id: string, opts: { purge?: boolean; yes?: boolean }) => run(`/plugins uninstall ${id}${opts.purge ? ' --purge' : ''}${opts.yes ? ' --yes' : ''}`));
  plugins.command('set <id> <key> <value...>').description('Change a plugin setting').action((id: string, key: string, value: string[]) => run(`/plugins set ${id} ${key} ${value.join(' ')}`));

  plugins
    .command('init <id>')
    .description('Start a new plugin in ./<id> (for plugin authors)')
    .option('--out-of-process', 'An MCP server in its own process instead of a module inside Mercury')
    .action(async (id: string, opts: { outOfProcess?: boolean }) => {
      const { scaffoldPlugin } = await import('../plugins/scaffold.js');
      try {
        const dir = scaffoldPlugin(process.cwd(), id, opts.outOfProcess ? 'out-of-process' : 'in-process');
        console.log('');
        console.log(chalk.green(`  ✓ Created ${dir}`));
        console.log(chalk.dim(`    cd ${id} && mercury plugins validate . && mercury plugins install . --yes`));
        console.log('');
      } catch (err) {
        console.error(chalk.red(`  ✗ ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  plugins
    .command('pack [folder]')
    .description('Package a plugin as .tgz and print its checksum and catalog entry (for plugin authors)')
    .option('-o, --out <dir>', 'Where to write the .tgz', '.')
    .action(async (folder: string | undefined, opts: { out: string }) => {
      const { packPlugin } = await import('../plugins/scaffold.js');
      try {
        const r = await packPlugin(resolve(folder ?? '.'), resolve(opts.out));
        console.log('');
        console.log(chalk.green(`  ✓ ${r.file}`));
        console.log(chalk.dim(`    ${(r.size / 1024).toFixed(1)} KB · sha256 ${r.sha256}`));
        console.log('');
        console.log('  Catalog entry (fix the artifact URL once the release exists):');
        console.log(JSON.stringify(r.entry, null, 2).replace(/^/gm, '  '));
        console.log('');
      } catch (err) {
        console.error(chalk.red(`  ✗ ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  plugins
    .command('validate [folder]')
    .description('Check a plugin package the way Mercury will run it (for plugin authors)')
    .option('--json', 'Print the report as JSON')
    .action(async (folder: string | undefined, opts: { json?: boolean }) => {
      const { runConformance } = await import('../plugins/conformance.js');
      const report = await runConformance(resolve(folder ?? '.'));
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('');
        console.log(chalk.bold(`  ${report.id ? `${report.id}@${report.version}` : 'plugin'} conformance`));
        for (const c of report.checks) {
          console.log(`  ${c.ok ? chalk.green('✓') : chalk.red('✗')} ${c.name}${c.detail ? chalk.dim(` · ${c.detail}`) : ''}`);
        }
        console.log('');
        console.log(report.ok ? chalk.green('  Ready to install and publish.') : chalk.red('  Fix the ✗ items above before publishing.'));
        console.log('');
      }
      if (!report.ok) process.exitCode = 1;
      // An out-of-process server or a plugin timer must not hold the CLI open.
      setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
    });
}

/** `mercury doctor --plugins`: what's installed, what's off and why, and what to do. */
export async function runPluginDoctor(): Promise<void> {
  const { getPluginService } = await import('../plugins/service.js');
  const { isSafeModeRequested } = await import('../plugins/manager.js');
  const { readState } = await import('../plugins/store.js');
  const svc = getPluginService();
  console.log('');
  console.log(chalk.bold('  Plugins'));
  console.log(chalk.dim(`  ${svc.mode === 'daemon' ? 'Asking the running Mercury' : svc.mode === 'offline' ? 'Mercury is not running: showing what is on disk' : 'This process runs plugins'}`));
  let problems = 0;
  try {
    const { items, safeMode, catalogError } = await svc.list();
    if (safeMode || isSafeModeRequested()) console.log(chalk.yellow('  ⚠ Safe mode is on: no plugin runs until Mercury restarts without --safe-mode / MERCURY_PLUGINS=off.'));
    const boot = readState().boot;
    if (boot.failedBoots > 0) console.log(chalk.yellow(`  ⚠ Mercury failed to start ${boot.failedBoots} time(s) right after a plugin change${boot.lastChange ? ` (${boot.lastChange.id})` : ''}.`));
    const installed = items.filter((i) => i.installedVersion);
    if (!installed.length) console.log(chalk.dim('  No plugins installed.'));
    for (const i of installed) {
      const bad = i.status === 'error' || i.status === 'incompatible' || (i.disabled && i.disabled.code !== 'user');
      if (bad) problems++;
      const mark = i.status === 'enabled' ? chalk.green('✓') : bad ? chalk.red('✗') : chalk.dim('○');
      const why = i.status === 'incompatible' ? i.incompatibleReason : i.status === 'error' ? i.lastError ?? 'enabled but not running' : i.disabled && i.disabled.code !== 'user' ? `turned off automatically (${i.disabled.code}): ${i.disabled.message}` : i.status;
      console.log(`  ${mark} ${i.id}@${i.installedVersion} ${chalk.dim(`· ${why}`)}`);
      if (bad && i.disabled && ['errors', 'crashed', 'activation', 'boot-guard'].includes(i.disabled.code)) {
        console.log(chalk.dim(`      fix: mercury plugins update ${i.id}, or mercury plugins rollback ${i.id}, then mercury plugins enable ${i.id}`));
      } else if (bad && i.disabled?.code === 'integrity') {
        console.log(chalk.dim(`      fix: its files changed since install. Reinstall it: mercury plugins install ${i.id} --yes`));
      }
    }
    if (catalogError) console.log(chalk.dim(`  Catalog: ${catalogError}`));
  } catch (err) {
    problems++;
    console.log(chalk.red(`  ✗ ${(err as Error).message}`));
  }
  console.log('');
  if (problems) process.exitCode = 1;
}
