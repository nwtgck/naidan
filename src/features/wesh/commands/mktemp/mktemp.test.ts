import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { TEST_ONLY } from '@/features/wesh/commands/mktemp/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh mktemp random token generation', () => {
  it('uses the requested length and portable filename alphabet', () => {
    for (const length of [1, 3, 10, 64]) {
      const token = TEST_ONLY.generateRandomToken({ length });
      expect(token).toHaveLength(length);
      expect(token).toMatch(/^[A-Za-z0-9]+$/u);
    }
  });
});

describe('wesh mktemp', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    await wesh.vfs.mkdir({ path: '/tmp', recursive: true });
  });

  async function execute({
    script,
  }: {
    script: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('supports creating relative to an explicit temp directory', async () => {
    await wesh.vfs.mkdir({ path: '/workspace', recursive: true });

    const { result, stdout, stderr } = await execute({
      script: 'mktemp -p /workspace file.XXXXXX',
    });

    const path = stdout.text.trim();
    expect(path).toMatch(/^\/workspace\/file\.[A-Za-z0-9]{6}$/);
    await expect(wesh.vfs.stat({ path })).resolves.toMatchObject({ type: 'file' });
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports dry-run mode', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mktemp -u temp.XXXXXX',
    });

    const path = stdout.text.trim();
    expect(path).toMatch(/^temp\.[A-Za-z0-9]{6}$/);
    await expect(wesh.vfs.stat({ path: `/${path}` })).rejects.toThrow();
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves relative TMPDIR and --tmpdir paths in output', async () => {
    await wesh.vfs.mkdir({ path: '/workspace/tmp', recursive: true });

    const fromEnvironment = await execute({
      script: 'cd /workspace && TMPDIR=tmp mktemp',
    });
    const environmentPath = fromEnvironment.stdout.text.trim();
    expect(environmentPath).toMatch(/^tmp\/tmp\.[A-Za-z0-9]{10}$/);
    await expect(wesh.vfs.stat({ path: `/workspace/${environmentPath}` })).resolves.toMatchObject({ type: 'file' });
    expect(fromEnvironment.stderr.text).toBe('');
    expect(fromEnvironment.result.exitCode).toBe(0);

    const fromOption = await execute({
      script: 'cd /workspace && mktemp -p tmp file.XXXXXX',
    });
    const optionPath = fromOption.stdout.text.trim();
    expect(optionPath).toMatch(/^tmp\/file\.[A-Za-z0-9]{6}$/);
    await expect(wesh.vfs.stat({ path: `/workspace/${optionPath}` })).resolves.toMatchObject({ type: 'file' });
    expect(fromOption.stderr.text).toBe('');
    expect(fromOption.result.exitCode).toBe(0);
  });

  it('treats an empty TMPDIR as the default /tmp directory', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'TMPDIR= mktemp',
    });

    const path = stdout.text.trim();
    expect(path).toMatch(/^\/tmp\/tmp\.[A-Za-z0-9]{10}$/);
    await expect(wesh.vfs.stat({ path })).resolves.toMatchObject({ type: 'file' });
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats empty explicit tmpdir values as the default TMPDIR', async () => {
    await wesh.vfs.mkdir({ path: '/workspace/tmp', recursive: true });

    const attachedLong = await execute({
      script: 'cd /workspace && TMPDIR=tmp mktemp -u --tmpdir= probe.XXXXXX',
    });
    expect(attachedLong.stdout.text.trim()).toMatch(/^tmp\/probe\.[A-Za-z0-9]{6}$/u);
    expect(attachedLong.stderr.text).toBe('');
    expect(attachedLong.result.exitCode).toBe(0);

    const separateShort = await execute({
      script: "cd /workspace && TMPDIR=tmp mktemp -u -p '' probe.XXXXXX",
    });
    expect(separateShort.stdout.text.trim()).toMatch(/^tmp\/probe\.[A-Za-z0-9]{6}$/u);
    expect(separateShort.stderr.text).toBe('');
    expect(separateShort.result.exitCode).toBe(0);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mktemp --help',
    });

    expect(stdout.text).toContain('usage: mktemp [OPTION]... [TEMPLATE]');
    expect(stdout.text).toContain('--tmpdir');
    expect(stdout.text).toContain('--dry-run');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('replaces only the final X run in the final path component', async () => {
    const multiple = await execute({ script: 'mktemp preXXXmidXXX' });
    const directoryRun = await execute({ script: 'mkdir XXX && mktemp XXX/leafXXX' });
    const suffixRun = await execute({ script: "mktemp --suffix='X.txt' probe.XXX" });

    expect(multiple.stdout.text.trim()).toMatch(/^preXXXmid[A-Za-z0-9]{3}$/u);
    expect(directoryRun.stdout.text.trim()).toMatch(/^XXX\/leaf[A-Za-z0-9]{3}$/u);
    expect(suffixRun.stdout.text.trim()).toMatch(/^probe\.[A-Za-z0-9]{3}X\.txt$/u);
  });

  it('requires templates to end in X when --suffix is explicit', async () => {
    const { result, stdout, stderr } = await execute({
      script: "mktemp --suffix='.bak' probe.XXXX.txt",
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("with --suffix, template 'probe.XXXX.txt' must end in 'X'");
    expect(result.exitCode).toBe(1);
  });

  it('rejects a template whose final X run is too short', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mktemp preXXXmidX',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("template must contain at least 3 consecutive 'X' characters");
    expect(result.exitCode).toBe(1);
  });

  it('reports invalid templates', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'mktemp plain-name',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("template must contain at least 3 consecutive 'X' characters");
    expect(result.exitCode).toBe(1);
  });

  it('lets -t and bare --tmpdir override an explicit -p directory', async () => {
    await wesh.vfs.mkdir({ path: '/workspace/tmp', recursive: true });
    await wesh.vfs.mkdir({ path: '/workspace/other', recursive: true });

    const deprecatedBefore = await execute({
      script: 'cd /workspace && TMPDIR=tmp mktemp -u -t -p other probe.XXXX',
    });
    const deprecatedAfter = await execute({
      script: 'cd /workspace && TMPDIR=tmp mktemp -u -p other -t probe.XXXX',
    });
    const optionalAfter = await execute({
      script: 'cd /workspace && TMPDIR=tmp mktemp -u -p other --tmpdir probe.XXXX',
    });

    expect(deprecatedBefore.stdout.text.trim()).toMatch(/^tmp\/probe\.[A-Za-z0-9]{4}$/u);
    expect(deprecatedAfter.stdout.text.trim()).toMatch(/^tmp\/probe\.[A-Za-z0-9]{4}$/u);
    expect(optionalAfter.stdout.text.trim()).toMatch(/^tmp\/probe\.[A-Za-z0-9]{4}$/u);
    expect(deprecatedBefore.result.exitCode).toBe(0);
    expect(deprecatedAfter.result.exitCode).toBe(0);
    expect(optionalAfter.result.exitCode).toBe(0);
  });

  it('supports --tmpdir without an attached directory argument', async () => {
    await wesh.vfs.mkdir({ path: '/workspace/tmp', recursive: true });

    const defaultDirectory = await execute({
      script: 'mktemp --tmpdir probe.XXXXXX',
    });
    const defaultPath = defaultDirectory.stdout.text.trim();
    expect(defaultPath).toMatch(/^\/tmp\/probe\.[A-Za-z0-9]{6}$/);
    await expect(wesh.vfs.stat({ path: defaultPath })).resolves.toMatchObject({ type: 'file' });
    expect(defaultDirectory.stderr.text).toBe('');
    expect(defaultDirectory.result.exitCode).toBe(0);

    const environmentDirectory = await execute({
      script: 'cd /workspace && TMPDIR=tmp mktemp --tmpdir probe.XXXXXX',
    });
    const environmentPath = environmentDirectory.stdout.text.trim();
    expect(environmentPath).toMatch(/^tmp\/probe\.[A-Za-z0-9]{6}$/);
    await expect(wesh.vfs.stat({ path: `/workspace/${environmentPath}` })).resolves.toMatchObject({ type: 'file' });
    expect(environmentDirectory.stderr.text).toBe('');
    expect(environmentDirectory.result.exitCode).toBe(0);
  });

  it('rejects -h because GNU mktemp only supports the long help option', async () => {
    const execution = await execute({ script: 'mktemp -h' });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain("invalid option -- 'h'");
    expect(execution.result.exitCode).not.toBe(0);
  });

  it('stops argv processing when --help is reached before a later invalid option', async () => {
    const helpFirst = await execute({ script: 'mktemp --help --definitely-invalid-option' });
    const invalidFirst = await execute({ script: 'mktemp --definitely-invalid-option --help' });

    expect(helpFirst.result.exitCode).toBe(0);
    expect(helpFirst.stdout.text).not.toBe('');
    expect(helpFirst.stderr.text).toBe('');

    expect(invalidFirst.result.exitCode).not.toBe(0);
    expect(invalidFirst.stderr.text).not.toBe('');
  });

});
