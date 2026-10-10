import { fileURLToPath } from 'node:url';

import { executeStringCatalogCommand } from '../build/boundary-strings/catalog-command.js';

// Resolve against this script, not the caller's working directory.
const result = executeStringCatalogCommand({ argv: process.argv.slice(2), root: fileURLToPath(new URL('..', import.meta.url)) });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
