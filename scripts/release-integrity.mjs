// Local-only publication evidence. All GitHub requests stay in the workflow.
// !!! ALLOW-EXTERNAL-COMMAND git:* !!! -- Read the selected commit and require clean tracked source before building.
// !!! ALLOW-EXTERNAL-COMMAND bash:* !!! -- Execute the exact auditable committed-tree fingerprint recipe.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runCommandSync} from '../build/command.ts';
import {READ_ENV_GITHUB_REPOSITORY, READ_ENV_GITHUB_SHA, READ_ENV_GITHUB_RUN_ID, READ_ENV_GITHUB_RUN_ATTEMPT,
  READ_ENV_PATH, READ_ENV_HOME} from '../build/node-env.ts';

export const integrityName = 'naidan-release-integrity.yaml';
export const fingerprintScheme = 'git-committed-tree-sha256-v1';
const receiptName = 'naidan-build-receipt.json';
const sha256Pattern = /^[0-9a-f]{64}$/;
const sourceCommitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const zipPattern = /^naidan-(?:hosted|standalone(?:-[A-Za-z0-9-]+)?)\.zip$/;
const safeAssetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkKeys({value, keys}) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected evidence fields');
}

function checkContext({context}) {
  checkKeys({value: context, keys: ['repository', 'commit', 'run_id', 'build_attempt', 'tree_fingerprint']});
  assert.match(context.repository, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(context.commit, sourceCommitPattern);
  assert.match(context.run_id, /^[1-9][0-9]*$/);
  assert.match(context.build_attempt, /^[1-9][0-9]*$/);
  checkKeys({value: context.tree_fingerprint, keys: ['algorithm', 'scheme', 'value']});
  assert.equal(context.tree_fingerprint.algorithm, 'sha256');
  assert.equal(context.tree_fingerprint.scheme, fingerprintScheme);
  assert.match(context.tree_fingerprint.value, sha256Pattern);
}

async function directory({file}) {
  const info = await lstat(file);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Expected a real directory: ${file}`);
}

export async function hashFile({file}) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Expected a regular file: ${file}`);
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
    size += chunk.length;
  }
  assert.equal(size, info.size, `File changed while hashing: ${file}`);
  return {size, sha256: digest.digest('hex')};
}

export async function captureSource({root, repository, commit, runId, buildAttempt}) {
  // Do not pass the publication token or shell startup hooks to these readers.
  const env = {PATH: READ_ENV_PATH(), HOME: READ_ENV_HOME(), LC_ALL: 'C',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1'};
  const git = ({args}) => {
    const result = runCommandSync({argv: ['git', ...args], options: {cwd: root, env, encoding: 'utf8'}});
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'Git source read failed');
    return result.stdout.trim();
  };
  const head = await git({args: ['rev-parse', '--verify', 'HEAD']});
  assert.equal(head, commit, 'Checkout does not match the workflow source commit');
  assert.equal(await git({args: ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none']}), '',
    'Tracked source must be clean before the build');
  const script = fileURLToPath(new URL('./treefingerprint.sh', import.meta.url));
  const result = runCommandSync({argv: ['bash', '--noprofile', '--norc', script],
    options: {cwd: root, env, encoding: 'utf8', maxBuffer: 1024 * 1024}});
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Source fingerprint failed');
  const context = {
    repository: `https://github.com/${repository}`, commit: head, run_id: runId, build_attempt: buildAttempt,
    tree_fingerprint: {algorithm: 'sha256', scheme: fingerprintScheme, value: result.stdout.trim()},
  };
  checkContext({context});
  return context;
}

// Cover the actual hosted input embedded by Go as well as the downloadable ZIPs.
// Debug reports and the temporary test server binary are not distribution inputs.
export async function collectBuildInputs({root}) {
  const dist = path.join(root, 'dist');
  await directory({file: dist});
  const files = [];
  const walk = async ({relative}) => {
    await directory({file: path.join(dist, relative)});
    for (const name of (await readdir(path.join(dist, relative))).sort()) {
      const next = path.posix.join(relative, name);
      const file = path.join(dist, next);
      const info = await lstat(file);
      assert.ok(!info.isSymbolicLink(), `Symlink in hosted input: ${next}`);
      if (info.isDirectory()) {
        await walk({relative: next});
      } else {
        files.push({path: next, ...await hashFile({file})});
      }
    }
  };
  await walk({relative: 'hosted'});
  assert.ok(files.length > 0, 'Empty hosted build');
  const names = (await readdir(dist)).filter(name => name.endsWith('.zip')).sort();
  assert.ok(names.includes('naidan-standalone.zip') && names.includes('naidan-hosted.zip'), 'Missing universal/hosted ZIP');
  assert.ok(names.some(name => name.startsWith('naidan-standalone-')), 'Missing locale ZIPs');
  for (const name of names) {
    assert.match(name, zipPattern, 'Unexpected build ZIP');
    files.push({path: name, ...await hashFile({file: path.join(dist, name)})});
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function sealBuild({root, source}) {
  checkContext({context: source});
  return {schema_version: 1, source, files: await collectBuildInputs({root})};
}

function checkReceipt({receipt}) {
  checkKeys({value: receipt, keys: ['schema_version', 'source', 'files']});
  assert.equal(receipt.schema_version, 1);
  checkContext({context: receipt.source});
  assert.ok(Array.isArray(receipt.files) && receipt.files.length > 0);
  const paths = new Set();
  for (const file of receipt.files) {
    checkKeys({value: file, keys: ['path', 'size', 'sha256']});
    assert.equal(typeof file.path, 'string');
    assert.ok(!paths.has(file.path), 'Duplicate receipt path');
    assert.ok(!file.path.includes('\\') && !file.path.includes('\0') &&
      file.path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe receipt path');
    assert.ok(file.path.startsWith('hosted/') || zipPattern.test(file.path), 'Unexpected receipt path');
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0);
    assert.match(file.sha256, sha256Pattern);
    paths.add(file.path);
  }
}

export async function verifyBuild({root, receipt, source}) {
  checkReceipt({receipt});
  checkContext({context: source});
  // A release-only rerun keeps the original build artifact but has a newer attempt.
  const {build_attempt: originalAttempt, ...original} = receipt.source;
  const {build_attempt: currentAttempt, ...current} = source;
  assert.ok(originalAttempt && currentAttempt);
  assert.deepEqual(original, current, 'Build artifact belongs to another run or source tree');
  assert.deepEqual(await collectBuildInputs({root}), receipt.files, 'Downloaded build input changed');
}

export async function releaseAssets({root, receipt, tag}) {
  checkReceipt({receipt});
  assert.match(tag, /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  const assets = [];
  for (const entry of receipt.files.filter(file => zipPattern.test(file.path))) {
    const name = `${entry.path.slice(0, -4)}-${tag}.zip`;
    const actual = await hashFile({file: path.join(root, 'dist', name)});
    assert.deepEqual(actual, {size: entry.size, sha256: entry.sha256}, 'Release ZIP differs from this build');
    assets.push({name, ...actual});
  }
  const zipNames = (await readdir(path.join(root, 'dist'))).filter(name => name.endsWith('.zip')).sort();
  assert.deepEqual(zipNames, assets.map(asset => asset.name).sort(), 'Unexpected release ZIP');
  await directory({file: path.join(root, 'dist/goreleaser-dist')});
  const goArtifacts = JSON.parse(await readFile(path.join(root, 'dist/goreleaser-dist/artifacts.json'), 'utf8'));
  assert.ok(Array.isArray(goArtifacts), 'Invalid GoReleaser metadata');
  const acceptedTypes = new Set(['Archive', 'Linux Package', 'Checksum']);
  const foundTypes = new Set();
  for (const entry of goArtifacts) {
    assert.ok(entry && typeof entry === 'object' && typeof entry.type === 'string', 'Invalid GoReleaser record');
    if (['Binary', 'Metadata'].includes(entry.type)) {
      continue;
    }
    assert.ok(acceptedTypes.has(entry.type), `Unsupported public GoReleaser type: ${entry.type}`);
    assert.match(entry.name, safeAssetPattern);
    assert.equal(entry.path, `dist/goreleaser-dist/${entry.name}`, 'Unexpected GoReleaser artifact path');
    assets.push({name: entry.name, ...await hashFile({file: path.join(root, entry.path)})});
    foundTypes.add(entry.type);
  }
  assert.deepEqual(foundTypes, acceptedTypes, 'Incomplete GoReleaser distribution');
  assert.equal(assets.filter(asset => asset.name === 'checksums.txt').length, 1, 'Missing GoReleaser checksums');
  assert.equal(new Set(assets.map(asset => asset.name)).size, assets.length, 'Duplicate release asset');
  assert.ok(!assets.some(asset => asset.name === integrityName), 'Integrity file must not hash itself');
  return assets.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export async function renderIntegrity({receipt, tag, assets}) {
  checkReceipt({receipt});
  assert.match(tag, /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  assert.ok(assets.length > 0);
  const {source} = receipt;
  const quote = JSON.stringify;
  const indent = ({text, spaces}) => text.trimEnd().split('\n').map(line => ' '.repeat(spaces) + line).join('\n');
  const recipe = await readFile(new URL('./treefingerprint.sh', import.meta.url), 'utf8');
  for (const asset of assets) {
    assert.match(asset.name, safeAssetPattern);
    assert.match(asset.sha256, sha256Pattern);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size >= 0);
  }
  // JSON-quoted scalars are YAML scalars. Only the audited Bash uses a literal block.
  return `\
# Verify the exact bytes of this YAML before using its data or copying its commands.
# GitHub's generated source archives, release notes, and this YAML are not payload assets.
schema_version: 1
kind: naidan_release_integrity
release_tag: ${quote(tag)}
source:
  repository: ${quote(source.repository)}
  # Git commit is a locator; the independent content fingerprint follows.
  commit: ${quote(source.commit)}
  # Untracked, generated, and dependency files are excluded from this source fingerprint.
  tree_fingerprint:
    algorithm: sha256
    scheme: ${fingerprintScheme}
    value: ${quote(source.tree_fingerprint.value)}
    # In a recursive checkout of source.commit, run this at the repository root with Bash.
    # Requires Git and GNU sha256sum; hashes committed paths/modes/blobs and submodule content.
    # Records: mode NUL path NUL content-SHA256 NUL, in recursive git ls-tree order.
    # Symlink content is its target text; submodule content is its recursive fingerprint.
    reproduce: |
${indent({text: recipe, spaces: 6})}
build:
  run_id: ${quote(source.run_id)}
  attempt: ${quote(source.build_attempt)}
artifacts:
${assets.map(asset => `  - name: ${quote(asset.name)}\n    size: ${asset.size}\n    sha256: ${quote(asset.sha256)}`).join('\n')}
verification:
  # Choose the expected tag/commit yourself. Do not derive trust policy from unverified YAML.
  # The reusable workflow below is the signer; the calling main.yml is not the signer.
  attestation: |
    gh attestation verify ${integrityName} \\
      --repo ${source.repository.slice('https://github.com/'.length)} \\
      --signer-workflow ${source.repository.slice('https://github.com/'.length)}/.github/workflows/sync-release-notes.yml \\
      --source-ref refs/tags/${tag} \\
      --source-digest ${source.commit} \\
      --deny-self-hosted-runners
  # After verifying the signature, run in a directory with the listed downloaded payloads.
  # This checks listed files; compare the release's uploaded asset names separately for extras.
  artifacts: |
    (
      set -euo pipefail
      sha256sum --strict --check <<'NAIDAN_SHA256'
${assets.map(asset => `    ${asset.sha256}  ${asset.name}`).join('\n')}
    NAIDAN_SHA256
    )
`;
}

async function main() {
  const [command, input, output, tag] = process.argv.slice(2);
  const root = process.cwd();
  const source = async () => captureSource({root, repository: READ_ENV_GITHUB_REPOSITORY(),
    commit: READ_ENV_GITHUB_SHA(), runId: READ_ENV_GITHUB_RUN_ID(), buildAttempt: READ_ENV_GITHUB_RUN_ATTEMPT()});
  const json = async ({file}) => JSON.parse(await readFile(file, 'utf8'));
  if (command === 'capture-source') {
    await writeFile(input, JSON.stringify(await source()), {flag: 'wx'});
  } else if (command === 'seal-build') {
    await writeFile(path.join(root, 'dist', receiptName), JSON.stringify(await sealBuild({root, source: await json({file: input})})), {flag: 'wx'});
  } else if (command === 'verify-build') {
    await verifyBuild({root, receipt: await json({file: input}), source: await source()});
  } else if (command === 'prepare') {
    const receipt = await json({file: input});
    const assets = await releaseAssets({root, receipt, tag});
    await mkdir(output, {recursive: true});
    await writeFile(path.join(output, integrityName), await renderIntegrity({receipt, tag, assets}), {flag: 'wx'});
    await writeFile(path.join(output, 'expected-assets.json'), JSON.stringify(assets), {flag: 'wx'});
  } else {
    throw new Error('Usage: release-integrity.mjs capture-source OUT | seal-build SOURCE | verify-build RECEIPT | prepare RECEIPT OUTDIR TAG');
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
