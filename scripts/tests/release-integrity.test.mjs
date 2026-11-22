// !!! ALLOW-EXTERNAL-COMMAND git:* !!! -- Create and inspect temporary source fixtures for release evidence.
// !!! ALLOW-EXTERNAL-COMMAND bash -c:* !!! -- Execute the published artifact-verification recipe against fixture files.
// !!! ALLOW-EXTERNAL-COMMAND node:* !!! -- Run the offline release integrity CLI against fixture packages.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {it} from 'node:test';
import {UI_LOCALES} from '../../src/01-models/ui-locale.ts';
import {runCommandSync} from '../../build/command.ts';
import {READ_ENV_PATH, READ_ENV_HOME, READ_ENV_TMPDIR} from '../../build/node-env.ts';
import {captureSource, collectBuildInputs, distributionVersion, fingerprintScheme, hashFile, integrityName,
  renderIntegrity, sealBuild, stageReleaseAssets, verifyBuild} from '../release-integrity.mjs';

const require = createRequire(import.meta.url);
const workflow = await readFile(new URL('../../.github/workflows/sync-release-notes.yml', import.meta.url), 'utf8');
const integrityScript = fileURLToPath(new URL('../release-integrity.mjs', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const standaloneZips = ['naidan-standalone.zip', ...UI_LOCALES.map(locale => `naidan-standalone-${locale}.zip`)];
const workflowArtifacts = {
  'full-dist-build': '1'.repeat(64),
  'standalone-universal-package': '2'.repeat(64),
  'standalone-all-locale-packages': '3'.repeat(64),
  'naidan-hosted': '4'.repeat(64),
  'naidan-server-binary': '5'.repeat(64),
};
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
    ['naidan-hosted.zip', 'hosted ZIP'], ...standaloneZips.map(name => [name, `built ${name}`]),
  ]) {
    await writeFile(path.join(root, 'dist', name), bytes);
  }
  const receipt = await sealBuild({root, source: source()});
  const prepare = async ({version}) => {
    await mkdir(path.join(root, 'dist/goreleaser-dist'));
    const go = [
      {name: `naidan-server-v${version}-Linux-x86_64.tar.gz`, type: 'Archive'},
      {name: `naidan-server-v${version}-linux-amd64.deb`, type: 'Linux Package'},
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
    'hosted/index.html', 'hosted/sub/module.js', 'naidan-hosted.zip', ...standaloneZips,
  ].sort());
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
  const go = await prepare({version: '1.2.3'});
  const stage = async () => stageReleaseAssets({root, receipt, version: '1.2.3',
    sourceRef: 'refs/tags/v1.2.3', output: path.join(await mkdtemp(path.join(root, 'stage-')), 'assets')});
  const assets = await stage();
  assert.equal(assets.length, go.length + standaloneZips.length + 1);
  assert.equal(assets.find(entry => entry.name === 'checksums.txt').sha256,
    (await hashFile({file: path.join(root, 'dist/goreleaser-dist/checksums.txt')})).sha256);
  const save = async ({entries}) => writeFile(path.join(root, 'dist/goreleaser-dist/artifacts.json'), JSON.stringify(entries));
  for (const entries of [
    [...go, {...go[0]}], [go[0], go[1]],
    [...go, {name: 'secret', type: 'Archive', path: '../../secret'}],
    [...go, {name: 'surprise', type: 'SBOM', path: 'dist/goreleaser-dist/surprise'}],
  ]) {
    await save({entries});
    await assert.rejects(stage());
  }
  await save({entries: go});
  await writeFile(path.join(root, 'dist/naidan-hosted.zip'), 'replaced');
  await assert.rejects(stage(), /Release ZIP differs/);
});

it('embeds the exact fingerprint script and runnable artifact checks, without self-hashing', async t => {
  const {root, receipt, prepare} = await fixture({t});
  await prepare({version: '1.2.3'});
  const proofDirectory = path.join(root, 'assets');
  const assets = await stageReleaseAssets({root, receipt, version: '1.2.3', sourceRef: 'refs/tags/v1.2.3', output: proofDirectory});
  const yaml = await renderIntegrity({receipt, version: '1.2.3', sourceRef: 'refs/tags/v1.2.3', assets, workflowArtifacts});
  const script = await readFile(new URL('../treefingerprint.sh', import.meta.url), 'utf8');
  assert.ok(yaml.includes(script.trimEnd().split('\n').map(line => `      ${line}`).join('\n')));
  assert.match(yaml, /--signer-workflow nwtgck\/naidan\/\.github\/workflows\/main\.yml/);
  assert.match(yaml, /--source-ref 'refs\/tags\/v1\.2\.3'/);
  assert.ok(!assets.some(entry => entry.name === integrityName));
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

async function candidateFixture({t, sourceRef}) {
  const {root, receipt, prepare} = await fixture({t});
  const packageVersion = '1.2.4-dev';
  await writeFile(path.join(root, 'package.json'), JSON.stringify({version: packageVersion}));
  const version = distributionVersion({sourceRef, packageVersion});
  if (sourceRef.startsWith('refs/heads/')) {
    await mkdir(path.join(root, 'dist/ci-server'));
    await writeFile(path.join(root, 'dist/ci-server/naidan-server'), 'existing CI server executable');
  } else {
    await prepare({version});
  }
  const directory = path.join(root, 'distribution');
  await mkdir(directory);
  const receiptFile = path.join(root, 'dist/naidan-build-receipt.json');
  await writeFile(receiptFile, JSON.stringify(receipt));
  const prepareIntegrity = () => {
    const options = commandOptions({cwd: root});
    const result = completed({result: runCommandSync({
      argv: ['node', integrityScript, 'prepare', receiptFile, directory],
      options: {...options, env: {...options.env, GITHUB_REF: sourceRef, NAIDAN_WORKFLOW_ARTIFACTS: JSON.stringify(workflowArtifacts)}},
    })});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return {root, directory, prepareIntegrity};
}

it('seals branch, stable tag and prerelease candidates through the same entry point', async t => {
  for (const [sourceRef, version] of [
    ['refs/heads/feature/artifact-integrity', '1.2.4-dev'],
    ['refs/tags/v1.2.3', '1.2.3'],
    ['refs/tags/v0.72.1-release-trigger-1', '0.72.1-release-trigger-1'],
  ]) {
    const {root, directory, prepareIntegrity} = await candidateFixture({t, sourceRef});
    const digest = prepareIntegrity();
    const file = path.join(directory, integrityName);
    const yaml = await readFile(file, 'utf8');
    assert.equal(digest, (await hashFile({file})).sha256);
    assert.ok(yaml.includes(`version: "${version}"`));
    assert.ok(yaml.includes(`  ref: "${sourceRef}"`));
    assert.ok(yaml.includes(`naidan-hosted-v${version}.zip`));
    const signedArtifactDigests = yaml.split('\nworkflow_artifacts:\n')[1].split('\nverification:\n')[0];
    assert.deepEqual(signedArtifactDigests.split('\n'),
      Object.entries(workflowArtifacts).map(([name, sha256]) => `  "${name}": "${sha256}"`));
    const assetDirectory = path.join(directory, 'assets');
    const versionedZips = standaloneZips.map(name => `${name.slice(0, -4)}-v${version}.zip`);
    assert.deepEqual((await readdir(assetDirectory)).filter(name => name.startsWith('naidan-standalone-')).sort(),
      [...versionedZips].sort());
    for (const [index, name] of versionedZips.entries()) {
      assert.deepEqual(await readFile(path.join(assetDirectory, name)), await readFile(path.join(root, 'dist', standaloneZips[index])));
      assert.ok(yaml.includes(`name: "${name}"`));
    }
    if (sourceRef.startsWith('refs/heads/')) {
      assert.match(yaml, /release_tag: null/);
      assert.match(yaml, /name: "naidan-server"/);
      assert.doesNotMatch(yaml, /name: "checksums.txt"/);
    } else {
      assert.ok(yaml.includes(`release_tag: "v${version}"`));
      assert.ok(yaml.includes(`naidan-server-v${version}-Linux-x86_64.tar.gz`));
    }
    assert.throws(prepareIntegrity, /EEXIST/);
    assert.equal((await hashFile({file})).sha256, digest);
  }
});

it('refuses to render integrity evidence with an empty or malformed Actions artifact digest', async t => {
  const {receipt} = await fixture({t});
  const sourceRef = 'refs/tags/v1.2.3';
  const assets = [{name: 'naidan-standalone-v1.2.3.zip', size: 10, sha256: 'a'.repeat(64)}];
  for (const digests of [{}, {...workflowArtifacts, 'naidan-hosted': ''}, {...workflowArtifacts, 'naidan-hosted': 'invalid'}]) {
    await assert.rejects(renderIntegrity({receipt, version: '1.2.3', sourceRef, assets, workflowArtifacts: digests}),
      /Actions artifact digest/);
  }
});

it('rejects a malformed tag before naming the candidate', () => {
  for (const sourceRef of ['refs/tags/vbad', 'refs/tags/v1.2', 'refs/pull/42/merge']) {
    assert.throws(() => distributionVersion({sourceRef, packageVersion: '1.2.3'}));
  }
});

it('guards stable releases, writes the attestation link, and uploads the exact signed YAML by Release ID', async t => {
  const {root, directory, prepareIntegrity} = await candidateFixture({t, sourceRef: 'refs/tags/v1.2.3'});
  prepareIntegrity();
  const release = {id: 42, tag_name: 'v1.2.3', draft: false, prerelease: false, body: ''};
  const assets = [], writes = [], outputs = {};
  const body = `\
[Build Attestation][attestation]

[attestation]: https://github.com/nwtgck/naidan/attestations/123
`;
  const planPath = path.join(root, 'updates.json');
  await writeFile(planPath, JSON.stringify({publication: {body, reset_body: null}}));
  const context = {repo: {owner: 'nwtgck', repo: 'naidan'}};
  const github = {rest: {repos: {
    getReleaseByTag: async args => {
      assert.deepEqual(args, {...context.repo, tag: release.tag_name});
      return {data: release};
    },
    listReleaseAssets: () => {
      throw new Error('Pagination required');
    },
    updateRelease: async payload => {
      writes.push({method: 'PATCH', payload});
      release.body = payload.body;
    },
    uploadReleaseAsset: async payload => {
      writes.push({method: 'UPLOAD', payload});
      assets.push({name: payload.name});
    },
  }}, paginate: async (method, args) => {
    assert.equal(method, github.rest.repos.listReleaseAssets);
    assert.deepEqual(args, {...context.repo, release_id: 42, per_page: 100});
    return assets;
  }};
  const core = {setOutput: (name, value) => {
    outputs[name] = value;
  }};
  const env = {PUBLISH_TAG: 'v1.2.3', NOTES_DIR: root, RUNNER_TEMP: root, DISTRIBUTION_ARTIFACT_ID: '', RELEASE_ID: '42'};
  const run = ({stepId}) => inlineScript({stepId})(github, context, core, require, {env});
  await assert.rejects(run({stepId: 'guard_publication'}), /artifact ID/);
  env.DISTRIBUTION_ARTIFACT_ID = '100';
  release.prerelease = true;
  await assert.rejects(run({stepId: 'guard_publication'}), /stable release/);
  release.prerelease = false;
  assets.push({name: 'extra.zip'});
  await assert.rejects(run({stepId: 'guard_publication'}), /Unexpected existing Release Asset/);
  assets.pop();
  assets.push({name: 'naidan-hosted-v1.2.3.zip'});
  assets.push({id: 5, name: integrityName, state: 'starter', size: 0});
  await assert.rejects(run({stepId: 'guard_publication'}), /empty starter asset.*asset ID 5.*rerun/);
  assert.deepEqual(writes, []);
  assets.pop();
  await run({stepId: 'guard_publication'});
  assert.equal(outputs['release-id'], '42');
  assert.deepEqual(writes, []);

  release.body = body.replace('/123', '/456');
  const resetBody = 'Changelog notes\n';
  await writeFile(planPath, JSON.stringify({publication: {body, reset_body: resetBody}}));
  await run({stepId: 'guard_publication'});
  assert.deepEqual(writes, [{method: 'PATCH', payload: {...context.repo, release_id: 42, body: resetBody}}]);
  writes.length = 0;

  const updateRelease = github.rest.repos.updateRelease;
  github.rest.repos.updateRelease = async () => {
    throw new Error('cannot update notes');
  };
  await assert.rejects(run({stepId: 'publish_integrity'}), /cannot update notes/);
  assert.deepEqual(writes, []);

  github.rest.repos.updateRelease = updateRelease;
  await run({stepId: 'publish_integrity'});
  const data = await readFile(path.join(directory, integrityName));
  assert.deepEqual(writes, [
    {method: 'PATCH', payload: {...context.repo, release_id: 42, body}},
    {method: 'UPLOAD', payload: {...context.repo, release_id: 42, name: integrityName, data,
      headers: {'content-type': 'application/yaml', 'content-length': data.length}}},
  ]);
  await assert.rejects(run({stepId: 'guard_publication'}), /already has signed/);
  assert.equal(release.body, body);
});
