// !!! ALLOW-EXTERNAL-COMMAND git:* !!! -- Create and inspect isolated Git/submodule fixtures without network access.
// !!! ALLOW-EXTERNAL-COMMAND bash:* !!! -- Exercise the audited fingerprint recipe and its failure/isolation cases.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {it} from 'node:test';
import {runCommandSync} from '../../build/command.ts';
import {READ_ENV_PATH, READ_ENV_HOME, READ_ENV_TMPDIR} from '../../build/node-env.ts';

const script = fileURLToPath(new URL('../treefingerprint.sh', import.meta.url));

function sha256({bytes}) {
  return createHash('sha256').update(bytes).digest('hex');
}

function harness({t}) {
  const base = mkdtempSync(path.join(tmpdir(), 'treefingerprint-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  const env = {
    PATH: READ_ENV_PATH(), HOME: READ_ENV_HOME(), TMPDIR: READ_ENV_TMPDIR(),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_ALLOW_PROTOCOL: 'file',
  };
  const options = ({cwd}) => ({cwd: cwd ?? repo, env, stdio: ['ignore', 'pipe', 'pipe']});
  const completed = ({result}) => {
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  };
  const git = ({args, cwd}) => {
    const result = completed({result: runCommandSync({argv: ['git', ...args], options: options({cwd})})});
    assert.equal(result.status, 0, result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const bash = ({args, cwd}) => completed({result: runCommandSync({
    argv: ['bash', ...args], options: options({cwd}),
  })});
  const fingerprint = ({cwd, invocation}) => bash({
    args: invocation === 'conditional'
      ? ['-c', 'if source "$1"; then exit 0; else exit $?; fi', 'test', script]
      : [script],
    cwd,
  });
  const digest = ({cwd}) => {
    const result = fingerprint({cwd, invocation: 'standalone'});
    assert.equal(result.status, 0, result.stderr.toString());
    assert.match(result.stdout.toString(), /^[0-9a-f]{64}\n$/);
    return result.stdout.toString().trim();
  };
  const mustFail = ({cwd}) => {
    for (const invocation of ['standalone', 'conditional']) {
      const result = fingerprint({cwd, invocation});
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.toString(), '', 'A failed input must never produce a plausible digest');
    }
  };
  const commit = () => {
    git({args: ['add', '-A']});
    git({args: ['commit', '-qm', 'update']});
  };
  git({args: ['init', '-q']});
  git({args: ['commit', '--allow-empty', '-qm', 'initial']});
  return {base, repo, bash, git, fingerprint, digest, mustFail, commit};
}

it('matches the independent empty-tree and file/mode/symlink known-answer vectors', t => {
  const h = harness({t});
  assert.equal(h.digest({}), sha256({bytes: Buffer.alloc(0)}));
  const files = [
    {mode: '100644', name: 'a', bytes: Buffer.from([104, 101, 108, 108, 111, 0, 255, 10])},
    {mode: '100755', name: 'b', bytes: Buffer.from('exec\n')},
    {mode: '120000', name: 'c', bytes: Buffer.from('a\n')},
  ];
  writeFileSync(path.join(h.repo, 'a'), files[0].bytes);
  writeFileSync(path.join(h.repo, 'b'), files[1].bytes);
  chmodSync(path.join(h.repo, 'b'), 0o755);
  symlinkSync('a\n', path.join(h.repo, 'c'));
  h.commit();
  const records = files.map(({mode, name, bytes}) => Buffer.from(`${mode}\0${name}\0${sha256({bytes})}\0`));
  assert.equal(h.digest({}), sha256({bytes: Buffer.concat(records)}));
});

it('handles raw pathnames and reproduces across clones and commits with the same tree', t => {
  const h = harness({t});
  const names = [' space', '-dash', 'tab\tfile', 'new\nline', 'quotes\'"', '日本語', 'a.b', 'a/leaf'];
  for (const name of names) {
    const target = path.join(h.repo, name);
    mkdirSync(path.dirname(target), {recursive: true});
    writeFileSync(target, name);
  }
  const rawPath = Buffer.concat([Buffer.from(`${h.repo}/`), Buffer.from([255, 254])]);
  writeFileSync(rawPath, 'non-UTF-8 name');
  symlinkSync('new\nline', path.join(h.repo, 'symlink'));
  h.commit();
  const original = h.digest({});
  h.git({args: ['commit', '--allow-empty', '-qm', 'different commit, same tree']});
  assert.equal(h.digest({}), original);
  const clone = path.join(h.base, 'clone');
  h.git({args: ['clone', '-q', '--no-hardlinks', h.repo, clone]});
  assert.equal(h.digest({cwd: clone}), original);
  const conditional = h.fingerprint({invocation: 'conditional'});
  assert.equal(conditional.status, 0);
  assert.equal(conditional.stdout.toString(), `${original}\n`);
});

it('changes when committed content, path, executable mode, or symlink target changes', t => {
  const h = harness({t});
  const file = path.join(h.repo, 'file');
  writeFileSync(file, 'first');
  h.commit();
  let previous = h.digest({});
  for (const mutate of [
    () => writeFileSync(file, 'second'),
    () => chmodSync(file, 0o755),
    () => renameSync(file, path.join(h.repo, 'renamed')),
    () => symlinkSync('renamed', path.join(h.repo, 'link')),
    () => {
      unlinkSync(path.join(h.repo, 'link'));
      symlinkSync('./renamed', path.join(h.repo, 'link'));
    },
  ]) {
    mutate();
    h.commit();
    const current = h.digest({});
    assert.notEqual(current, previous);
    previous = current;
  }
});

it('uses committed bytes independently of the index, worktree, untracked files, and checkout conversion', t => {
  const h = harness({t});
  writeFileSync(path.join(h.repo, 'file'), 'committed\n');
  h.commit();
  const original = h.digest({});
  writeFileSync(path.join(h.repo, 'file'), 'worktree\r\n');
  writeFileSync(path.join(h.repo, 'untracked'), 'not committed');
  h.git({args: ['add', 'file']});
  h.git({args: ['config', 'core.autocrlf', 'true']});
  const status = h.git({args: ['status', '--porcelain=v1']});
  assert.equal(h.digest({}), original);
  assert.equal(h.git({args: ['status', '--porcelain=v1']}), status, 'Fingerprinting must not mutate the checkout');
});

it('ignores Git replacement refs when reading source blobs', t => {
  const h = harness({t});
  writeFileSync(path.join(h.repo, 'file'), 'original');
  h.commit();
  const original = h.digest({});
  const blob = h.git({args: ['rev-parse', 'HEAD:file']});
  const replacementFile = path.join(h.base, 'replacement');
  writeFileSync(replacementFile, 'replacement');
  const replacement = h.git({args: ['hash-object', '-w', '--', replacementFile]});
  h.git({args: ['replace', blob, replacement]});
  assert.equal(h.digest({}), original);
});

it('rejects a subdirectory or a directory without a repository without printing a digest', t => {
  const h = harness({t});
  const inner = path.join(h.repo, 'inner');
  const elsewhere = path.join(h.base, 'elsewhere');
  mkdirSync(inner);
  mkdirSync(elsewhere);
  h.mustFail({cwd: inner});
  h.mustFail({cwd: elsewhere});
});

it('does not print a digest on missing blob or tree errors, even when sourced from a conditional', t => {
  for (const object of ['HEAD:file', 'HEAD^{tree}']) {
    const h = harness({t});
    writeFileSync(path.join(h.repo, 'file'), 'unique nonempty tree');
    h.commit();
    const oid = h.git({args: ['rev-parse', object]});
    unlinkSync(path.join(h.repo, '.git/objects', oid.slice(0, 2), oid.slice(2)));
    h.mustFail({});
  }
});

function addSubmodule({h}) {
  const original = path.join(h.base, 'child');
  mkdirSync(original);
  h.git({args: ['init', '-q'], cwd: original});
  writeFileSync(path.join(original, 'source'), 'child source');
  h.git({args: ['add', '.'], cwd: original});
  h.git({args: ['commit', '-qm', 'child initial'], cwd: original});
  h.git({args: ['submodule', 'add', '-q', original, 'vendor/child']});
  h.commit();
  return path.join(h.repo, 'vendor/child');
}

it('recursively binds submodule contents and rejects a checkout different from its recorded Git link', t => {
  const h = harness({t});
  const child = addSubmodule({h});
  const grandchild = path.join(h.base, 'grandchild');
  mkdirSync(grandchild);
  h.git({args: ['init', '-q'], cwd: grandchild});
  writeFileSync(path.join(grandchild, 'file'), 'grandchild');
  h.git({args: ['add', '.'], cwd: grandchild});
  h.git({args: ['commit', '-qm', 'grandchild'], cwd: grandchild});
  h.git({args: ['submodule', 'add', '-q', grandchild, 'nested'], cwd: child});
  h.git({args: ['commit', '-qam', 'nested module'], cwd: child});
  h.commit();
  const expected = h.digest({});
  const clone = path.join(h.base, 'clone');
  h.git({args: ['clone', '-q', '--no-hardlinks', h.repo, clone]});
  h.git({args: ['config', 'submodule.vendor/child.url', child], cwd: clone});
  h.git({args: ['submodule', 'update', '--init', '--recursive'], cwd: clone});
  assert.equal(h.digest({cwd: clone}), expected);
  const nested = path.join(child, 'nested');
  writeFileSync(path.join(nested, 'file'), 'changed grandchild');
  h.git({args: ['add', '.'], cwd: nested});
  h.git({args: ['commit', '-qm', 'nested change'], cwd: nested});
  h.mustFail({});
  h.git({args: ['add', '.'], cwd: child});
  h.git({args: ['commit', '-qm', 'nested Git link'], cwd: child});
  h.mustFail({});
  h.commit();
  assert.notEqual(h.digest({}), expected);
});

it('rejects missing nested blobs and uninitialized submodules without printing a digest', t => {
  const h = harness({t});
  const child = addSubmodule({h});
  const blob = h.git({args: ['rev-parse', 'HEAD:source'], cwd: child});
  const gitDir = h.git({args: ['rev-parse', '--absolute-git-dir'], cwd: child});
  unlinkSync(path.join(gitDir, 'objects', blob.slice(0, 2), blob.slice(2)));
  h.mustFail({});
  rmSync(child, {recursive: true});
  mkdirSync(child);
  h.mustFail({});
});

it('isolates working directory, options, variables, and function definitions from its caller', t => {
  const h = harness({t});
  const result = h.bash({args: ['-c', `\
before_pwd=$PWD
before_flags=$-
before_locale=\${LC_ALL-unset}
before_lazy=\${GIT_NO_LAZY_FETCH-unset}
source "$1" >/dev/null || exit
test "$PWD" = "$before_pwd" || exit
test "$-" = "$before_flags" || exit
test "\${LC_ALL-unset}" = "$before_locale" || exit
test "\${GIT_NO_LAZY_FETCH-unset}" = "$before_lazy" || exit
! declare -F fingerprint >/dev/null
`, 'test', script]});
  assert.equal(result.status, 0, result.stderr.toString());
});

it('rejects readonly caller controls and function conflicts even when sourced from a conditional', t => {
  const h = harness({t});
  for (const setup of [
    'readonly GIT_NO_REPLACE_OBJECTS=0',
    'fingerprint() { printf "%064d\\n" 0; }; readonly -f fingerprint',
  ]) {
    const result = h.bash({args: ['-c', `${setup}; if source "$1"; then exit 0; else exit $?; fi`, 'test', script]});
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.toString(), '');
  }
});
