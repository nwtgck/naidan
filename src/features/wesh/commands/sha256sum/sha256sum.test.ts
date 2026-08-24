import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSha256sumTestHarness,
  type Sha256sumTestHarness,
} from './test-utils';

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const HELLO_HASH = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const WORLD_HASH = '486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7';

describe('wesh sha256sum compute mode', () => {
  let harness: Sha256sumTestHarness;

  beforeEach(async () => {
    harness = await createSha256sumTestHarness();
  });

  it('hashes empty and non-empty standard input', async () => {
    const empty = await harness.execute({
      script: 'sha256sum',
      stdinText: '',
    });
    const abc = await harness.execute({
      script: 'sha256sum -',
      stdinText: 'abc',
    });

    expect(empty.stdout.text).toBe(`${EMPTY_HASH}  -\n`);
    expect(empty.stderr.text).toBe('');
    expect(empty.result.exitCode).toBe(0);
    expect(abc.stdout.text).toBe(`${ABC_HASH}  -\n`);
    expect(abc.stderr.text).toBe('');
    expect(abc.result.exitCode).toBe(0);
  });

  it('produces the same digest across irregular stream chunks', async () => {
    const textEncoder = new TextEncoder();
    const result = await harness.execute({
      script: 'sha256sum',
      stdinChunks: [
        textEncoder.encode('a'),
        textEncoder.encode('b'),
        textEncoder.encode('c'),
      ],
    });

    expect(result.stdout.text).toBe(`${ABC_HASH}  -\n`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('handles SHA256 padding boundaries and multi-block input', async () => {
    const vectors = [
      {
        input: 'a'.repeat(55),
        hash: '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
      },
      {
        input: 'a'.repeat(56),
        hash: 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
      },
      {
        input: 'a'.repeat(64),
        hash: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
      },
      {
        input: 'a'.repeat(65),
        hash: '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0',
      },
    ];

    for (const vector of vectors) {
      const result = await harness.execute({
        script: 'sha256sum',
        stdinText: vector.input,
      });
      expect(result.stdout.text).toBe(`${vector.hash}  -\n`);
      expect(result.stderr.text).toBe('');
      expect(result.result.exitCode).toBe(0);
    }
  });

  it('matches the one-million-byte SHA256 reference vector', async () => {
    const result = await harness.execute({
      script: 'sha256sum',
      stdinText: 'a'.repeat(1_000_000),
    });

    expect(result.stdout.text).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0  -\n',
    );
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('hashes binary files and preserves operand order', async () => {
    await harness.writeFile({ path: 'hello.txt', data: 'hello' });
    await harness.writeFile({ path: 'world.txt', data: 'world' });

    const result = await harness.execute({
      script: 'sha256sum hello.txt world.txt',
    });

    expect(result.stdout.text).toBe(`\
${HELLO_HASH}  hello.txt
${WORLD_HASH}  world.txt
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('supports binary, text, BSD, and NUL-terminated output formats', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });

    const binary = await harness.execute({ script: 'sha256sum -b abc' });
    const textAfterBinary = await harness.execute({ script: 'sha256sum -bt abc' });
    const tag = await harness.execute({ script: 'sha256sum --tag abc' });
    const tagAfterText = await harness.execute({ script: 'sha256sum -t --tag abc' });
    const zero = await harness.execute({ script: 'sha256sum -z abc' });

    expect(binary.stdout.text).toBe(`${ABC_HASH} *abc\n`);
    expect(textAfterBinary.stdout.text).toBe(`${ABC_HASH}  abc\n`);
    expect(tag.stdout.text).toBe(`SHA256 (abc) = ${ABC_HASH}\n`);
    expect(tagAfterText.stdout.text).toBe(`SHA256 (abc) = ${ABC_HASH}\n`);
    expect(Array.from(zero.stdout.buffer)).toEqual(
      Array.from(new TextEncoder().encode(`${ABC_HASH}  abc\0`)),
    );
    expect(binary.result.exitCode).toBe(0);
    expect(textAfterBinary.result.exitCode).toBe(0);
    expect(tag.result.exitCode).toBe(0);
    expect(tagAfterText.result.exitCode).toBe(0);
    expect(zero.result.exitCode).toBe(0);
  });

  it('consumes repeated standard-input operands sequentially', async () => {
    const result = await harness.execute({
      script: 'sha256sum - -',
      stdinText: 'abc',
    });

    expect(result.stdout.text).toBe(`\
${ABC_HASH}  -
${EMPTY_HASH}  -
`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('continues after an unreadable operand', async () => {
    await harness.writeFile({ path: 'present.txt', data: 'hello' });

    const result = await harness.execute({
      script: 'sha256sum missing.txt present.txt',
    });

    expect(result.stdout.text).toBe(`${HELLO_HASH}  present.txt\n`);
    expect(result.stderr.text).toContain('sha256sum: missing.txt:');
    expect(result.result.exitCode).toBe(1);
  });

  it('treats operands after double dash as file names', async () => {
    await harness.writeFile({ path: '-b', data: 'abc' });

    const result = await harness.execute({ script: 'sha256sum -- -b' });

    expect(result.stdout.text).toBe(`${ABC_HASH}  -b\n`);
    expect(result.stderr.text).toBe('');
    expect(result.result.exitCode).toBe(0);
  });

  it('prints help and version information', async () => {
    const help = await harness.execute({ script: 'sha256sum --help' });
    const version = await harness.execute({ script: 'sha256sum --version' });

    expect(help.stdout.text).toContain('Print or check SHA256 checksums');
    expect(help.stdout.text).toContain('usage: sha256sum [OPTION]... [FILE]...');
    expect(help.stdout.text).toContain('--ignore-missing');
    expect(help.stdout.text).toContain('--version');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);
    expect(version.stdout.text).toMatch(/^sha256sum \(wesh\) \S+\n$/u);
    expect(version.stderr.text).toBe('');
    expect(version.result.exitCode).toBe(0);
  });

  it('stops option processing at the first help or version action', async () => {
    const helpBeforeInvalid = await harness.execute({
      script: 'sha256sum --help --unknown',
    });
    const invalidBeforeHelp = await harness.execute({
      script: 'sha256sum --unknown --help',
    });
    const versionBeforeInvalid = await harness.execute({
      script: 'sha256sum --version --unknown',
    });
    const invalidBeforeVersion = await harness.execute({
      script: 'sha256sum --unknown --version',
    });
    const versionBeforeHelp = await harness.execute({
      script: 'sha256sum --version --help',
    });

    expect(helpBeforeInvalid.stdout.text).toContain('Print or check SHA256 checksums');
    expect(helpBeforeInvalid.stderr.text).toBe('');
    expect(helpBeforeInvalid.result.exitCode).toBe(0);
    expect(invalidBeforeHelp.stdout.text).toBe('');
    expect(invalidBeforeHelp.stderr.text).toContain(
      "sha256sum: unrecognized option '--unknown'",
    );
    expect(invalidBeforeHelp.result.exitCode).toBe(1);
    expect(versionBeforeInvalid.stdout.text).toMatch(/^sha256sum \(wesh\) \S+\n$/u);
    expect(versionBeforeInvalid.stderr.text).toBe('');
    expect(versionBeforeInvalid.result.exitCode).toBe(0);
    expect(invalidBeforeVersion.stdout.text).toBe('');
    expect(invalidBeforeVersion.stderr.text).toContain(
      "sha256sum: unrecognized option '--unknown'",
    );
    expect(invalidBeforeVersion.result.exitCode).toBe(1);
    expect(versionBeforeHelp.stdout.text).toMatch(/^sha256sum \(wesh\) \S+\n$/u);
    expect(versionBeforeHelp.stderr.text).toBe('');
    expect(versionBeforeHelp.result.exitCode).toBe(0);
  });

  it('rejects invalid and check-only options in compute mode', async () => {
    await harness.writeFile({ path: 'abc', data: 'abc' });
    const unknown = await harness.execute({ script: 'sha256sum --unknown' });
    const quiet = await harness.execute({ script: 'sha256sum --quiet' });
    const tagText = await harness.execute({ script: 'sha256sum --tag -t abc' });
    const tagBinary = await harness.execute({ script: 'sha256sum --tag -tb abc' });
    const tagBinaryText = await harness.execute({ script: 'sha256sum --tag -bt abc' });

    expect(unknown.stdout.text).toBe('');
    expect(unknown.stderr.text).toContain("sha256sum: unrecognized option '--unknown'");
    expect(unknown.result.exitCode).toBe(1);
    expect(quiet.stdout.text).toBe('');
    expect(quiet.stderr.text).toContain(
      'sha256sum: the --quiet option is meaningful only when verifying checksums',
    );
    expect(quiet.result.exitCode).toBe(1);
    expect(tagText.stdout.text).toBe('');
    expect(tagText.stderr.text).toContain(
      'sha256sum: --tag does not support --text mode',
    );
    expect(tagText.result.exitCode).toBe(1);
    expect(tagBinary.stdout.text).toBe(`SHA256 (abc) = ${ABC_HASH}\n`);
    expect(tagBinary.stderr.text).toBe('');
    expect(tagBinary.result.exitCode).toBe(0);
    expect(tagBinaryText.stdout.text).toBe('');
    expect(tagBinaryText.stderr.text).toContain(
      'sha256sum: --tag does not support --text mode',
    );
    expect(tagBinaryText.result.exitCode).toBe(1);
  });
});
