import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('shopt command', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    wesh = new Wesh({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
    });
    await wesh.init();
  });

  async function execute({
    script,
  }: {
    script: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return {
      result,
      stdout,
      stderr,
    };
  }

  it('shows help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'shopt --help',
    });

    expect(stdout.text).toContain('usage: shopt [-opqsu] [optname ...]');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('sets, unsets, prints, and queries shell options', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
shopt -s extglob globstar nullglob
shopt -p extglob globstar nullglob
shopt -q extglob globstar nullglob
echo $?
shopt -u nullglob
shopt -q nullglob
echo $?`,
    });

    expect(stdout.text).toBe(`\
shopt -s extglob
shopt -s globstar
shopt -s nullglob
0
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects invalid shell option names', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'shopt -s missing-option',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('shopt: missing-option: invalid shell option name\n');
    expect(result.exitCode).toBe(1);
  });

  it('prints named option states in human-readable and reusable formats', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
shopt nullglob
printf 'status=%s\n' "$?"
shopt -p nullglob
printf 'status=%s\n' "$?"`,
    });

    expect(stdout.text).toBe(`\
nullglob       \toff
status=1
shopt -u nullglob
status=1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('lists enabled or disabled options when set or unset has no names', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
shopt -s nullglob
shopt -s | grep '^nullglob'
shopt -u nullglob
shopt -u | grep '^nullglob'`,
    });

    expect(stdout.text).toBe(`\
nullglob       \ton
nullglob       \toff
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('continues applying valid names when another name is invalid', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
shopt -u nullglob
shopt -s missing nullglob
printf 'status=%s;' "$?"
shopt -q nullglob
printf 'query=%s\n' "$?"`,
    });

    expect(stdout.text).toBe('status=1;query=0\n');
    expect(stderr.text).toContain('missing: invalid shell option name');
    expect(result.exitCode).toBe(0);
  });

  it('allows query and print flags alongside a set or unset action', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
shopt -u nullglob
shopt -sq nullglob
printf 'set=%s;' "$?"
shopt -pu nullglob
printf 'unset=%s;' "$?"
shopt -q nullglob
printf 'query=%s\n' "$?"`,
    });

    expect(stdout.text).toBe('set=0;unset=0;query=1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rejects simultaneous set and unset without mutating options', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
shopt -u nullglob
shopt -su nullglob
printf 'status=%s;' "$?"
shopt -q nullglob
printf 'query=%s\n' "$?"`,
    });

    expect(stdout.text).toBe('status=1;query=1\n');
    expect(stderr.text).toContain('cannot set and unset');
    expect(result.exitCode).toBe(0);
  });

  it('stops option parsing after the first shell option name', async () => {
    const { result, stdout, stderr } = await execute({
      script: `shopt extglob -s >/dev/null 2>/dev/null; first=$?; shopt -q extglob; printf '%s|%s\\n' "$first" "$?"`,
    });

    expect(stdout.text).toBe('1|1\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

});
