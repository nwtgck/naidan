import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { gitCommandDefinition } from '@/features/wesh/commands/git/definition';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createWriteHandleFromStream } from '@/features/wesh/utils/stream';
import type { WeshFileHandle } from '@/features/wesh/types';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { objectIdFor } from './objects';
import { replaceTextViaLock } from './files';

const textEncoder = new TextEncoder();

beforeAll(async () => {
  await gitCommandDefinition.load();
});

describe('wesh git core lifecycle', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({ script, signal, output }: { script: string, signal?: AbortSignal, output?: WeshFileHandle }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: output ?? stdout.handle,
      stderr: stderr.handle,
      signal,
    });
    return { result, stdout, stderr };
  }

  it('uses canonical Git object identifiers for blobs', () => {
    expect(objectIdFor({
      object: {
        type: 'blob',
        body: textEncoder.encode('hello\n'),
      },
    })).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  const initialCommit = `\
git init -q repo
cd /repo
git config user.name Tester
git config user.email tester@example.com
git commit --allow-empty -m initial`;

  it('keeps an independently created branch when storing its reflog fails', async () => {
    const setup = await execute({ script: initialCommit });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const heads = await (await git.getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const logs = await (await (await git.getDirectoryHandle('logs')).getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const getFileHandle = logs.getFileHandle.bind(logs);
    const foreignId = '1'.repeat(40);
    using _failLog = vi.spyOn(logs, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'topic.lock' && options?.create === true) {
        await heads.removeEntry('topic').catch(() => {});
        const foreignRef = await heads.getFileHandle('topic', { create: true });
        foreignRef.content = textEncoder.encode(`${foreignId}\n`);
        throw new DOMException('Reflog write denied', 'NoModificationAllowedError');
      }
      return getFileHandle(name, options);
    });

    const branch = await execute({ script: 'git branch topic' });
    expect(branch.result.exitCode).toBe(128);
    expect(branch.stderr.text).toContain('Reflog write denied');
    expect(await (await (await heads.getFileHandle('topic')).getFile()).text()).toBe(`${foreignId}\n`);
    await expect(heads.getFileHandle('topic.lock')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('rejects a commit when its parent ref changed before the commit could lock it', async () => {
    const setup = await execute({ script: initialCommit });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const heads = await (await git.getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const head = (await (await (await git.getFileHandle('HEAD')).getFile()).text()).trim();
    const name = head.slice('ref: refs/heads/'.length);
    const headLog = await (await git.getDirectoryHandle('logs')).getFileHandle('HEAD');
    const previousLog = await (await headLog.getFile()).text();
    const branch = await heads.getFileHandle(name);
    const acquire = wesh.vfs.createTemporaryFile.bind(wesh.vfs);
    const newerId = '2'.repeat(40);
    using _concurrentUpdate = vi.spyOn(wesh.vfs, 'createTemporaryFile').mockImplementation(async args => {
      if (args.path === `/repo/.git/refs/heads/${name}.lock`) {
        branch.content = textEncoder.encode(`${newerId}\n`);
      }
      return acquire(args);
    });

    const commit = await execute({ script: 'git commit --allow-empty -m next' });
    expect(commit.result.exitCode).toBe(128);
    expect(commit.stderr.text).toContain('HEAD changed while preparing the update');
    expect(await (await branch.getFile()).text()).toBe(`${newerId}\n`);
    expect(await (await headLog.getFile()).text()).toBe(previousLog);
    await expect(git.getFileHandle('HEAD.lock')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(heads.getFileHandle(`${name}.lock`)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('settles branch and reflog publication after Stop once the reflog write was accepted', async () => {
    const setup = await execute({ script: initialCommit });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const heads = await (await git.getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const logs = await (await (await git.getDirectoryHandle('logs')).getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const readLog = logs.getFileHandle.bind(logs);
    const accepted = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        proceed.resolve();
      },
    };
    using _log = vi.spyOn(logs, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await readLog(name, options);
      if (name === 'topic' && options?.create === true) {
        const writer = await file.createWritable();
        const close = writer.close.bind(writer);
        vi.spyOn(writer, 'close').mockImplementationOnce(async () => {
          await close();
          accepted.resolve();
          await proceed.promise;
        });
        vi.spyOn(file, 'createWritable').mockResolvedValueOnce(writer);
      }
      return file;
    });
    const controller = new AbortController();
    const branching = execute({ script: 'git branch topic', signal: controller.signal });
    await accepted.promise;
    controller.abort();
    expect(wesh.vfs.hasPendingFilePublications()).toBe(true);
    await expect(heads.getFileHandle('topic')).rejects.toMatchObject({ name: 'NotFoundError' });
    proceed.resolve();

    const branch = await branching;
    expect(branch.result.exitCode).toBe(130);
    const objectId = (await (await (await heads.getFileHandle('topic')).getFile()).text()).trim();
    const log = await (await (await readLog('topic')).getFile()).text();
    expect(log).toContain(`${'0'.repeat(40)} ${objectId} `);
    expect(wesh.vfs.hasPendingFilePublications()).toBe(false);
  });

  it('does not list a first stash when only its reflog was published', async () => {
    const setup = await execute({ script: initialCommit });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const refs = await git.getDirectoryHandle('refs');
    const getRef = refs.getFileHandle.bind(refs);
    using _ref = vi.spyOn(refs, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'stash' && options?.create === true) {
        throw new DOMException('Ref creation denied', 'NoModificationAllowedError');
      }
      return getRef(name, options);
    });
    const stash = await execute({
      script: `\
printf 'staged' > file
git add file
git stash push`,
    });
    expect(stash.result.exitCode).toBe(128);
    expect(stash.stderr.text).toContain("Could not publish '/repo/.git/refs/stash'");
    await expect(refs.getFileHandle('stash')).rejects.toMatchObject({ name: 'NotFoundError' });
    const recovery = await refs.getFileHandle('stash.lock');
    expect((await (await recovery.getFile()).text()).trim()).toMatch(/^[0-9a-f]{40}$/u);
    const listed = await execute({ script: 'git stash list' });
    expect(listed.result.exitCode).toBe(0);
    expect(listed.stdout.text).toBe('');
  });

  it.each(['clear', 'drop'])('finishes stash %s after Stop once the ref unlink was accepted', async subcommand => {
    const setup = await execute({ script: `${initialCommit}\nprintf 'staged' > file\ngit add file\ngit stash push` });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const refs = await git.getDirectoryHandle('refs');
    const logs = await (await git.getDirectoryHandle('logs')).getDirectoryHandle('refs');
    const removeEntry = refs.removeEntry.bind(refs);
    const accepted = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        proceed.resolve();
      },
    };
    using _remove = vi.spyOn(refs, 'removeEntry').mockImplementation(async (name, options) => {
      await removeEntry(name, options);
      if (name === 'stash') {
        accepted.resolve();
        await proceed.promise;
      }
    });
    const controller = new AbortController();
    const removing = execute({ script: `git stash ${subcommand}`, signal: controller.signal });
    await accepted.promise;
    controller.abort();
    expect(wesh.vfs.hasPendingFilePublications()).toBe(true);
    await expect(refs.getFileHandle('stash.lock')).resolves.toBeDefined();
    await expect(logs.getFileHandle('stash')).resolves.toBeDefined();
    proceed.resolve();

    const removed = await removing;
    expect(removed.result.exitCode).toBe(130);
    await expect(refs.getFileHandle('stash')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(logs.getFileHandle('stash')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(wesh.vfs.hasPendingFilePublications()).toBe(false);
  });

  it('keeps a detached stash log for recovery without reviving its entries on push', async () => {
    const setup = await execute({ script: `${initialCommit}\nprintf 'old' > file\ngit add file\ngit stash push -m old` });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const logs = await (await git.getDirectoryHandle('logs')).getDirectoryHandle('refs');
    const oldLog = await (await (await logs.getFileHandle('stash')).getFile()).text();
    {
      using _remove = vi.spyOn(logs, 'removeEntry').mockRejectedValueOnce(new DOMException('Log removal denied', 'NotAllowedError'));
      const failed = await execute({ script: 'git stash clear' });
      expect(failed.result.exitCode).toBe(128);
      expect(failed.stderr.text).toContain('Log removal denied');
    }

    const pushed = await execute({
      script: `printf 'new' > file\ngit add file\ngit stash push -m new >/dev/null && git stash list`,
    });
    expect(pushed.result.exitCode, pushed.stderr.text).toBe(0);
    expect(pushed.stdout.text).toBe('stash@{0}: On master: new\n');
    const currentLog = await (await (await logs.getFileHandle('stash')).getFile()).text();
    expect(currentLog.startsWith(oldLog)).toBe(true);
    const old = await execute({ script: "git stash drop 'stash@{1}'" });
    expect(old.result.exitCode).toBe(128);
    expect(await (await (await logs.getFileHandle('stash')).getFile()).text()).toBe(currentLog);
  });

  it('preserves the live stash and recovery log when publishing its replacement fails', async () => {
    const setup = await execute({ script: `${initialCommit}\nprintf 'first' > file\ngit add file\ngit stash push -m first` });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const refs = await git.getDirectoryHandle('refs');
    const ref = await refs.getFileHandle('stash');
    const logs = await (await git.getDirectoryHandle('logs')).getDirectoryHandle('refs');
    {
      using _write = vi.spyOn(ref, 'createWritable').mockRejectedValueOnce(new DOMException('Ref replacement denied', 'NotAllowedError'));
      const failed = await execute({ script: `printf 'failed' > file\ngit add file\ngit stash push -m failed` });
      expect(failed.result.exitCode).toBe(128);
      expect(failed.stderr.text).toContain('Ref replacement denied');
    }
    const log = await logs.getFileHandle('stash');
    const recoveryLine = (await (await log.getFile()).text()).split('\n').find(line => line.endsWith('On master: failed'));
    expect(recoveryLine).toBeDefined();
    const listed = await execute({ script: 'git stash list' });
    expect(listed.stdout.text).toBe('stash@{0}: On master: first\n');
    await refs.removeEntry('stash.lock');
    const pushed = await execute({
      script: `printf 'latest' > file\ngit add file\ngit stash push -m latest >/dev/null && git stash list`,
    });
    expect(pushed.result.exitCode, pushed.stderr.text).toBe(0);
    expect(pushed.stdout.text).toBe(`\
stash@{0}: On master: latest
stash@{1}: On master: first
`);

    const dropped = await execute({ script: 'git stash drop >/dev/null && git stash list' });
    expect(dropped.result.exitCode, dropped.stderr.text).toBe(0);
    expect(dropped.stdout.text).toBe('stash@{0}: On master: first\n');
    const last = await execute({ script: 'git stash drop >/dev/null && git stash list' });
    expect(last.result.exitCode, last.stderr.text).toBe(0);
    expect(last.stdout.text).toBe('');
    const keptLog = await logs.getFileHandle('stash');
    expect((await (await keptLog.getFile()).text()).split('\n')).toContain(recoveryLine);
  });

  it.each([
    { destination: 'ref', remaining: ['latest', 'first'] },
    { destination: 'reflog', remaining: ['first'] },
  ])('preserves stash history when dropping the latest entry cannot publish the $destination', async ({ destination, remaining }) => {
    const setup = await execute({
      script: `\
${initialCommit}
for message in first latest; do
  printf '%s' "$message" > file
  git add file
  git stash push -m "$message" >/dev/null
done`,
    });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const refs = await git.getDirectoryHandle('refs');
    const logs = await (await git.getDirectoryHandle('logs')).getDirectoryHandle('refs');
    const log = await logs.getFileHandle('stash');
    const originalLog = await (await log.getFile()).text();
    const failing = destination === 'ref' ? await refs.getFileHandle('stash') : log;
    using _write = vi.spyOn(failing, 'createWritable').mockRejectedValueOnce(new DOMException('Replacement denied', 'NotAllowedError'));

    const dropped = await execute({ script: 'git stash drop' });
    expect(dropped.result.exitCode).toBe(128);
    expect(dropped.stderr.text).toContain('Replacement denied');
    const after = await execute({ script: 'git stash list' });
    expect(after.stdout.text).toBe(remaining.map((message, index) => `stash@{${index}}: On master: ${message}\n`).join(''));
    expect(await (await (await logs.getFileHandle('stash')).getFile()).text()).toBe(originalLog);
  });

  it('does not pop a different stash with the same object ID after the list changes', async () => {
    const setup = await execute({
      script: `\
${initialCommit} >/dev/null
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
for repeat in one two; do
  printf 'same change' > file
  git add file
  git stash push -m same >/dev/null
done
cat .git/logs/refs/stash`,
    });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const [first, second] = setup.stdout.text.trimEnd().split('\n');
    expect(first?.split(' ')[1]).toMatch(/^[0-9a-f]{40}$/u);
    expect(second?.split(' ')[1]).toBe(first?.split(' ')[1]);

    const applied = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        proceed.resolve();
      },
    };
    const output = createWriteHandleFromStream({
      target: new WritableStream<Uint8Array>({
        async write() {
          applied.resolve();
          await proceed.promise;
        },
      }),
    });
    const popping = execute({ script: 'git stash pop', output });
    await applied.promise;
    const competing = await execute({ script: 'git stash drop' });
    expect(competing.result.exitCode, competing.stderr.text).toBe(0);
    proceed.resolve();

    const result = await popping;
    expect(result.result.exitCode).toBe(1);
    expect(result.stderr.text).toContain('stash changed after apply, skipped drop');
    const retained = await execute({ script: 'git stash list && cat file' });
    expect(retained.result.exitCode, retained.stderr.text).toBe(0);
    expect(retained.stdout.text).toBe(`\
stash@{0}: On master: same
same change`);
  });

  it('preserves the publication error and leaves the lock alone when source cleanup fails', async () => {
    const destination = await rootHandle.getFileHandle('ref', { create: true });
    const removeEntry = rootHandle.removeEntry.bind(rootHandle);
    const remove = vi.spyOn(rootHandle, 'removeEntry').mockImplementation(async (name, options) => {
      if (name === 'ref.lock') {
        throw new DOMException('lock removal denied', 'NotAllowedError');
      }
      await removeEntry(name, options);
    });

    await expect(replaceTextViaLock({ files: wesh.kernel, path: '/ref', text: 'new ref' })).rejects.toMatchObject({
      name: 'WeshRenameIncompleteError',
      cause: expect.objectContaining({ message: 'lock removal denied' }),
    });
    expect(remove.mock.calls.filter(([name]) => name === 'ref.lock')).toHaveLength(1);
    expect(await (await destination.getFile()).text()).toBe('new ref');
    expect(await (await (await rootHandle.getFileHandle('ref.lock')).getFile()).text()).toBe('new ref');
  });

  it.each(['verified', 'unverifiable'] as const)('keeps a new lock acquired after native publication is %s', async verification => {
    const getFile = rootHandle.getFileHandle.bind(rootHandle);
    let installed = false;
    vi.spyOn(rootHandle, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await getFile(name, options);
      if (!installed && name === 'ref.lock' && options?.create) {
        installed = true;
        Object.assign(file, {
          async move() {
            const nextRef = await getFile('ref', { create: true });
            const writer = await nextRef.createWritable();
            await writer.write(await file.getFile());
            await writer.close();
            await rootHandle.removeEntry('ref.lock');
            const nextLock = await getFile('ref.lock', { create: true });
            const lockWriter = await nextLock.createWritable();
            await lockWriter.write('next lock');
            await lockWriter.close();
            vi.spyOn(file, 'isSameEntry').mockResolvedValueOnce(verification === 'verified');
          },
        });
      }
      return file;
    });

    const publication = replaceTextViaLock({ files: wesh.kernel, path: '/ref', text: 'first lock' });
    if (verification === 'verified') {
      await expect(publication).resolves.toBeUndefined();
    } else {
      await expect(publication).rejects.toMatchObject({ name: 'WeshRenameIncompleteError' });
    }
    expect(await (await (await getFile('ref')).getFile()).text()).toBe('first lock');
    expect(await (await (await getFile('ref.lock')).getFile()).text()).toBe('next lock');
  });

  it.each([
    { stop: true, replaced: false, exitCode: 130 },
    { stop: false, replaced: true, exitCode: 1 },
    { stop: true, replaced: true, exitCode: 130 },
  ])('preserves the destination and cleans only its own lock (stop=$stop, replaced=$replaced)', async ({ stop, replaced, exitCode }) => {
    const destination = await rootHandle.getFileHandle('ref', { create: true });
    destination.content = textEncoder.encode('old ref');
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    using _resume = {
      [Symbol.dispose]() {
        resume.resolve();
      },
    };
    wesh.registerCommand({
      definition: {
        meta: { name: 'replace-git-lock', description: 'Replace a Git file through a lock', usage: 'replace-git-lock' },
        load: async () => async ({ context }) => {
          const rename = context.files.rename;
          using _rename = vi.spyOn(context.files, 'rename').mockImplementation(async args => {
            ready.resolve();
            await resume.promise;
            return rename(args);
          });
          try {
            await replaceTextViaLock({ files: context.files, path: '/ref', text: 'new ref' });
            return { exitCode: 0 };
          } finally {
            finished.resolve();
          }
        },
      },
    });

    const controller = new AbortController();
    const execution = execute({ script: 'replace-git-lock', signal: controller.signal });
    await ready.promise;
    if (replaced) {
      await rootHandle.removeEntry('ref.lock');
      const nextLock = await rootHandle.getFileHandle('ref.lock', { create: true });
      nextLock.content = textEncoder.encode('another writer');
    }
    if (stop) {
      controller.abort();
      await wesh.interruptForeground({ foregroundSignal: controller.signal });
    }
    resume.resolve();

    await finished.promise;
    const result = await execution;
    expect(result.result.exitCode).toBe(exitCode);
    expect(await (await destination.getFile()).text()).toBe('old ref');
    if (replaced) {
      const nextLock = await rootHandle.getFileHandle('ref.lock');
      expect(await (await nextLock.getFile()).text()).toBe('another writer');
    } else {
      await expect(rootHandle.getFileHandle('ref.lock')).rejects.toMatchObject({ name: 'NotFoundError' });
    }
  });

  it('initializes, stages, commits, reports status, and reads history through shared primitives', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git status --short
git add hello.txt
git status --short
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial
cat .git/refs/heads/master
git log --oneline
git status --short`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
Initialized empty Git repository in /repo/.git/
?? hello.txt
A  hello.txt
[master (root-commit) 7cac307] initial
7cac307b38298843a48a70fb0489f3618383cba1
7cac307 initial
`);
  });

  it('keeps staged and unstaged changes distinct in short status', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q /repo
cd /repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\\n' > tracked.txt
git add tracked.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
printf 'two\\n' >> tracked.txt
printf 'new\\n' > new.txt
git status --short
git add tracked.txt
git status --short`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
?? new.txt
 M tracked.txt
?? new.txt
M  tracked.txt
`);
  });

  it('resolves revisions and paths through shared revision primitives', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git rev-parse HEAD
git rev-parse master
git rev-parse --short HEAD
git rev-parse --short=12 HEAD
git rev-parse --short=1 HEAD
git rev-parse --short=+8 HEAD
git rev-parse '--short= 8' HEAD
git rev-parse --short=12x HEAD
git rev-parse --short=2147483648 HEAD
git rev-parse HEAD:hello.txt
mkdir subdir
cd subdir
git rev-parse --show-toplevel
git rev-parse --git-dir`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
7cac307b38298843a48a70fb0489f3618383cba1
7cac307b38298843a48a70fb0489f3618383cba1
7cac307
7cac307b3829
7cac
7cac307b
7cac307b
7cac307b3829
7cac
ce013625030ba8dba906f756967f9e9ca394464a
/repo
/repo/.git
`);
  });

  it('resolves a linked worktree gitfile through its common directory', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q main
cd main
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
mkdir -p /main/.git/worktrees/linked /linked
printf 'gitdir: /main/.git/worktrees/linked\\n' > /linked/.git
printf '../..\\n' > /main/.git/worktrees/linked/commondir
printf 'ref: refs/heads/master\\n' > /main/.git/worktrees/linked/HEAD
cd /linked
git rev-parse HEAD
git rev-parse --git-dir
git rev-parse --git-common-dir`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
7cac307b38298843a48a70fb0489f3618383cba1
/main/.git/worktrees/linked
/main/.git
`);
  });

  it('writes canonical commit reflogs and keeps config keys in one section', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
cat .git/config
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
cat .git/logs/HEAD
cat .git/logs/refs/heads/master`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
[core]
\trepositoryformatversion = 0
\tfilemode = false
\tbare = false
\tlogallrefupdates = true

[user]
\tname = Tester
\temail = tester@example.com
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tcommit (initial): initial
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tcommit (initial): initial
`);
  });

  it('creates, lists, and safely deletes branches through ref and graph primitives', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git branch --show-current
git branch topic
git branch --no-color
cat .git/logs/refs/heads/topic
git branch -d topic`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
master
* master
  topic
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tbranch: Created from master
Deleted branch topic (was 7cac307).
`);
  });

  it('honors explicit-empty core.logallrefupdates and rejects a valueless override', async () => {
    await execute({
      script: `\
git init -q /repo
git -C /repo config user.name Tester
git -C /repo config user.email tester@example.com
printf 'hello\n' > /repo/hello.txt
git -C /repo add hello.txt
git -C /repo commit -m initial >/dev/null`,
    });

    const disabled = await execute({
      script: `\
git -C /repo -c core.logallrefupdates= branch no-log &&
test ! -e /repo/.git/logs/refs/heads/no-log &&
git -C /repo -c core.logallrefupdates= checkout -b checkout-no-log master &&
test ! -e /repo/.git/logs/refs/heads/checkout-no-log &&
git -C /repo checkout master &&
git -C /repo -c core.logallrefupdates= branch rename-source &&
test ! -e /repo/.git/logs/refs/heads/rename-source &&
git -C /repo -c core.logallrefupdates= branch -m rename-source renamed &&
test ! -e /repo/.git/logs/refs/heads/renamed`,
    });
    expect(disabled.result.exitCode).toBe(0);
    expect(disabled.stderr.text).not.toContain('fatal:');

    const always = await execute({
      script: `\
git -C /repo -c core.logallrefupdates=always branch always-log &&
test -e /repo/.git/logs/refs/heads/always-log`,
    });
    expect(always.result.exitCode).toBe(0);
    expect(always.stderr.text).not.toContain('fatal:');

    const missingValue = await execute({
      script: 'git -C /repo -c core.logallrefupdates branch rejected',
    });
    expect(missingValue.result.exitCode).not.toBe(0);
    expect(missingValue.stderr.text).toContain("missing value for 'core.logallrefupdates'");
  });

  it('reads history and file contents from explicit revisions', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
printf 'world\\n' >> hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
git rev-parse HEAD
git rev-parse HEAD~1
git log --oneline -1 HEAD~1
git show HEAD:hello.txt
git show --no-patch HEAD`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
7cac307b38298843a48a70fb0489f3618383cba1
7cac307 initial
hello
world
commit ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
Author: Tester <tester@example.com>
Date:   Sun Feb 4 04:05:06 2001 +0000

    second

`);
  });

  it('shows a commit and its first-parent patch through the shared diff primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
printf 'world\n' >> hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
git show HEAD`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
commit ae11b21c1a5d6192892d2a0f8ff3f9940b849f77
Author: Tester <tester@example.com>
Date:   Sun Feb 4 04:05:06 2001 +0000

    second

diff --git a/hello.txt b/hello.txt
index ce01362..94954ab 100644
--- a/hello.txt
+++ b/hello.txt
@@ -1 +1,2 @@
 hello
+world
`);
  });

  it('reads reflog history through the shared reflog primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
printf 'world\\n' >> hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981259506 +0000'
export GIT_COMMITTER_DATE='981259506 +0000'
git commit -m second >/dev/null
git reflog -1
git reflog show master
git reflog show refs/heads/master -1`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
ae11b21 HEAD@{0}: commit: second
ae11b21 master@{0}: commit: second
7cac307 master@{1}: commit (initial): initial
ae11b21 refs/heads/master@{0}: commit: second
`);
  });

  it('resolves shorthand remote-tracking reflog names to refs/remotes', async () => {
    const result = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
git commit -m initial >/dev/null
mkdir -p .git/refs/remotes/origin .git/logs/refs/remotes/origin
cp .git/refs/heads/master .git/refs/remotes/origin/master
cp .git/logs/refs/heads/master .git/logs/refs/remotes/origin/master
git reflog show origin/master`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    expect(result.stdout.text).toContain('refs/remotes/origin/master@{0}:');
  });

  it('applies numeric reflog selectors to the selected reflog', async () => {
    const result = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > file.txt
git add file.txt
git commit -m one >/dev/null
printf 'two\n' >> file.txt
git commit -am two >/dev/null
git reflog show master@{1}
git reflog show HEAD@{1}
git reflog show @{1}`,
    });

    expect(result.result.exitCode).toBe(0);
    expect(result.stderr.text).toBe('');
    const lines = result.stdout.text.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('master@{1}: commit (initial): one');
    expect(lines[1]).toContain('HEAD@{1}: commit (initial): one');
    expect(lines[2]).toContain('refs/heads/master@{1}: commit (initial): one');
  });

  it('rejects reflog selectors beyond the available history', async () => {
    const result = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'one\n' > file.txt
git add file.txt
git commit -m one >/dev/null
git reflog show master@{1}`,
    });

    expect(result.result.exitCode).toBe(128);
    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain("log for 'master' only has 1 entries");
  });

  it('rejects unknown reflog names instead of treating missing logs as empty', async () => {
    const missing = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
git commit -m initial >/dev/null
git reflog show missing`,
    });

    expect(missing.result.exitCode).toBe(128);
    expect(missing.stdout.text).toBe('');
    expect(missing.stderr.text).toContain("ambiguous argument 'missing'");
  });

  it('reads and updates packed refs through the ref primitive', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
rm .git/refs/heads/master
printf '# pack-refs with: peeled fully-peeled sorted \\n7cac307b38298843a48a70fb0489f3618383cba1 refs/heads/master\\n7cac307b38298843a48a70fb0489f3618383cba1 refs/heads/topic\\n' > .git/packed-refs
git rev-parse master
git rev-parse topic
git branch --no-color
git branch -d topic
cat .git/packed-refs`,
    });

    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe(`\
7cac307b38298843a48a70fb0489f3618383cba1
7cac307b38298843a48a70fb0489f3618383cba1
* master
  topic
Deleted branch topic (was 7cac307).
# pack-refs with: peeled fully-peeled sorted${' '}
7cac307b38298843a48a70fb0489f3618383cba1 refs/heads/master
`);
  });

  it('emits stable porcelain v1 and v2 status for automation', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf 'hello\nworld\n' > hello.txt
printf 'new\n' > staged.txt
git add staged.txt
printf 'untracked\n' > untracked.txt
git status --porcelain=v1 -z --branch
git status --porcelain=v2 --branch`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`## master\0 M hello.txt\0A  staged.txt\0?? untracked.txt\0# branch.oid 7cac307b38298843a48a70fb0489f3618383cba1
# branch.head master
1 .M N... 100644 100644 100644 ce013625030ba8dba906f756967f9e9ca394464a ce013625030ba8dba906f756967f9e9ca394464a hello.txt
1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 3e757656cf36eca53338e520d134963a44f793f8 staged.txt
? untracked.txt
`);
  });

  it('reads and writes subsection config keys without duplicating sections', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config remote.origin.url /source
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git config remote.backup.url /backup
git config remote.origin.url /source-updated
git config remote.origin.url
cat .git/config`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
/source-updated
[core]
\trepositoryformatversion = 0
\tfilemode = false
\tbare = false
\tlogallrefupdates = true

[remote "origin"]
\turl = /source-updated
\tfetch = +refs/heads/*:refs/remotes/origin/*

[remote "backup"]
\turl = /backup
`);
  });

  it('renames the current branch while preserving reflog history and upstream config', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
export GIT_AUTHOR_DATE='981173106 +0000'
export GIT_COMMITTER_DATE='981173106 +0000'
git commit -m initial >/dev/null
git config branch.master.remote origin
git config branch.master.merge refs/heads/main
git branch -m renamed
git branch --show-current
cat .git/HEAD
cat .git/logs/refs/heads/renamed
cat .git/logs/HEAD
git config branch.renamed.remote
git config branch.renamed.merge
test ! -e .git/refs/heads/master
test ! -e .git/logs/refs/heads/master`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
renamed
ref: refs/heads/renamed
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tcommit (initial): initial
7cac307b38298843a48a70fb0489f3618383cba1 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tBranch: renamed refs/heads/master to refs/heads/renamed
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tcommit (initial): initial
7cac307b38298843a48a70fb0489f3618383cba1 0000000000000000000000000000000000000000 Tester <tester@example.com> 981173106 +0000\tBranch: renamed refs/heads/master to refs/heads/renamed
0000000000000000000000000000000000000000 7cac307b38298843a48a70fb0489f3618383cba1 Tester <tester@example.com> 981173106 +0000\tBranch: renamed refs/heads/master to refs/heads/renamed
origin
refs/heads/main
`);
  });

  it('preserves the current branch when its rename cannot lock HEAD', async () => {
    const setup = await execute({ script: `${initialCommit}\ngit config branch.master.remote origin` });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const heads = await (await git.getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const logs = await git.getDirectoryHandle('logs');
    const branchLogs = await (await logs.getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const oldObjectId = await (await (await heads.getFileHandle('master')).getFile()).text();
    const oldBranchLog = await (await (await branchLogs.getFileHandle('master')).getFile()).text();
    const oldHeadLog = await (await (await logs.getFileHandle('HEAD')).getFile()).text();
    const oldConfig = await (await (await git.getFileHandle('config')).getFile()).text();
    const lock = await git.getFileHandle('HEAD.lock', { create: true });
    lock.content = textEncoder.encode('other writer\n');

    const rename = await execute({ script: 'git branch -m renamed' });

    expect(rename.result.exitCode).toBe(128);
    expect(rename.stderr.text).toContain('HEAD.lock');
    expect(await (await (await git.getFileHandle('HEAD')).getFile()).text()).toBe('ref: refs/heads/master\n');
    expect(await (await (await heads.getFileHandle('master')).getFile()).text()).toBe(oldObjectId);
    expect(await (await (await branchLogs.getFileHandle('master')).getFile()).text()).toBe(oldBranchLog);
    expect(await (await (await logs.getFileHandle('HEAD')).getFile()).text()).toBe(oldHeadLog);
    expect(await (await (await git.getFileHandle('config')).getFile()).text()).toBe(oldConfig);
    expect(await (await (await git.getFileHandle('HEAD.lock')).getFile()).text()).toBe('other writer\n');
    await expect(heads.getFileHandle('renamed')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(branchLogs.getFileHandle('renamed')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('finishes the branch rename after Stop once the new ref creation was accepted', async () => {
    const setup = await execute({ script: `${initialCommit}\ngit config branch.master.remote origin` });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const heads = await (await git.getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const logs = await git.getDirectoryHandle('logs');
    const branchLogs = await (await logs.getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const oldObjectId = await (await (await heads.getFileHandle('master')).getFile()).text();
    const oldBranchLog = await (await (await branchLogs.getFileHandle('master')).getFile()).text();
    const getRef = heads.getFileHandle.bind(heads);
    const accepted = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        proceed.resolve();
      },
    };
    using _ref = vi.spyOn(heads, 'getFileHandle').mockImplementation(async (name, options) => {
      const file = await getRef(name, options);
      if (name === 'renamed' && options?.create === true) {
        accepted.resolve();
        await proceed.promise;
      }
      return file;
    });
    const controller = new AbortController();
    const renaming = execute({ script: 'git branch -m renamed', signal: controller.signal });
    const reached = await Promise.race([accepted.promise.then(() => true), renaming.then(() => false)]);
    expect(reached).toBe(true);
    controller.abort();
    expect(wesh.vfs.hasPendingFilePublications()).toBe(true);
    expect(await (await (await getRef('master')).getFile()).text()).toBe(oldObjectId);
    proceed.resolve();

    const rename = await renaming;
    expect(rename.result.exitCode).toBe(130);
    expect(await (await (await getRef('renamed')).getFile()).text()).toBe(oldObjectId);
    expect(await (await (await git.getFileHandle('HEAD')).getFile()).text()).toBe('ref: refs/heads/renamed\n');
    const newBranchLog = await (await (await branchLogs.getFileHandle('renamed')).getFile()).text();
    const message = 'Branch: renamed refs/heads/master to refs/heads/renamed';
    expect(newBranchLog.startsWith(oldBranchLog)).toBe(true);
    expect(newBranchLog).toContain(message);
    const headLog = await (await (await logs.getFileHandle('HEAD')).getFile()).text();
    expect(headLog.split('\n').filter(line => line.endsWith(message))).toHaveLength(2);
    const config = await (await (await git.getFileHandle('config')).getFile()).text();
    expect(config).toContain('[branch "renamed"]');
    expect(config).not.toContain('[branch "master"]');
    await expect(getRef('master')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(branchLogs.getFileHandle('master')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(wesh.vfs.hasPendingFilePublications()).toBe(false);
  });

  it('excludes a concurrent commit while preparing to rename the current branch', async () => {
    const setup = await execute({ script: `${initialCommit}\nprintf 'staged' > file\ngit add file` });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const git = await (await rootHandle.getDirectoryHandle('repo')).getDirectoryHandle('.git');
    const heads = await (await git.getDirectoryHandle('refs')).getDirectoryHandle('heads');
    const oldObjectId = await (await (await heads.getFileHandle('master')).getFile()).text();
    const acquire = wesh.vfs.createTemporaryFile.bind(wesh.vfs);
    const preparing = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        proceed.resolve();
      },
    };
    using _lock = vi.spyOn(wesh.vfs, 'createTemporaryFile').mockImplementation(async args => {
      if (args.path === '/repo/.git/refs/heads/renamed.lock') {
        preparing.resolve();
        await proceed.promise;
      }
      return acquire(args);
    });
    const renaming = execute({ script: 'git branch -m renamed' });
    const reached = await Promise.race([preparing.promise.then(() => true), renaming.then(() => false)]);
    expect(reached).toBe(true);
    const commit = await execute({ script: 'git commit -m concurrent' });
    proceed.resolve();

    const rename = await renaming;
    expect(commit.result.exitCode).toBe(128);
    expect(commit.stderr.text).toContain('HEAD.lock');
    expect(rename.result.exitCode, rename.stderr.text).toBe(0);
    expect(await (await (await heads.getFileHandle('renamed')).getFile()).text()).toBe(oldObjectId);
    expect(await (await (await git.getFileHandle('HEAD')).getFile()).text()).toBe('ref: refs/heads/renamed\n');
    await expect(heads.getFileHandle('master')).rejects.toMatchObject({ name: 'NotFoundError' });
    const status = await execute({ script: 'git status --short' });
    expect(status.stdout.text).toBe('A  file\n');
  });

  it('updates existing branch and HEAD reflogs when renaming with core.logallrefupdates=false', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git config core.logallrefupdates false
git branch -m renamed
tail -n 1 .git/logs/refs/heads/renamed
tail -n 2 .git/logs/HEAD`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Branch: renamed refs/heads/master to refs/heads/renamed');
    expect(stdout.text.match(/Branch: renamed refs\/heads\/master to refs\/heads\/renamed/gu)).toHaveLength(3);
  });

  it('renames an unborn current branch without creating a ref or reflog', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git branch -m main
git branch --show-current
cat .git/HEAD
test ! -e .git/refs/heads/main
test ! -e .git/logs/refs/heads/main`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
main
ref: refs/heads/main
`);
  });

  it('keeps a branch that is checked out in another linked worktree', async () => {
    const setup = await execute({
      script: `\
${initialCommit}
git branch topic
mkdir -p .git/worktrees/linked /linked
printf 'gitdir: /repo/.git/worktrees/linked\\n' > /linked/.git
printf '../..\\n' > .git/worktrees/linked/commondir
printf 'ref: refs/heads/topic\\n' > .git/worktrees/linked/HEAD`,
    });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const renamed = await execute({ script: 'git branch -m topic renamed' });
    expect(renamed.result.exitCode).toBe(128);
    expect(renamed.stderr.text).toContain("Cannot rename 'refs/heads/topic' while it is checked out in another worktree");
    const after = await execute({
      script: `\
git -C /linked rev-parse --verify HEAD &&
test ! -e .git/refs/heads/renamed &&
cat .git/refs/heads/topic`,
    });
    expect(after.result.exitCode, after.stderr.text).toBe(0);
    const [head, topic] = after.stdout.text.trimEnd().split('\n');
    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    expect(topic).toBe(head);
  });

  it('renames the current linked branch when its git directory is reached through a symlink', async () => {
    const setup = await execute({
      script: `\
${initialCommit}
git branch topic
mkdir -p .git/worktrees/linked /linked
ln -s /repo/.git /metadata
printf 'gitdir: /metadata/worktrees/linked\\n' > /linked/.git
printf '/repo/.git\\n' > .git/worktrees/linked/commondir
printf 'ref: refs/heads/topic\\n' > .git/worktrees/linked/HEAD`,
    });
    expect(setup.result.exitCode, setup.stderr.text).toBe(0);
    const renamed = await execute({
      script: `\
git -C /linked branch -m renamed &&
git -C /linked branch --show-current &&
git branch --show-current`,
    });
    expect(renamed.result.exitCode, renamed.stderr.text).toBe(0);
    expect(renamed.stdout.text).toBe(`\
renamed
master
`);
  });

  it('supports script-friendly rev-parse worktree and verify options', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'hello\n' > hello.txt
git add hello.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git rev-parse --is-inside-work-tree
git rev-parse --verify HEAD`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    const lines = stdout.text.trimEnd().split('\n');
    expect(lines[0]).toBe('true');
    expect(lines[1]).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('preserves rev-parse streaming order and starts single-revision mode at the option position', async () => {
    const setup = await execute({
      script: `\
git init -q /rev-parse-streaming
cd /rev-parse-streaming
git config user.name Tester
git config user.email tester@example.com
printf base > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git rev-parse HEAD`,
    });
    expect(setup.result.exitCode).toBe(0);
    expect(setup.stderr.text).toBe('');
    const head = setup.stdout.text.trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/u);

    const afterRevisionSpecial = await execute({
      script: 'git -C /rev-parse-streaming rev-parse HEAD --git-dir',
    });
    expect(afterRevisionSpecial.result.exitCode).toBe(0);
    expect(afterRevisionSpecial.stderr.text).toBe('');
    expect(afterRevisionSpecial.stdout.text).toBe(`${head}\n.git\n`);

    const beforeRevisionSpecial = await execute({
      script: 'git -C /rev-parse-streaming rev-parse --git-dir HEAD',
    });
    expect(beforeRevisionSpecial.result.exitCode).toBe(0);
    expect(beforeRevisionSpecial.stderr.text).toBe('');
    expect(beforeRevisionSpecial.stdout.text).toBe(`.git\n${head}\n`);

    const lateShortWithoutRevision = await execute({
      script: 'git -C /rev-parse-streaming rev-parse HEAD --short',
    });
    expect(lateShortWithoutRevision.result.exitCode).toBe(128);
    expect(lateShortWithoutRevision.stdout.text).toBe(`${head}\n`);
    expect(lateShortWithoutRevision.stderr.text).toContain('Needed a single revision');

    const lateShortWithRevision = await execute({
      script: 'git -C /rev-parse-streaming rev-parse HEAD --short HEAD',
    });
    expect(lateShortWithRevision.result.exitCode).toBe(0);
    expect(lateShortWithRevision.stderr.text).toBe('');
    expect(lateShortWithRevision.stdout.text).toBe(`${head}\n${head.slice(0, 7)}\n`);

    const deferredRevision = await execute({
      script: 'git -C /rev-parse-streaming rev-parse --short HEAD --git-dir',
    });
    expect(deferredRevision.result.exitCode).toBe(0);
    expect(deferredRevision.stderr.text).toBe('');
    expect(deferredRevision.stdout.text).toBe(`.git\n${head.slice(0, 7)}\n`);

    const updatedDeferredMode = await execute({
      script: 'git -C /rev-parse-streaming rev-parse --short HEAD --short=12',
    });
    expect(updatedDeferredMode.result.exitCode).toBe(0);
    expect(updatedDeferredMode.stderr.text).toBe('');
    expect(updatedDeferredMode.stdout.text).toBe(`${head.slice(0, 12)}\n`);
  });

  it('preserves rev-parse -- delimiter semantics without treating following paths as revisions', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);

    const plain = await execute({ script: `git rev-parse HEAD -- path --literal` });
    expect(plain.result.exitCode).toBe(0);
    expect(plain.stderr.text).toBe('');
    const plainLines = plain.stdout.text.trimEnd().split('\n');
    expect(plainLines[0]).toMatch(/^[0-9a-f]{40}$/u);
    expect(plainLines.slice(1)).toEqual(['--', 'path', '--literal']);

    const verify = await execute({ script: `git rev-parse --verify HEAD -- ignored` });
    expect(verify.result.exitCode).toBe(0);
    expect(verify.stderr.text).toBe('');
    expect(verify.stdout.text).toMatch(/^[0-9a-f]{40}\n$/u);

    const shortened = await execute({ script: `git rev-parse --short=8 HEAD -- ignored` });
    expect(shortened.result.exitCode).toBe(0);
    expect(shortened.stderr.text).toBe('');
    expect(shortened.stdout.text).toMatch(/^[0-9a-f]{8}\n$/u);
  });

  it('passes unknown rev-parse options through like Git unless single-revision mode is active', async () => {
    const setup = await execute({ script: 'git init -q /rev-parse-options' });
    expect(setup.result.exitCode).toBe(0);

    const passthrough = await execute({ script: 'git -C /rev-parse-options rev-parse --definitely-invalid' });
    expect(passthrough.result.exitCode).toBe(0);
    expect(passthrough.stdout.text).toBe('--definitely-invalid\n');
    expect(passthrough.stderr.text).toBe('');

    const verified = await execute({ script: 'git -C /rev-parse-options rev-parse --verify --definitely-invalid' });
    expect(verified.result.exitCode).toBe(128);
    expect(verified.stdout.text).toBe('');
    expect(verified.stderr.text).toContain('Needed a single revision');
  });

  it('preflights malformed config before rev-parse and reflog semantics', async () => {
    const setup = await execute({
      script: `\
git init -q /plumbing-config-malformed
printf '\n[bad\n' >> /plumbing-config-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    for (const command of ['rev-parse --git-dir', 'reflog', 'rev-parse --definitely-invalid']) {
      const result = await execute({ script: `git -C /plumbing-config-malformed ${command}` });
      expect(result.result.exitCode).toBe(128);
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toContain('bad config line');
    }
  });

  it('allows empty rev-parse but requires a revision for --verify and --short', async () => {
    const setup = await execute({ script: 'git init -q /rev-parse-empty' });
    expect(setup.result.exitCode).toBe(0);

    const empty = await execute({ script: 'git -C /rev-parse-empty rev-parse' });
    expect(empty.result.exitCode).toBe(0);
    expect(empty.stdout.text).toBe('');
    expect(empty.stderr.text).toBe('');

    for (const args of ['--verify', '--verify --', '--short', '--short --']) {
      const rejected = await execute({ script: `git -C /rev-parse-empty rev-parse ${args}` });
      expect(rejected.result.exitCode).toBe(128);
      expect(rejected.stdout.text).toBe('');
      expect(rejected.stderr.text).toContain('Needed a single revision');
    }
  });

  it('requires one revision when --short is active', async () => {
    const setup = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null`,
    });
    expect(setup.result.exitCode).toBe(0);

    const { result, stdout, stderr } = await execute({ script: `git rev-parse --short HEAD HEAD` });
    expect(result.exitCode).not.toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('Needed a single revision');
  });

  it('continues deleting later branches when an earlier safe deletion fails', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch merged
git branch unmerged
git switch unmerged >/dev/null 2>/dev/null
printf topic > topic
git add topic
GIT_AUTHOR_DATE='981259506 +0000' GIT_COMMITTER_DATE='981259506 +0000' git commit -m topic >/dev/null
git switch master >/dev/null 2>/dev/null
git branch -d unmerged merged`,
    });
    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("error: the branch 'unmerged' is not fully merged\n");
    expect(stdout.text).toContain('Deleted branch merged (was ');
    expect(stdout.text).toMatch(/[0-9a-f]{7}/u);

    const listed = await execute({ script: 'git branch --no-color' });
    expect(listed.result.exitCode).toBe(0);
    expect(listed.stderr.text).toBe('');
    expect(listed.stdout.text).toBe(`\
* master
  unmerged
`);
  });

  it('preflights malformed config before read-only branch operations and option errors', async () => {
    const setup = await execute({
      script: `\
git init -q /branch-read-malformed
printf '\n[bad\n' >> /branch-read-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    for (const args of ['--list', '--show-current', '--definitely-invalid']) {
      const result = await execute({ script: `git -C /branch-read-malformed branch ${args}` });
      expect(result.result.exitCode).toBe(128);
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toContain('bad config line');
    }
  });

  it('preflights malformed local config before force-deleting a branch', async () => {
    const setup = await execute({
      script: `\
git init -q /branch-delete-malformed
git -C /branch-delete-malformed config user.name Tester
git -C /branch-delete-malformed config user.email tester@example.com
printf base > /branch-delete-malformed/a
git -C /branch-delete-malformed add a
git -C /branch-delete-malformed commit -m base >/dev/null
git -C /branch-delete-malformed branch topic
printf '\n[bad\n' >> /branch-delete-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    const deletion = await execute({ script: 'git -C /branch-delete-malformed branch -D topic' });
    expect(deletion.result.exitCode).toBe(128);
    expect(deletion.stderr.text).toContain('bad config line');

    const preserved = await execute({ script: 'test -e /branch-delete-malformed/.git/refs/heads/topic' });
    expect(preserved.result.exitCode).toBe(0);
  });

  it('preflights malformed config before deleting a remote-tracking branch', async () => {
    const setup = await execute({
      script: `\
git init -q /remote-branch-delete-malformed
git -C /remote-branch-delete-malformed config user.name Tester
git -C /remote-branch-delete-malformed config user.email tester@example.com
printf base > /remote-branch-delete-malformed/a
git -C /remote-branch-delete-malformed add a
git -C /remote-branch-delete-malformed commit -m base >/dev/null
mkdir -p /remote-branch-delete-malformed/.git/refs/remotes/origin
cp /remote-branch-delete-malformed/.git/refs/heads/master /remote-branch-delete-malformed/.git/refs/remotes/origin/topic
printf '\n[bad\n' >> /remote-branch-delete-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    const deletion = await execute({
      script: 'git -C /remote-branch-delete-malformed branch -r -D origin/topic',
    });
    expect(deletion.result.exitCode).toBe(128);
    expect(deletion.stderr.text).toContain('bad config line');

    const preserved = await execute({
      script: 'test -e /remote-branch-delete-malformed/.git/refs/remotes/origin/topic',
    });
    expect(preserved.result.exitCode).toBe(0);
  });

  it('preflights malformed global config before force-deleting a branch', async () => {
    const setup = await execute({
      script: `\
git init -q /branch-delete-global-malformed
git -C /branch-delete-global-malformed config user.name Tester
git -C /branch-delete-global-malformed config user.email tester@example.com
printf base > /branch-delete-global-malformed/a
git -C /branch-delete-global-malformed add a
git -C /branch-delete-global-malformed commit -m base >/dev/null
git -C /branch-delete-global-malformed branch topic
printf '[bad\n' > /bad-global-config`,
    });
    expect(setup.result.exitCode).toBe(0);

    const deletion = await execute({
      script: 'GIT_CONFIG_GLOBAL=/bad-global-config git -C /branch-delete-global-malformed branch -D topic',
    });
    expect(deletion.result.exitCode).toBe(128);
    expect(deletion.stderr.text).toContain('bad config line');

    const preserved = await execute({ script: 'test -e /branch-delete-global-malformed/.git/refs/heads/topic' });
    expect(preserved.result.exitCode).toBe(0);
  });

  it('preflights malformed config before renaming an unborn current branch', async () => {
    const setup = await execute({
      script: `\
git init -q /unborn-rename-malformed
printf '\n[bad\n' >> /unborn-rename-malformed/.git/config`,
    });
    expect(setup.result.exitCode).toBe(0);

    const rename = await execute({ script: 'git -C /unborn-rename-malformed branch -m main' });
    expect(rename.result.exitCode).toBe(128);
    expect(rename.stderr.text).toContain('bad config line');

    const head = await execute({ script: 'cat /unborn-rename-malformed/.git/HEAD' });
    expect(head.result.exitCode).toBe(0);
    expect(head.stdout.text).toBe('ref: refs/heads/master\n');
  });

  it('removes local branch config when deleting the branch', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf base > a
git add a
git commit -m base >/dev/null
git branch topic
git config branch.topic.remote origin
git config branch.topic.merge refs/heads/topic
git config branch.topic.description keep-me
git branch -D topic
git config --list`,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Deleted branch topic (was ');
    expect(stdout.text).not.toContain('branch.topic.');
  });

  it('uses an existing upstream ref as the safe-delete merge base', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git checkout -b topic >/dev/null 2>/dev/null
printf 'topic\n' >> tracked.txt
git commit -am topic >/dev/null
git checkout master >/dev/null 2>/dev/null
git merge --ff-only topic >/dev/null
mkdir -p .git/refs/remotes/origin
git rev-parse HEAD~1 > .git/refs/remotes/origin/topic
git config branch.topic.remote origin
git config branch.topic.merge refs/heads/topic
git branch -d topic
git branch --list topic`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain("warning: not deleting branch 'topic' that is not yet merged to\n");
    expect(stderr.text).toContain("'refs/remotes/origin/topic', even though it is merged to HEAD\n");
    expect(stderr.text).toContain("error: the branch 'topic' is not fully merged\n");
    expect(stdout.text).toBe('  topic\n');
  });

  it('allows safe deletion when the upstream contains the branch even if HEAD does not', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'base\n' > tracked.txt
git add tracked.txt
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git checkout -b topic >/dev/null 2>/dev/null
printf 'topic\n' >> tracked.txt
git commit -am topic >/dev/null
mkdir -p .git/refs/remotes/origin
cat .git/refs/heads/topic > .git/refs/remotes/origin/topic
git config branch.topic.remote origin
git config branch.topic.merge refs/heads/topic
git checkout master >/dev/null 2>/dev/null
git branch -d topic
git branch --list topic`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toContain("warning: deleting branch 'topic' that has been merged to\n");
    expect(stderr.text).toContain("'refs/remotes/origin/topic', but not yet merged to HEAD\n");
    expect(stdout.text).toMatch(/Deleted branch topic \(was [0-9a-f]{7}\)\.\n$/u);
  });

  it('filters local and remote branch listings with Git wildcard patterns', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q source
cd source
git config user.name Tester
git config user.email tester@example.com
printf 'base\\n' > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch feat/a
git branch feat/x/y
git branch bug/x
cd ..
git clone -q source repo 2>/dev/null
cd repo
git branch feat/a
git branch feat/x/y
git branch bug/x
printf '%s\\n' LOCAL
git branch --list 'feat*'
printf '%s\\n' REMOTE
git branch -r --list 'origin/feat*'
printf '%s\\n' ALL
git branch -a --list '*bug*'
printf '%s\\n' NOMATCH
git branch --list 'none*'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
LOCAL
  feat/a
  feat/x/y
REMOTE
  origin/feat/a
  origin/feat/x/y
ALL
  bug/x
  remotes/origin/bug/x
NOMATCH
`);
  });

  it('supports POSIX character classes in branch list patterns', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf x > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch feat1
git branch feata
git branch feat-
git branch feat_
git branch --list 'feat[[:digit:]]'
printf '%s\n' ---
git branch --list 'feat[![:digit:]]'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
  feat1
---
  feat-
  feat_
  feata
`);
  });

  it('matches branch wildcards in the Git UTF-8 byte domain', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf x > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m base >/dev/null
git branch café
git branch cafあ
printf '%s\n' ONE
git branch --list 'caf?'
printf '%s\n' TWO
git branch --list 'caf??'
printf '%s\n' THREE
git branch --list 'caf???'`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
ONE
TWO
  café
THREE
  cafあ
`);
  });

  it('renders canonical long status sections for staged, unstaged, and untracked changes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'tracked\n' > tracked.txt
printf 'delete\n' > delete.txt
git add .
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
printf 'changed\n' > tracked.txt
rm delete.txt
printf 'new\n' > untracked.txt
printf 'staged\n' > staged.txt
git add staged.txt
git status`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
On branch master

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
\tnew file:   staged.txt

Changes not staged for commit:
  (use "git add/rm <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
\tdeleted:    delete.txt
\tmodified:   tracked.txt

Untracked files:
  (use "git add <file>..." to include in what will be committed)
\tuntracked.txt

`);
  });

  it('renders canonical clean and initial long status summaries', async () => {
    const initial = await execute({ script: `git init -q repo\ncd repo\ngit status` });
    expect(initial.result.exitCode).toBe(0);
    expect(initial.stderr.text).toBe('');
    expect(initial.stdout.text).toBe(`\
On branch master

No commits yet

nothing to commit (create/copy files and use "git add" to track)
`);

    const clean = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf x > a
git add a
GIT_AUTHOR_DATE='981173106 +0000' GIT_COMMITTER_DATE='981173106 +0000' git commit -m initial >/dev/null
git status`,
    });
    expect(clean.result.exitCode).toBe(0);
    expect(clean.stderr.text).toBe('');
    expect(clean.stdout.text).toBe(`\
On branch master
nothing to commit, working tree clean
`);
  });

  it('orders porcelain paths by UTF-8 bytes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'bmp\n' > '.txt'
printf 'supplementary\n' > '𐀀.txt'
git status --porcelain=v1`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
?? "\\356\\200\\200.txt"
?? "\\360\\220\\200\\200.txt"
`);
  });

  it('quotes porcelain paths like Git while preserving raw -z output', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf 'space\n' > 'space name.txt'
printf 'unicode\n' > '日本語.txt'
git status --porcelain=v1
git status --porcelain=v2
git status --porcelain=v1 -z
git config core.quotePath false
git status --porcelain=v2`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
?? "space name.txt"
?? "\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
? space name.txt
? "\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"
?? space name.txt\0?? 日本語.txt\0? space name.txt
? 日本語.txt
`);
  });

  it('orders Unicode branch names by Git UTF-8 bytes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf x > a
git add a
git commit -m base >/dev/null
git branch '\u{10000}'
git branch '\uE000'
git branch --list --no-color`,
    });

    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toBe(`\
* master
  \uE000
  \u{10000}
`);
  });

  it('refuses unsupported repository object formats before mutating the index', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
git init -q repo
cd repo
printf '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n' > .git/config
printf 'x\n' > x
git add x
test ! -e .git/index`,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe("fatal: unsupported repository object format 'sha256'\n");
  });

  it('refuses unsupported repository ref storage and unknown version-1 extensions', async () => {
    const reftable = await execute({
      script: `\
git init -q repo
cd repo
printf '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\trefstorage = reftable\n' > .git/config
git rev-parse --git-dir`,
    });
    expect(reftable.result.exitCode).toBe(128);
    expect(reftable.stdout.text).toBe('');
    expect(reftable.stderr.text).toBe("fatal: unsupported repository ref storage 'reftable'\n");

    const unknown = await execute({
      script: `\
git init -q repo
cd repo
printf '[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tfrobnicate = true\n' > .git/config
git rev-parse --git-dir`,
    });
    expect(unknown.result.exitCode).toBe(128);
    expect(unknown.stdout.text).toBe('');
    expect(unknown.stderr.text).toBe("fatal: unsupported repository extension 'frobnicate'\n");
  });

  it('rejects future repository versions but ignores extensions for format version zero', async () => {
    const future = await execute({
      script: `\
git init -q repo
cd repo
printf '[core]\n\trepositoryformatversion = 2\n\tbare = false\n' > .git/config
git rev-parse --git-dir`,
    });
    expect(future.result.exitCode).toBe(128);
    expect(future.stdout.text).toBe('');
    expect(future.stderr.text).toBe('fatal: Expected git repo version <= 1, found 2\n');

    const versionZero = await execute({
      script: `\
git init -q repo
cd repo
printf '\n[extensions]\n\tfrobnicate = true\n' >> .git/config
git rev-parse --git-dir`,
    });
    expect(versionZero.result.exitCode).toBe(0);
    expect(versionZero.stderr.text).toBe('');
    expect(versionZero.stdout.text).toBe('.git\n');
  });

  it('refuses replacement refs, alternates, and shallow repositories before normal command execution', async () => {
    const replacement = await execute({
      script: `\
git init -q repo
cd repo
mkdir -p .git/refs/replace
printf '0000000000000000000000000000000000000000\n' > .git/refs/replace/1111111111111111111111111111111111111111
git status --short`,
    });
    expect(replacement.result.exitCode).toBe(128);
    expect(replacement.stdout.text).toBe('');
    expect(replacement.stderr.text).toBe('fatal: replacement refs are not supported yet\n');

    const alternates = await execute({
      script: `\
git init -q repo
cd repo
printf '/other/objects\n' > .git/objects/info/alternates
git status --short`,
    });
    expect(alternates.result.exitCode).toBe(128);
    expect(alternates.stdout.text).toBe('');
    expect(alternates.stderr.text).toBe('fatal: alternate object databases are not supported yet\n');

    const shallow = await execute({
      script: `\
git init -q repo
cd repo
printf '1111111111111111111111111111111111111111\n' > .git/shallow
git status --short`,
    });
    expect(shallow.result.exitCode).toBe(128);
    expect(shallow.stdout.text).toBe('');
    expect(shallow.stderr.text).toBe('fatal: shallow repositories are not supported yet\n');
  });

  it('rejects Git-invalid ref names before creating branch refs', async () => {
    for (const invalidName of ['foo.lock', 'foo bar', 'foo@{bar', '.hidden', 'trailing.']) {
      const { result, stdout, stderr } = await execute({
        script: `\
git init -q repo
cd repo
git config user.name Tester
git config user.email tester@example.com
printf 'x\n' > x
git add x
git commit -m base >/dev/null
git branch '${invalidName}'`,
      });
      expect(result.exitCode).toBe(128);
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe(`fatal: invalid ref name: refs/heads/${invalidName}\n`);
    }
  });
});
