import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSha256sumTestHarness,
  type Sha256sumTestHarness,
} from './test-utils';

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('wesh sha256sum check mode', () => {
  let harness: Sha256sumTestHarness;

  beforeEach(async () => {
    harness = await createSha256sumTestHarness();
  });

  it('verifies GNU text, GNU binary, and BSD records', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    await harness.writeFile({ path: 'empty', data: '' });
    await harness.writeFile({
      path: 'checksums.txt',
      data: `\
${ABC_HASH}  abc
${EMPTY_HASH} *empty
SHA256 (abc) = ${ABC_HASH}
`,
    });

    const result = await harness.execute({
      script: 'sha256sum -c checksums.txt',
    });

    expect(result.stdout.text).toBe(`\
abc: OK
empty: OK
abc: OK
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('preserves BOM bytes at the start of every checksum line', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    await harness.writeFile({
      path: 'leading-bom.sum',
      data: `\uFEFF${ABC_HASH}  abc
`,
    });
    await harness.writeFile({
      path: 'second-line-bom.sum',
      data: `${ABC_HASH}  abc
\uFEFF${ABC_HASH}  abc
`,
    });

    const leadingBom = await harness.execute({
      script: 'sha256sum -c leading-bom.sum',
    });
    const secondLineBom = await harness.execute({
      script: 'sha256sum -c second-line-bom.sum',
    });

    expect(leadingBom.stdout.text).toBe('');
    expect(leadingBom.stderr.text).toBe(
      'sha256sum: leading-bom.sum: no properly formatted checksum lines found\n',
    );
    expect(leadingBom.result.exitCode).toBe(1);
    expect(secondLineBom.stdout.text).toBe('abc: OK\n');
    expect(secondLineBom.stderr.text).toBe(
      'sha256sum: WARNING: 1 line is improperly formatted\n',
    );
    expect(secondLineBom.result.exitCode).toBe(0);
  });

  it('accepts legacy single-space records whose one-character names resemble mode markers', async () => {
    await harness.writeFile({ path: ' ', data: 'abc' });
    await harness.writeFile({ path: '*', data: 'abc' });
    await harness.writeFile({
      path: 'legacy.sum',
      data: `\
${ABC_HASH} ${' '}
${ABC_HASH} *
`,
    });

    const result = await harness.execute({
      script: 'sha256sum -c legacy.sum',
    });

    expect(result.stdout.text).toBe(`\
 : OK
*: OK
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('accepts tab checksum separators without losing the following mode or file-name byte', async () => {
    await harness.writeFile({ path: 'data', data: 'abc' });
    await harness.writeFile({ path: '\tdata', data: 'abc' });
    await harness.writeFile({ path: '*data', data: 'abc' });
    await harness.writeFile({
      path: 'tabs.sum',
      data: `\
${ABC_HASH}\tdata
${ABC_HASH}\t data
${ABC_HASH}\t*data
${ABC_HASH}\t\tdata
${ABC_HASH}\t *data
`,
    });

    const result = await harness.execute({
      script: 'sha256sum -c tabs.sum',
    });

    expect(result.stdout.text).toBe(`\
data: OK
data: OK
data: OK
\tdata: OK
*data: OK
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('accepts spaces and tabs before checksum records', async () => {
    await harness.writeFile({ path: 'data', data: 'abc' });
    await harness.writeFile({
      path: 'leading-whitespace.sum',
      data: `\
  ${ABC_HASH}  data
\t${ABC_HASH} *data
`,
    });

    const result = await harness.execute({
      script: 'sha256sum -c leading-whitespace.sum',
    });

    expect(result.stdout.text).toBe(`\
data: OK
data: OK
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('accepts uppercase hashes, comments, empty lines, CRLF, and no final newline', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    await harness.writeFile({
      path: 'checksums.txt',
      data: `# generated\r\n\r\n${ABC_HASH.toUpperCase()}  abc`,
    });

    const result = await harness.execute({
      script: 'sha256sum --check checksums.txt',
    });

    expect(result.stdout.text).toBe('abc: OK\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('reports mismatches and returns a failing exit code', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    await harness.writeFile({
      path: 'checksums.txt',
      data: `${EMPTY_HASH}  abc\n`,
    });

    const result = await harness.execute({
      script: 'sha256sum -c checksums.txt',
    });

    expect(result.stdout.text).toBe('abc: FAILED\n');
    expect(result.stderr.text).toBe(
      'sha256sum: WARNING: 1 computed checksum did NOT match\n',
    );
    expect(result.result.exitCode).toBe(1);
  });

  it('continues after missing files and reports an unreadable summary', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    await harness.writeFile({
      path: 'checksums.txt',
      data: `\
${ABC_HASH}  missing
${ABC_HASH}  abc
`,
    });

    const result = await harness.execute({
      script: 'sha256sum -c checksums.txt',
    });

    expect(result.stdout.text).toBe(`\
missing: FAILED open or read
abc: OK
`);
    expect(result.stderr.text).toContain('sha256sum: missing:');
    expect(result.stderr.text).toContain(
      'sha256sum: WARNING: 1 listed file could not be read',
    );
    expect(result.result.exitCode).toBe(1);
  });

  it('supports quiet and status output suppression', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    await harness.writeFile({
      path: 'success.sum',
      data: `${ABC_HASH}  abc\n`,
    });
    await harness.writeFile({
      path: 'failure.sum',
      data: `${EMPTY_HASH}  abc\n`,
    });

    const quiet = await harness.execute({
      script: 'sha256sum -c --quiet success.sum',
    });
    const status = await harness.execute({
      script: 'sha256sum -c --status failure.sum',
    });

    expect(quiet.stdout.text).toBe('');
    expect(quiet.stderr.text).toBe('');
    expect(quiet.result.exitCode).toBe(0);
    expect(status.stdout.text).toBe('');
    expect(status.stderr.text).toBe('');
    expect(status.result.exitCode).toBe(1);
  });

  it('uses the last quiet, status, or warn option as the check output mode', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    await harness.writeFile({
      path: 'mixed.sum',
      data: `\
malformed
${ABC_HASH}  abc
`,
    });

    const warnAfterStatus = await harness.execute({
      script: 'sha256sum -c --status --warn mixed.sum',
    });
    const statusAfterWarn = await harness.execute({
      script: 'sha256sum -c --warn --status mixed.sum',
    });
    const quietAfterStatus = await harness.execute({
      script: 'sha256sum -c --status --quiet mixed.sum',
    });

    expect(warnAfterStatus.stdout.text).toBe('abc: OK\n');
    expect(warnAfterStatus.stderr.text).toBe(`\
sha256sum: mixed.sum: 1: improperly formatted SHA256 checksum line
sha256sum: WARNING: 1 line is improperly formatted
`);
    expect(warnAfterStatus.result.exitCode).toBe(0);
    expect(statusAfterWarn.stdout.text).toBe('');
    expect(statusAfterWarn.stderr.text).toBe('');
    expect(statusAfterWarn.result.exitCode).toBe(0);
    expect(quietAfterStatus.stdout.text).toBe('');
    expect(quietAfterStatus.stderr.text).toBe(
      'sha256sum: WARNING: 1 line is improperly formatted\n',
    );
    expect(quietAfterStatus.result.exitCode).toBe(0);
  });

  it('warns about malformed lines and makes them fatal only in strict mode', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    await harness.writeFile({
      path: 'mixed.sum',
      data: `\
malformed
${ABC_HASH}  abc
`,
    });

    const normal = await harness.execute({
      script: 'sha256sum -cw mixed.sum',
    });
    const strict = await harness.execute({
      script: 'sha256sum -c --strict mixed.sum',
    });

    expect(normal.stdout.text).toBe('abc: OK\n');
    expect(normal.stderr.text).toContain(
      'sha256sum: mixed.sum: 1: improperly formatted SHA256 checksum line',
    );
    expect(normal.stderr.text).toContain(
      'sha256sum: WARNING: 1 line is improperly formatted',
    );
    expect(normal.result.exitCode).toBe(0);
    expect(strict.stdout.text).toBe('abc: OK\n');
    expect(strict.stderr.text).toBe(
      'sha256sum: WARNING: 1 line is improperly formatted\n',
    );
    expect(strict.result.exitCode).toBe(1);
  });

  it('keeps line warnings visible when status output is suppressed', async () => {
    await harness.writeFile({ path: 'invalid.sum', data: 'not a checksum\n' });

    const result = await harness.execute({
      script: 'sha256sum -c --status --warn invalid.sum',
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe(`\
sha256sum: invalid.sum: 1: improperly formatted SHA256 checksum line
sha256sum: invalid.sum: no properly formatted checksum lines found
`);
    expect(result.result.exitCode).toBe(1);
  });

  it('continues parsing after an invalid UTF-8 checksum line', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    const validLine = new TextEncoder().encode(`${ABC_HASH}  abc\n`);
    const data = new Uint8Array(2 + validLine.byteLength);
    data.set([0xff, 0x0a]);
    data.set(validLine, 2);
    await harness.writeFile({ path: 'mixed-binary.sum', data });

    const result = await harness.execute({
      script: 'sha256sum -cw mixed-binary.sum',
    });

    expect(result.stdout.text).toBe('abc: OK\n');
    expect(result.stderr.text).toContain(
      'sha256sum: mixed-binary.sum: 1: improperly formatted SHA256 checksum line',
    );
    expect(result.stderr.text).toContain(
      'sha256sum: WARNING: 1 line is improperly formatted',
    );
    expect(result.result.exitCode).toBe(0);
  });

  it('fails when no properly formatted checksum record exists', async () => {
    await harness.writeFile({ path: 'invalid.sum', data: 'not a checksum\n' });

    const result = await harness.execute({
      script: 'sha256sum -c invalid.sum',
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe(
      'sha256sum: invalid.sum: no properly formatted checksum lines found\n',
    );
    expect(result.result.exitCode).toBe(1);
  });

  it('ignores missing files but fails when no file can be verified', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    await harness.writeFile({
      path: 'some.sum',
      data: `\
${ABC_HASH}  missing
${ABC_HASH}  abc
`,
    });
    await harness.writeFile({
      path: 'none.sum',
      data: `${ABC_HASH}  missing\n`,
    });

    const some = await harness.execute({
      script: 'sha256sum -c --ignore-missing some.sum',
    });
    const none = await harness.execute({
      script: 'sha256sum -c --ignore-missing none.sum',
    });
    const noneStatus = await harness.execute({
      script: 'sha256sum -c --ignore-missing --status none.sum',
    });

    expect(some.stdout.text).toBe('abc: OK\n');
    expect(some.stderr.text).toBe('');
    expect(some.result.exitCode).toBe(0);
    expect(none.stdout.text).toBe('');
    expect(none.stderr.text).toBe('sha256sum: none.sum: no file was verified\n');
    expect(none.result.exitCode).toBe(1);
    expect(noneStatus.stdout.text).toBe('');
    expect(noneStatus.stderr.text).toBe('');
    expect(noneStatus.result.exitCode).toBe(1);
  });

  it('reports malformed summaries before no-file-verified failures', async () => {
    await harness.writeFile({
      path: 'none-valid.sum',
      data: `\
${ABC_HASH}  missing
malformed
`,
    });

    const result = await harness.execute({
      script: 'sha256sum -c --ignore-missing --warn none-valid.sum',
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe(`\
sha256sum: none-valid.sum: 2: improperly formatted SHA256 checksum line
sha256sum: WARNING: 1 line is improperly formatted
sha256sum: none-valid.sum: no file was verified
`);
    expect(result.result.exitCode).toBe(1);
  });

  it('reads checksum records from standard input', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });

    const result = await harness.execute({
      script: 'sha256sum -c',
      stdinText: `${ABC_HASH}  abc\n`,
    });

    expect(result.stdout.text).toBe('abc: OK\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('verifies standard input when the checksum source is a file', async () => {
    await harness.writeFile({
      path: 'stdin.sum',
      data: `${ABC_HASH}  -\n`,
    });

    const result = await harness.execute({
      script: 'sha256sum -c stdin.sum',
      stdinText: 'abc',
    });

    expect(result.stdout.text).toBe('-: OK\n');
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('rejects using standard input for both checksum records and checked data', async () => {
    const result = await harness.execute({
      script: 'sha256sum -c -',
      stdinText: `${ABC_HASH}  -\n`,
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toBe(
      "sha256sum: 'standard input': no properly formatted checksum lines found\n",
    );
    expect(result.result.exitCode).toBe(1);
  });

  it('rejects compute-only options in check mode', async () => {
    const zero = await harness.execute({ script: 'sha256sum -c -z' });
    const tag = await harness.execute({ script: 'sha256sum -c --tag' });
    const binary = await harness.execute({ script: 'sha256sum -c -b' });

    expect(zero.stderr.text).toContain(
      'sha256sum: the --zero option is not supported when verifying checksums',
    );
    expect(tag.stderr.text).toContain(
      'sha256sum: the --tag option is meaningless when verifying checksums',
    );
    expect(binary.stderr.text).toContain(
      'sha256sum: the --binary and --text options are meaningless when verifying checksums',
    );
    expect(zero.result.exitCode).toBe(1);
    expect(tag.result.exitCode).toBe(1);
    expect(binary.result.exitCode).toBe(1);
  });
});
