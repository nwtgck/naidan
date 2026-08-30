import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git init', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({ script }: { script: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('preflights selected global config before creating a repository', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
printf '[bad\n' > /bad-global
GIT_CONFIG_GLOBAL=/bad-global git init /fresh`,
    });
    expect(result.exitCode).toBe(128);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('bad config line');

    const missing = await execute({ script: 'test ! -e /fresh' });
    expect(missing.result.exitCode).toBe(0);
  });

  it('preflights partial and existing non-bare repository config before mutation', async () => {
    const partial = await execute({
      script: `\
mkdir -p /partial/.git
printf '[bad\n' > /partial/.git/config
git init /partial`,
    });
    expect(partial.result.exitCode).toBe(128);
    expect(partial.stderr.text).toContain('bad config line');
    const partialUnchanged = await execute({ script: 'test ! -e /partial/.git/HEAD' });
    expect(partialUnchanged.result.exitCode).toBe(0);

    const setup = await execute({
      script: `\
git init -q /existing
printf '\n[bad\n' >> /existing/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);
    const reinit = await execute({ script: 'git init /existing' });
    expect(reinit.result.exitCode).toBe(128);
    expect(reinit.stderr.text).toContain('bad config line');
  });

  it('preflights partial bare repository config but ignores a non-repository config file', async () => {
    const partialBare = await execute({
      script: `\
mkdir -p /partial-bare
printf '[bad\n' > /partial-bare/config
git init --bare /partial-bare`,
    });
    expect(partialBare.result.exitCode).toBe(128);
    expect(partialBare.stderr.text).toContain('bad config line');
    const bareUnchanged = await execute({ script: 'test ! -e /partial-bare/HEAD' });
    expect(bareUnchanged.result.exitCode).toBe(0);

    const ordinary = await execute({
      script: `\
mkdir /ordinary
printf '[bad\n' > /ordinary/config
git init -q /ordinary
test -e /ordinary/.git/HEAD`,
    });
    expect(ordinary.result.exitCode).toBe(0);
    expect(ordinary.stderr.text).toBe('');
  });

  it('parses init options before target-local config but after global config', async () => {
    const setup = await execute({
      script: `\
git init -q /existing-options
printf '\n[bad\n' >> /existing-options/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    const invalid = await execute({ script: 'cd /existing-options; git init --definitely-invalid' });
    expect(invalid.result.exitCode).toBe(129);
    expect(invalid.stderr.text).toContain('error: unknown option');
    expect(invalid.stderr.text).not.toContain('bad config line');


    const globalWins = await execute({
      script: 'GIT_CONFIG_GLOBAL=/existing-options/.git/config git init --definitely-invalid /fresh-options',
    });
    expect(globalWins.result.exitCode).toBe(128);
    expect(globalWins.stderr.text).toContain('bad config line');
    const freshMissing = await execute({ script: 'test ! -e /fresh-options' });
    expect(freshMissing.result.exitCode).toBe(0);
  });
});
