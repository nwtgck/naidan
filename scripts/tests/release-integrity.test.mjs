// !!! ALLOW-EXTERNAL-COMMAND git:* !!! -- Create and inspect temporary source fixtures for release evidence.
// !!! ALLOW-EXTERNAL-COMMAND bash -c:* !!! -- Execute the published artifact-verification recipe against fixture files.
// !!! ALLOW-EXTERNAL-COMMAND node:* !!! -- Run the offline release integrity CLI against recorded API responses.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {it} from 'node:test';
import {runCommandSync} from '../../build/command.ts';
import {READ_ENV_PATH, READ_ENV_HOME, READ_ENV_TMPDIR} from '../../build/node-env.ts';
import {captureSource, collectBuildInputs, fingerprintScheme, hashFile, integrityName, releaseAssets,
  renderIntegrity, sealBuild, verifyBuild} from '../release-integrity.mjs';

const require = createRequire(import.meta.url);
const workflow = await readFile(new URL('../../.github/workflows/sync-release-notes.yml', import.meta.url), 'utf8');
const integrityScript = fileURLToPath(new URL('../release-integrity.mjs', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = () => ({repository: 'https://github.com/nwtgck/naidan', commit: 'a'.repeat(40),
  run_id: '1234', build_attempt: '1', tree_fingerprint: {algorithm: 'sha256', scheme: fingerprintScheme, value: 'b'.repeat(64)}});

function commandOptions({cwd}) {
  return {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: READ_ENV_PATH(), HOME: READ_ENV_HOME(), TMPDIR: READ_ENV_TMPDIR(),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  }};
}

function completed({result}) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

async function fixture({t}) {
  const root = await mkdtemp(path.join(tmpdir(), 'naidan-integrity-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'dist/hosted/sub'), {recursive: true});
  for (const [name, bytes] of [
    ['hosted/index.html', '<html>build</html>'], ['hosted/sub/module.js', 'export const x = 1;'],
    ['naidan-hosted.zip', 'hosted ZIP'], ['naidan-standalone.zip', 'universal ZIP'], ['naidan-standalone-ja.zip', 'Japanese ZIP'],
  ]) {
    await writeFile(path.join(root, 'dist', name), bytes);
  }
  const receipt = await sealBuild({root, source: source()});
  const prepare = async () => {
    for (const entry of receipt.files.filter(entry => entry.path.endsWith('.zip'))) {
      await rename(path.join(root, 'dist', entry.path), path.join(root, 'dist', `${entry.path.slice(0, -4)}-v1.2.3.zip`));
    }
    await mkdir(path.join(root, 'dist/goreleaser-dist'));
    const go = [
      {name: 'naidan-server-v1.2.3-Linux-x86_64.tar.gz', type: 'Archive'},
      {name: 'naidan-server-v1.2.3-linux-amd64.deb', type: 'Linux Package'},
      {name: 'checksums.txt', type: 'Checksum'},
    ].map(entry => ({...entry, path: `dist/goreleaser-dist/${entry.name}`}));
    for (const entry of go) {
      await writeFile(path.join(root, entry.path), `built ${entry.name}`);
    }
    // GoReleaser's extra fields and local-only binary are not the published bytes.
    await writeFile(path.join(root, 'dist/goreleaser-dist/artifacts.json'), JSON.stringify([
      ...go.map(entry => ({...entry, extra: {Checksum: 'untrusted-metadata'}, internal_type: 0})),
      {name: 'server', path: 'dist/goreleaser-dist/linux-amd64/server', type: 'Binary'},
    ]));
    return go;
  };
  return {root, receipt, prepare};
}

it('captures the actual committed source and refuses a different commit or dirty tracked source', async t => {
  const {root} = await fixture({t});
  const git = ({args}) => {
    const result = completed({result: runCommandSync({argv: ['git', ...args], options: commandOptions({cwd: root})})});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git({args: ['init', '-q']});
  await writeFile(path.join(root, 'source.txt'), 'committed source');
  git({args: ['add', 'source.txt']});
  git({args: ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '-qm', 'source']});
  const commit = git({args: ['rev-parse', 'HEAD']});
  const options = {root, repository: 'nwtgck/naidan', commit, runId: '1234', buildAttempt: '1'};
  const captured = await captureSource(options);
  assert.equal(captured.commit, commit);
  assert.match(captured.tree_fingerprint.value, /^[0-9a-f]{64}$/);
  await assert.rejects(captureSource({...options, commit: '0'.repeat(40)}), /Checkout/);
  await writeFile(path.join(root, 'source.txt'), 'changed');
  await assert.rejects(captureSource(options), /Tracked source/);
});

it('binds hosted files and all ZIPs, allowing a later attempt within the same run', async t => {
  const {root, receipt} = await fixture({t});
  await verifyBuild({root, receipt, source: {...source(), build_attempt: '2'}});
  assert.deepEqual(receipt.files.map(entry => entry.path), [
    'hosted/index.html', 'hosted/sub/module.js', 'naidan-hosted.zip', 'naidan-standalone-ja.zip', 'naidan-standalone.zip',
  ]);
  for (const change of [{run_id: '999'}, {commit: 'c'.repeat(40)}, {repository: 'https://github.com/other/repo'},
    {tree_fingerprint: {...source().tree_fingerprint, value: 'c'.repeat(64)}}]) {
    await assert.rejects(verifyBuild({root, receipt, source: {...source(), ...change}}), /another run/);
  }
});

it('rejects altered, missing, extra and symlinked distribution inputs', async t => {
  const attacks = [
    async ({root}) => writeFile(path.join(root, 'dist/hosted/index.html'), '<html>evil!</html>'),
    async ({root}) => rm(path.join(root, 'dist/hosted/sub/module.js')),
    async ({root}) => writeFile(path.join(root, 'dist/hosted/extra.js'), 'extra'),
    async ({root}) => writeFile(path.join(root, 'dist/naidan-standalone-fr.zip'), 'extra ZIP'),
    async ({root}) => writeFile(path.join(root, 'dist/unrelated.zip'), 'extra ZIP'),
    async ({root}) => {
      await rm(path.join(root, 'dist/hosted/index.html'));
      await symlink('../naidan-hosted.zip', path.join(root, 'dist/hosted/index.html'));
    },
  ];
  for (const attack of attacks) {
    const {root, receipt} = await fixture({t});
    await attack({root});
    await assert.rejects(verifyBuild({root, receipt, source: source()}));
  }
});

it('rejects unsafe/duplicate receipt paths and non-regular input directories', async t => {
  const {root, receipt} = await fixture({t});
  for (const candidate of [
    {...receipt, files: [...receipt.files, receipt.files[0]]},
    {...receipt, files: [{...receipt.files[0], path: 'hosted/../../secret'}]},
    {...receipt, files: [{...receipt.files[0], size: -1}]},
  ]) {
    await assert.rejects(verifyBuild({root, receipt: candidate, source: source()}));
  }
  await rename(path.join(root, 'dist/hosted'), path.join(root, 'saved-hosted'));
  await symlink('../saved-hosted', path.join(root, 'dist/hosted'));
  await assert.rejects(collectBuildInputs({root}), /real directory/);
});

it('derives public GoReleaser assets from rehashed files, rejecting escapes and duplicate names', async t => {
  const {root, receipt, prepare} = await fixture({t});
  const go = await prepare();
  const assets = await releaseAssets({root, receipt, tag: 'v1.2.3'});
  assert.equal(assets.length, 6);
  assert.equal(assets.find(entry => entry.name === 'checksums.txt').sha256,
    (await hashFile({file: path.join(root, 'dist/goreleaser-dist/checksums.txt')})).sha256);
  const save = async ({entries}) => writeFile(path.join(root, 'dist/goreleaser-dist/artifacts.json'), JSON.stringify(entries));
  for (const entries of [
    [...go, {...go[0]}], [go[0], go[1]],
    [...go, {name: 'secret', type: 'Archive', path: '../../secret'}],
    [...go, {name: 'surprise', type: 'SBOM', path: 'dist/goreleaser-dist/surprise'}],
  ]) {
    await save({entries});
    await assert.rejects(releaseAssets({root, receipt, tag: 'v1.2.3'}));
  }
  await save({entries: go});
  await writeFile(path.join(root, 'dist/naidan-hosted-v1.2.3.zip'), 'replaced');
  await assert.rejects(releaseAssets({root, receipt, tag: 'v1.2.3'}), /Release ZIP differs/);
});

it('embeds the exact fingerprint script and runnable artifact checks, without self-hashing', async t => {
  const {root, receipt, prepare} = await fixture({t});
  await prepare();
  const assets = await releaseAssets({root, receipt, tag: 'v1.2.3'});
  const yaml = await renderIntegrity({receipt, tag: 'v1.2.3', assets});
  const script = await readFile(new URL('../treefingerprint.sh', import.meta.url), 'utf8');
  assert.ok(yaml.includes(script.trimEnd().split('\n').map(line => `      ${line}`).join('\n')));
  assert.match(yaml, /--signer-workflow nwtgck\/naidan\/\.github\/workflows\/sync-release-notes\.yml/);
  assert.match(yaml, /--source-ref refs\/tags\/v1\.2\.3/);
  assert.ok(!assets.some(entry => entry.name === integrityName));
  const proofDirectory = path.join(root, 'proof');
  await mkdir(proofDirectory);
  for (const asset of assets) {
    const input = asset.name.startsWith('naidan-hosted-') || asset.name.startsWith('naidan-standalone-')
      ? path.join(root, 'dist', asset.name) : path.join(root, 'dist/goreleaser-dist', asset.name);
    await writeFile(path.join(proofDirectory, asset.name), await readFile(input));
  }
  // Execute the published literal block, rather than a separate verifier implementation.
  const artifactScript = yaml.split('  artifacts: |\n')[1].split('\n').filter(line => line.startsWith('    '))
    .map(line => line.slice(4)).join('\n');
  const verifyArtifacts = () => completed({result: runCommandSync({
    argv: ['bash', '-c', artifactScript], options: commandOptions({cwd: proofDirectory}),
  })});
  const verified = verifyArtifacts();
  assert.equal(verified.status, 0, verified.stderr);
  await writeFile(path.join(proofDirectory, assets[0].name), 'tampered');
  assert.notEqual(verifyArtifacts().status, 0);
});

function inlineScript({stepId}) {
  const lines = workflow.split('\n');
  const step = lines.findIndex(line => line.trim() === `id: ${stepId}`);
  assert.ok(step >= 0);
  const marker = lines.findIndex((line, index) => index > step && line.trim() === 'script: |');
  const indent = lines[marker].match(/^ */)[0].length + 2;
  const body = [];
  for (const line of lines.slice(marker + 1)) {
    if (line.trim() && line.match(/^ */)[0].length < indent) {
      break;
    }
    body.push(line.slice(indent));
  }
  assert.ok(!body.join('\n').includes('${{'));
  return new AsyncFunction('github', 'context', 'core', 'require', 'process', body.join('\n'));
}

async function publicationHarness({t}) {
  const {root, receipt, prepare} = await fixture({t});
  await prepare();
  const assets = await releaseAssets({root, receipt, tag: 'v1.2.3'});
  const directory = path.join(root, 'notes/integrity');
  await mkdir(directory, {recursive: true});
  const yaml = await renderIntegrity({receipt, tag: 'v1.2.3', assets});
  const receiptFile = path.join(root, 'dist/naidan-build-receipt.json');
  await writeFile(receiptFile, JSON.stringify(receipt));
  const remote = assets.map((entry, index) => ({id: index + 1, name: entry.name, size: entry.size,
    digest: `sha256:${entry.sha256}`, state: 'uploaded'}));
  const release = {id: 42, tag_name: 'v1.2.3', draft: false, prerelease: false};
  const writes = [], outputs = {};
  const tag = 'v1.2.3';
  const github = {rest: {repos: {
    getReleaseByTag: async params => {
      assert.deepEqual(params, {owner: 'nwtgck', repo: 'naidan', tag});
      return {data: release};
    },
    listReleaseAssets: () => {
      throw new Error('Pagination required');
    },
    uploadReleaseAsset: async payload => {
      writes.push(payload);
      assert.equal(payload.name, integrityName);
      assert.equal(payload.release_id, 42);
      assert.equal(payload.data.toString(), yaml);
      const file = path.join(directory, 'uploaded');
      await writeFile(file, payload.data);
      const hash = await hashFile({file});
      const asset = {id: 100, name: payload.name, size: hash.size, digest: `sha256:${hash.sha256}`, state: 'uploaded'};
      remote.push(asset);
      return {data: asset};
    },
  }}, paginate: async (method, params) => {
    assert.equal(method, github.rest.repos.listReleaseAssets);
    assert.equal(params.per_page, 100);
    assert.equal(params.release_id, 42);
    return remote.map(entry => ({...entry}));
  }};
  const context = {repo: {owner: 'nwtgck', repo: 'naidan'}};
  const core = {setOutput: (name, value) => {
    outputs[name] = value;
  }, info: () => {}};
  const env = {PUBLISH_TAG: 'v1.2.3', NOTES_DIR: path.join(root, 'notes'), RELEASE_ID: '42'};
  const online = ({stepId}) => inlineScript({stepId})(github, context, core, require, {env});
  const guard = () => online({stepId: 'guard_publication'});
  const upload = () => online({stepId: 'publish_integrity'});
  const prepareIntegrity = async () => {
    await online({stepId: 'read_publication'});
    const result = completed({result: runCommandSync({
      argv: ['node', integrityScript, 'prepare', receiptFile, directory, tag, '42'],
      options: commandOptions({cwd: root}),
    })});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return {directory, remote, release, writes, outputs, guard, upload, prepareIntegrity};
}

it('guards signed releases before uploading and accepts only a complete matching remote inventory', async t => {
  const h = await publicationHarness({t});
  await h.guard();
  assert.equal(h.outputs['release-id'], '42');
  h.remote.push({name: integrityName});
  await assert.rejects(h.guard(), /already has signed/);
  assert.deepEqual(h.writes, []);
  await assert.rejects(h.prepareIntegrity(), /Asset/);
});

it('rejects substituted, incomplete, unexpected, duplicate or unhashable remote assets before signing', async t => {
  const attacks = [
    h => {
      h.remote[0].digest = `sha256:${'0'.repeat(64)}`;
    },
    h => {
      h.remote[0].digest = null;
    }, h => {
      h.remote[0].state = 'starter';
    },
    h => {
      h.remote[0].size += 1;
    }, h => {
      h.remote.pop();
    },
    h => {
      h.remote[1].name = h.remote[0].name;
    }, h => {
      h.remote.push({...h.remote[0], name: 'injected.zip'});
    },
    h => {
      h.release.id = 43;
    },
  ];
  for (const attack of attacks) {
    const h = await publicationHarness({t});
    attack(h);
    await assert.rejects(h.prepareIntegrity(), /Asset|Release was replaced/);
    await assert.rejects(readFile(path.join(h.directory, integrityName)), {code: 'ENOENT'});
    assert.deepEqual(h.writes, []);
  }
});

it('signs the digest of the exact YAML passed to the single Release upload', async t => {
  const h = await publicationHarness({t});
  const sha256 = await h.prepareIntegrity();
  assert.equal(sha256, (await hashFile({file: path.join(h.directory, integrityName)})).sha256);
  await h.upload();
  assert.equal(h.writes.length, 1);
  assert.equal(h.remote.at(-1).name, integrityName);
  await assert.rejects(h.guard(), /already has signed/);
  assert.equal(h.writes.length, 1);
});

it('refuses to replace a prepared integrity YAML', async t => {
  const h = await publicationHarness({t});
  const sha256 = await h.prepareIntegrity();
  await assert.rejects(h.prepareIntegrity(), /EEXIST/);
  assert.equal((await hashFile({file: path.join(h.directory, integrityName)})).sha256, sha256);
  assert.deepEqual(h.writes, []);
});

it('refuses to prepare a proof when the Release is no longer a published stable tag', async t => {
  const h = await publicationHarness({t});
  h.release.draft = true;
  await assert.rejects(h.prepareIntegrity(), /stable published release/);
  await assert.rejects(readFile(path.join(h.directory, integrityName)), {code: 'ENOENT'});
});
