import { synchronizeStringCatalogs } from './generate-catalogs';

const usage = `\
Usage: npm run strings:catalogs [-- --check | --help]

Regenerate locale catalogs from the message directories and supported locales.
  --check  Compare without writing; exit nonzero if any catalog differs.
  --help   Show this help without reading or writing catalogs.

Only catalog files are written. Message implementations are never modified.
See scripts/README.md for the validation boundary and language-addition workflow.`;

export function executeStringCatalogCommand({ argv, root }: { argv: readonly string[]; root: string }): { exitCode: 0 | 1; stdout: string; stderr: string } {
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      return { exitCode: 0, stdout: `${usage}\n`, stderr: '' };
    }
    if (argv.length !== 0 && !(argv.length === 1 && argv[0] === '--check')) {
      throw new Error(`Unknown or conflicting arguments: ${argv.join(' ')}\n${usage}`);
    }
    const mode = argv.length === 0 ? 'write' : 'check';
    const { changedFiles, messageCount, localeCount } = synchronizeStringCatalogs({ root, mode });
    if (mode === 'check' && changedFiles.length > 0) {
      const stderr = [
        'String catalogs differ:',
        ...changedFiles.map(file => `  ${file}`),
        'Run `npm run strings:catalogs` to regenerate them.',
      ].join('\n');
      return { exitCode: 1, stdout: '', stderr: `${stderr}\n` };
    }
    return { exitCode: 0, stdout: `String catalogs: ${messageCount} messages, ${localeCount} locales, ${changedFiles.length} files updated.\n`, stderr: '' };
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
}
