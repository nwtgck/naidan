import { fileURLToPath } from 'node:url';

import { synchronizeStringCatalogs } from '../build/boundary-strings/generate-catalogs.js';

const usage = `\
Usage: npm run strings:catalogs [-- --check | --help]

Regenerate locale catalogs from the message directories and supported locales.
  --check  Compare without writing; exit nonzero if any catalog differs.
  --help   Show this help without reading or writing catalogs.

Only catalog files are written. Message implementations are never modified.
See scripts/README.md for the validation boundary and language-addition workflow.`;

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
  } else {
    if (args.length !== 0 && !(args.length === 1 && args[0] === '--check')) {
      throw new Error(`Unknown or conflicting arguments: ${args.join(' ')}\n${usage}`);
    }
    const mode = args.length === 0 ? 'write' : 'check';
    // Resolve against this script, not the caller's working directory.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const { changedFiles, messageCount, localeCount } = synchronizeStringCatalogs({ root, mode });
    if (mode === 'check' && changedFiles.length > 0) {
      console.error([
        'String catalogs differ:',
        ...changedFiles.map(file => `  ${file}`),
        'Run `npm run strings:catalogs` to regenerate them.',
      ].join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`String catalogs: ${messageCount} messages, ${localeCount} locales, ${changedFiles.length} files updated.`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
