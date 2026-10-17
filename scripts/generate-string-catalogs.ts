import { runStringCatalogCli } from '../build/boundary-strings/string-catalog-cli.js';

const { exitCode, stdout, stderr } = runStringCatalogCli({ args: process.argv.slice(2), scriptUrl: import.meta.url });
if (stdout !== '') {
  process.stdout.write(stdout);
}
if (stderr !== '') {
  process.stderr.write(stderr);
}
process.exitCode = exitCode;
