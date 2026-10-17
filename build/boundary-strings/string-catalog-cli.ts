import { fileURLToPath } from 'node:url';

import { synchronizeStringCatalogs } from './generate-catalogs.js';

const usage = `\
Usage: npm run strings:catalogs [-- --check | --help]

Regenerate locale catalogs from the message directories and supported locales.
  --check  Compare without writing; exit nonzero if any catalog differs.
  --help   Show this help without reading or writing catalogs.

Only catalog files are written. Message implementations are never modified.
See scripts/README.md for the validation boundary and language-addition workflow.`;

export function runStringCatalogCli({ args, scriptUrl }: { args: readonly string[]; scriptUrl: string }): {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
} {
  if (args.length === 1 && args[0] === '--help') {
    return { exitCode: 0, stdout: `${usage}\n`, stderr: '' };
  }
  if (args.length !== 0 && !(args.length === 1 && args[0] === '--check')) {
    return { exitCode: 1, stdout: '', stderr: `Unknown or conflicting arguments: ${args.join(' ')}\n${usage}\n` };
  }

  try {
    const mode = args.length === 0 ? 'write' : 'check';
    // Resolve against the entry script, not the caller's working directory.
    const root = fileURLToPath(new URL('..', scriptUrl));
    const { changedFiles, messageCount, localeCount } = synchronizeStringCatalogs({ root, mode });
    if (mode === 'check' && changedFiles.length > 0) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: [
          'String catalogs differ:',
          ...changedFiles.map(file => `  ${file}`),
          'Run `npm run strings:catalogs` to regenerate them.',
          '',
        ].join('\n'),
      };
    }
    return {
      exitCode: 0,
      stdout: `String catalogs: ${messageCount} messages, ${localeCount} locales, ${changedFiles.length} files updated.\n`,
      stderr: '',
    };
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
}
