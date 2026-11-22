// Execute the actual inline workflow JavaScript with mocked GitHub methods.
// No copied implementation, npm packages, credentials, or network are needed.
// !!! ALLOW-EXTERNAL-COMMAND bash -e:* !!! -- Exercise the prerelease shell with a local gh stub.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {it} from 'node:test';
import {runCommandSync} from '../../build/command.ts';

const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const workflow = await readFile(new URL('.github/workflows/sync-release-notes.yml', root), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function inlineScript(stepId) {
  const lines = workflow.split('\n');
  const step = lines.findIndex(line => line.trim() === `id: ${stepId}`);
  assert.ok(step >= 0, `Missing step ${stepId}`);
  const marker = lines.findIndex((line, index) => index > step && line.trim() === 'script: |');
  assert.ok(marker > step);
  const indentation = lines[marker].match(/^ */)[0].length + 2;
  const body = [];
  for (const line of lines.slice(marker + 1)) {
    if (line.trim() && line.match(/^ */)[0].length < indentation) {
      break;
    }
    body.push(line.slice(indentation));
  }
  assert.ok(!body.join('\n').includes('${{'), 'Do not interpolate Actions expressions into JavaScript');
  return new AsyncFunction('github', 'context', 'core', 'require', 'process', 'setTimeout', body.join('\n'));
}

const fetchNotes = inlineScript('fetch_notes');
const applyNotes = inlineScript('apply_notes');
const publicationBody = `\
[Full Changelog][0.2.0] · [Build Attestation][attestation]

[0.2.0]: https://github.com/nwtgck/naidan/compare/v0.1.0...v0.2.0
[attestation]: https://github.com/nwtgck/naidan/attestations/123
`;
const release = (id = 1, tag_name = 'v0.2.0', extra = {}) => ({
  id, tag_name, body: 'old', draft: false, prerelease: false, ...extra,
});
const update = (id = 1, tag_name = 'v0.2.0', body = 'new\n') => ({id, tag_name, body});
const plan = (updates = [update()], create = null, publication = null) => ({updates, create, publication, skipped: []});

async function harness(t, {releases = [release()], updates = plan(), publishTag = '', dryRun = false} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'naidan-release-notes-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(path.join(directory, 'input'));
  const save = (name, value) => writeFile(path.join(directory, name), JSON.stringify(value));
  await save('input/releases.json', releases);
  await save('input/source.json', {
    repository: 'nwtgck/naidan', changelog_blob: 'test-blob', publish_tag: publishTag,
  });
  await save('updates.json', {...updates, publication: publishTag ? {body: publicationBody, reset_body: null} : null});
  const calls = [], logs = [], delays = [];
  const context = {
    repo: {owner: 'nwtgck', repo: 'naidan'}, eventName: 'push',
    ref: publishTag ? `refs/tags/${publishTag}` : 'refs/heads/develop', sha: 'a'.repeat(40),
  };
  const env = {NOTES_DIR: directory, PUBLISH_TAG: publishTag, DRY_RUN: String(dryRun)};
  const github = {rest: {repos: {
    listReleases: () => {
      throw new Error('Use pagination');
    },
    getCommit: async payload => {
      assert.deepEqual(payload, {...context.repo, ref: `refs/tags/${publishTag}`});
      return {data: {sha: context.sha}};
    },
    updateRelease: async payload => {
      calls.push({method: 'PATCH', payload});
      return {data: payload};
    },
    createRelease: async payload => {
      calls.push({method: 'POST', payload});
      return {data: payload};
    },
    getContent: async payload => {
      calls.push({method: 'GET content', payload});
      return {data: {type: 'file', encoding: 'base64', content: Buffer.from('# Changelog\n').toString('base64'), sha: 'blob'}};
    },
  }}, paginate: async (method, parameters, map) => {
    assert.equal(method, github.rest.repos.listReleases);
    calls.push({method: 'GET releases', payload: parameters});
    // Model two pages to exercise the actual response mapper and flattened result.
    return [...map({data: releases.slice(0, 1)}), ...map({data: releases.slice(1)})];
  }};
  const core = {info: message => logs.push(message)};
  const execute = fn => fn(github, context, core, require, {env}, (callback, delay) => {
    delays.push(delay);
    callback();
  });
  return {directory, save, calls, logs, delays, context, env, github, execute};
}

it('PATCH has an explicit body-only field allowlist and preserves literal Markdown', async t => {
  const body = '日本語\n```js\n"; throw new Error("not code");\n```\n${{ secrets.GITHUB_TOKEN }}\n\n';
  const h = await harness(t, {updates: plan([update(1, 'v0.2.0', body)])});
  await h.execute(applyNotes);
  assert.deepEqual(h.calls, [{method: 'PATCH', payload: {owner: 'nwtgck', repo: 'naidan', release_id: 1, body}}]);
});

it('unchanged or empty plans perform zero writes, including null versus empty bodies', async t => {
  for (const [releases, updates] of [
    [[release()], plan([])], [[release()], plan([update(1, 'v0.2.0', 'old')])],
    [[release(1, 'v0.2.0', {body: null})], plan([update(1, 'v0.2.0', '')])],
  ]) {
    const h = await harness(t, {releases, updates});
    await h.execute(applyNotes);
    assert.deepEqual(h.calls, []);
  }
});

it('dry run validates the complete plan but never calls mutation endpoints', async t => {
  const h = await harness(t, {dryRun: true});
  await h.execute(applyNotes);
  assert.deepEqual(h.calls, []);
  assert.match(h.logs.join('\n'), /Dry run/);
});

it('rejects a changed tag before creating a release or updating its notes', async t => {
  const h = await harness(t, {
    publishTag: 'v0.3.0', updates: plan([update()], {tag_name: 'v0.3.0', body: 'new release'}),
  });
  h.github.rest.repos.getCommit = async () => ({data: {sha: 'b'.repeat(40)}});
  await assert.rejects(h.execute(applyNotes), /no longer points to the signed source commit/);
  assert.deepEqual(h.calls, []);
});

it('validates every update before performing even the first mutation', async t => {
  const badUpdates = [
    {...update(2, 'v0.1.0'), id: '2'}, {...update(2, 'v0.1.0'), id: 1.5},
    {...update(2, 'v0.1.0'), body: null}, {...update(2, 'v0.1.0'), body: 'あ'.repeat(42000)},
    update(999, 'v0.1.0'), update(2, 'v9.0.0'), update(2, '../repos/other'),
    {...update(2, 'v0.1.0'), owner: 'attacker'}, update(),
  ];
  for (const bad of badUpdates) {
    const h = await harness(t, {releases: [release(), release(2, 'v0.1.0')], updates: plan([update(), bad])});
    await assert.rejects(h.execute(applyNotes));
    assert.deepEqual(h.calls, []);
  }
});

it('draft and prerelease destinations are rejected, not silently published', async t => {
  for (const extra of [{draft: true}, {prerelease: true}]) {
    const h = await harness(t, {releases: [release(1, 'v0.2.0', extra)]});
    await assert.rejects(h.execute(applyNotes), /not authorized/);
    assert.deepEqual(h.calls, []);
  }
});

it('rejects malformed plans, snapshots, mode, and repository identity', async t => {
  for (const [file, value] of [
    ['updates.json', []], ['updates.json', {...plan(), url: 'https://attacker.invalid'}],
    ['updates.json', {...plan(), skipped: null}], ['input/releases.json', {}],
    ['input/releases.json', [release(), release()]],
    ['input/releases.json', [release(), release(2)]],
    ['input/releases.json', [release(1, 'v0.2.0', {draft: 0})]],
    ['input/source.json', {repository: 'other/repo', publish_tag: ''}],
  ]) {
    const h = await harness(t);
    await h.save(file, value);
    await assert.rejects(h.execute(applyNotes));
    assert.deepEqual(h.calls, []);
  }
  const h = await harness(t);
  h.env.DRY_RUN = 'not-a-boolean';
  await assert.rejects(h.execute(applyNotes), /dry-run/);
});

it('only an explicitly authorized tag push may create a release with reviewed notes', async t => {
  const h = await harness(t, {releases: [], updates: plan([], {tag_name: 'v0.2.0', body: 'reviewed'}), publishTag: 'v0.2.0'});
  await h.execute(applyNotes);
  assert.deepEqual(h.calls, [{method: 'POST', payload: {
    owner: 'nwtgck', repo: 'naidan', tag_name: 'v0.2.0', name: 'v0.2.0',
    body: 'reviewed', draft: false, prerelease: false,
    generate_release_notes: false,
  }}]);
});

it('validates the publication bodies before any writes', async t => {
  for (const [publishTag, invalidPublication] of [
    ['v0.2.0', null], ['v0.2.0', {body: '', reset_body: null}],
    ['v0.2.0', {body: publicationBody, reset_body: []}], ['', {body: publicationBody, reset_body: null}],
  ]) {
    const h = await harness(t, {publishTag});
    await h.save('updates.json', plan([update()], null, invalidPublication));
    await assert.rejects(h.execute(applyNotes), /bodies are required only for tag publication/);
    assert.deepEqual(h.calls, []);
  }
});

it('rejects unauthorized creation before updating other releases', async t => {
  for (const options of [
    {publishTag: '', create: {tag_name: 'v0.3.0', body: 'notes'}},
    {publishTag: 'v0.3.0', create: {tag_name: 'v0.4.0', body: 'notes'}},
    {publishTag: 'v0.2.0', create: {tag_name: 'v0.2.0', body: 'already exists'}},
    {publishTag: 'v0.3.0', create: {tag_name: 'v0.3.0', body: 'notes', draft: false}},
  ]) {
    const h = await harness(t, {updates: plan([update()], options.create), publishTag: options.publishTag});
    await assert.rejects(h.execute(applyNotes));
    assert.deepEqual(h.calls, []);
  }
});

it('rejects tag publication from manual dispatch or a different ref', async t => {
  for (const change of [{eventName: 'workflow_dispatch'}, {ref: 'refs/heads/develop'}]) {
    const h = await harness(t, {publishTag: 'v0.2.0'});
    Object.assign(h.context, change);
    await assert.rejects(h.execute(fetchNotes), /Publication/);
    await assert.rejects(h.execute(applyNotes), /publication context/);
    assert.deepEqual(h.calls, []);
  }
});

it('requires the requested publication to exist or be created, never promotes draft/prerelease', async t => {
  for (const releases of [[], [release(1, 'v0.2.0', {draft: true})], [release(1, 'v0.2.0', {prerelease: true})]]) {
    const h = await harness(t, {releases, updates: plan([]), publishTag: 'v0.2.0'});
    await assert.rejects(h.execute(applyNotes), /missing or not stable/);
    assert.deepEqual(h.calls, []);
  }
});

it('paces sequential writes without per-release reads', async t => {
  const h = await harness(t, {releases: [release(), release(2, 'v0.1.0')],
    updates: plan([update(), update(2, 'v0.1.0')], {tag_name: 'v0.3.0', body: 'new'}), publishTag: 'v0.3.0'});
  await h.execute(applyNotes);
  assert.deepEqual(h.calls.map(call => call.method), ['POST', 'PATCH', 'PATCH']);
  assert.deepEqual(h.delays, [1000, 1000]);
});

it('a failed write stops further writes; a new snapshot makes a rerun resume idempotently', async t => {
  const releases = [release(), release(2, 'v0.1.0'), release(3, 'v0.0.1')];
  const updates = plan([update(), update(2, 'v0.1.0'), update(3, 'v0.0.1')]);
  const h = await harness(t, {releases, updates});
  h.github.rest.repos.updateRelease = async payload => {
    h.calls.push({method: 'PATCH', payload});
    if (payload.release_id === 2) {
      throw new Error('simulated API failure');
    }
    releases.find(entry => entry.id === payload.release_id).body = payload.body;
  };
  await assert.rejects(h.execute(applyNotes), /simulated API failure/);
  assert.deepEqual(h.calls.map(call => call.payload.release_id), [1, 2]);
  const rerun = await harness(t, {releases, updates});
  await rerun.execute(applyNotes);
  assert.deepEqual(rerun.calls.map(call => call.payload.release_id), [2, 3]);
});

it('fetch always uses current develop and paginates at 100 with only required metadata', async t => {
  const h = await harness(t, {releases: [release(1, 'v0.2.0', {assets: ['not needed']}), release(2, 'v0.1.0')]});
  h.context.sha = 'old-trigger-commit';
  await h.execute(fetchNotes);
  assert.deepEqual(h.calls.map(call => call.method), ['GET content', 'GET releases']);
  assert.equal(h.calls[0].payload.ref, 'refs/heads/develop');
  assert.equal(h.calls[1].payload.per_page, 100);
  const fetched = JSON.parse(await readFile(path.join(h.directory, 'input/releases.json'), 'utf8'));
  assert.deepEqual(fetched, [release(), release(2, 'v0.1.0')]);
  assert.equal(JSON.parse(await readFile(path.join(h.directory, 'input/source.json'), 'utf8')).changelog_blob, 'blob');
});

it('tag publications fetch their immutable commit in addition to canonical develop', async t => {
  const h = await harness(t, {publishTag: 'v0.2.0'});
  await h.execute(fetchNotes);
  assert.deepEqual(h.calls.filter(call => call.method === 'GET content').map(call => call.payload.ref),
    ['refs/heads/develop', 'a'.repeat(40)]);
});

it('missing or invalid canonical content fails rather than falling back to old tagged history', async t => {
  const h = await harness(t, {publishTag: 'v0.2.0'});
  h.github.rest.repos.getContent = async () => {
    throw new Error('404 canonical file missing');
  };
  await assert.rejects(h.execute(fetchNotes), /canonical file missing/);
  h.github.rest.repos.getContent = async () => ({data: {type: 'dir'}});
  await assert.rejects(h.execute(fetchNotes), /base64-encoded/);
});

it('pagination failure fails the fetch step instead of silently planning a partial inventory', async t => {
  const h = await harness(t);
  h.github.paginate = async () => {
    throw new Error('second page failed');
  };
  await assert.rejects(h.execute(fetchNotes), /second page failed/);
});

it('workflow keeps audit boundaries, shared non-dropping lock, and guarded asset publishing', async () => {
  assert.match(workflow, /queue: max/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /--network none --read-only --cap-drop=ALL/);
  assert.match(workflow, /--pull=never/);
  assert.match(workflow, /source=\$NOTES_DIR\/input,target=\/input,readonly/);
  const offline = workflow.split('- name: Plan all release-note changes offline')[1].split('- name: Validate')[0];
  assert.doesNotMatch(offline, /GH_TOKEN|GITHUB_TOKEN|docker\.sock|--privileged|--network host/);
  assert.doesNotMatch(workflow, /require\(['"]\.\//);
  const assets = workflow.slice(workflow.indexOf('      # Asset publication stays in the same job/lock'));
  for (const step of assets.split(/^      - name:/m).slice(1)) {
    assert.match(step, /if: \$\{\{ inputs.publish-tag != '' && !inputs.dry-run\b/,
      'Every publication step must require a non-dry tag publication');
  }
  assert.ok(assets.indexOf('id: guard_publication') < assets.indexOf('uses: softprops/action-gh-release'));
  assert.match(assets, /artifact-ids: \$\{\{ inputs\.distribution-artifact-id \}\}/);
  assert.match(assets, /digest-mismatch: error/);
  assert.match(assets, /distribution\/assets\/\*/);
  assert.ok(assets.indexOf('uses: softprops/action-gh-release') < assets.indexOf('id: publish_integrity'));
  assert.doesNotMatch(assets, /actions\/attest|goreleaser\/goreleaser-action|attestation\.bundle\.json/);
  assert.doesNotMatch(assets, /^\s+(body|body_path|generate_release_notes):/m);
});

it('shares the signed candidate across branch builds and both Release destinations', async () => {
  const main = await readFile(new URL('.github/workflows/main.yml', root), 'utf8');
  const [candidate, publications] = main.split('  prepare_release:\n')[1].split('  release_to_github:\n');
  const [stable, prerelease] = publications.split('  prerelease_to_github:\n');
  assert.match(candidate, /needs: \[build, test_release_tooling\]/);
  assert.doesNotMatch(candidate.split('    steps:')[0], /\n    if:/);
  assert.match(candidate, /id-token: write/);
  assert.match(candidate, /attestations: write/);
  for (const step of candidate.split(/^      - name:/m)) {
    if (/uses: .*setup-go@|uses: .*goreleaser-action@|goreleaser release/.test(step)) {
      assert.match(step, /if: github\.ref_type == 'tag'/);
    }
    if (/id: (prepare|attest|distribution)\b/.test(step)) {
      assert.doesNotMatch(step, /\n        if:/);
    }
  }
  assert.match(candidate, /--network none[\s\S]*goreleaser release --skip=publish --clean/);
  assert.match(candidate, /GOTMPDIR=\/work\/dist/);
  assert.match(candidate, /subject-digest: sha256:\$\{\{ steps\.prepare\.outputs\.sha256 \}\}/);
  assert.match(candidate, /attestation-url: \$\{\{ steps\.attest\.outputs\.attestation-url \}\}/);
  assert.match(candidate, /attestation\.bundle\.json/);
  assert.match(candidate, /name: naidan-integrity-\$\{\{ github\.run_attempt \}\}\n +path: \$\{\{ runner\.temp \}\}\/distribution\/naidan-release-integrity\.yaml/);
  assert.match(candidate, /NAIDAN_WORKFLOW_ARTIFACTS: \$\{\{ needs\.build\.outputs\.artifact-digests \}\}/);
  assert.match(candidate, /-e NAIDAN_WORKFLOW_ARTIFACTS/);
  assert.match(candidate, /path: \$\{\{ runner\.temp \}\}\/distribution\//);
  assert.match(stable, /!contains\(github\.ref_name, '-'\)/);
  assert.match(stable, /distribution-artifact-id: \$\{\{ needs\.prepare_release\.outputs\.artifact-id \}\}/);
  assert.match(stable, /attestation-url: \$\{\{ needs\.prepare_release\.outputs\.attestation-url \}\}/);
  assert.match(workflow, /--attestation-url "\$ATTESTATION_URL"/);
  assert.match(prerelease, /&& contains\(github\.ref_name, '-'\)/);
  assert.match(prerelease, /artifact-ids: \$\{\{ needs\.prepare_release\.outputs\.artifact-id \}\}/);
  assert.match(prerelease, /--verify-tag --prerelease --latest=false/);
  assert.match(prerelease, /ATTESTATION_URL: \$\{\{ needs\.prepare_release\.outputs\.attestation-url \}\}/);
  assert.match(prerelease, /\[Build Attestation\]\[attestation\]/);
  assert.match(prerelease, /--notes "\$notes"/);
  assert.match(prerelease, /commits\/refs%2Ftags%2F\$TAG"\)" = "\$GITHUB_SHA"/);
  assert.match(prerelease, /distribution\/naidan-release-integrity\.yaml/);
  assert.doesNotMatch(publications, /attestations: write|goreleaser|actions\/attest/);
});

it('publishes prerelease notes with the build attestation when no changelog is present', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'naidan-prerelease-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const main = await readFile(new URL('.github/workflows/main.yml', root), 'utf8');
  const run = main.match(/- name: Publish the candidate as a GitHub prerelease\n[\s\S]*?\n {8}run: \|\n((?: {10}[^\n]*\n)+)/)?.[1];
  assert.ok(run);
  const stub = `\
gh() {
  if [[ "$1" == api ]]; then
    printf '%s\\n' "$GITHUB_SHA"
  else
    printf '%s\\0' "$@"
  fi
}
`;
  const tag = 'v0.72.1-release-trigger-2';
  const runPrerelease = ({url}) => runCommandSync({
    argv: ['bash', '-e', '-c', stub + run],
    options: {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: {ATTESTATION_URL: url, GITHUB_REPOSITORY: 'nwtgck/naidan', GITHUB_SHA: 'a'.repeat(40), RUNNER_TEMP: directory, TAG: tag},
    },
  });
  const url = 'https://github.com/nwtgck/naidan/attestations/123';
  const result = runPrerelease({url});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const args = result.stdout.split('\0');
  assert.deepEqual(args.slice(0, 3), ['release', 'create', tag]);
  assert.equal(args[args.indexOf('--notes') + 1], `[Build Attestation][attestation]\n\n[attestation]: ${url}\n`);
  const invalid = runPrerelease({url: ''});
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
});

it('action lockfile covers every dependency moved into the reusable workflow', async () => {
  const lockfile = await readFile(new URL('.github/workflows/actions.lock', root), 'utf8');
  const section = lockfile.split("    '.github/workflows/sync-release-notes.yml':\n")[1]
    ?.split(/^    '/m)[0];
  assert.ok(section, 'Missing lockfile entry for new workflow');
  const recorded = [...section.matchAll(/^        - '([^']+)'$/gm)].map(match => match[1]).sort();
  const expected = [...new Set([...workflow.matchAll(/^\s+uses: ([^\s#]+)$/gm)]
    .map(match => match[1]).filter(value => !value.startsWith('$/')))].sort();
  assert.deepEqual(recorded, expected);
  for (const ref of recorded) {
    assert.ok(lockfile.includes(`    '${ref}':\n`), `Missing dependency pin for ${ref}`);
  }
});

it('draft tags and bodies never reach fetched snapshots or published artifacts', async t => {
  const h = await harness(t, {releases: [release(), release(9, 'secret-draft', {draft: true, body: 'confidential'})]});
  await h.execute(fetchNotes);
  const snapshot = await readFile(path.join(h.directory, 'input/releases.json'), 'utf8');
  assert.deepEqual(JSON.parse(snapshot), [release()]);
  assert.doesNotMatch(snapshot + h.logs.join(' '), /secret-draft|confidential/);
});

it('fetch rejects existing draft/prerelease publication instead of hiding the collision', async t => {
  for (const state of [{draft: true}, {prerelease: true}]) {
    const h = await harness(t, {releases: [release(1, 'v0.2.0', state)], publishTag: 'v0.2.0'});
    await assert.rejects(h.execute(fetchNotes), /Refusing to republish/);
    assert.ok(h.calls.every(call => call.method.startsWith('GET')));
  }
});

it('shared changelog formatting changes trigger release-note synchronization', () => {
  const push = workflow.split('  workflow_dispatch:')[0];
  assert.match(push, /^      - scripts\/changelog_format\.py$/m);
  assert.doesNotMatch(push, /^      - changelog-unreleased/m);
});

it('protects host publication tooling and Git state across dependency installation and build', async () => {
  const main = await readFile(new URL('.github/workflows/main.yml', root), 'utf8');
  const build = main.split('  build:\n')[1].split(/^  [a-z_]+:/m)[0];
  const install = await readFile(new URL('.github/actions/retry-npm-ci/action.yml', root), 'utf8');
  for (const [block, prefix] of [[install, '$GITHUB_WORKSPACE'], [build, '$PWD']]) {
    assert.ok(block.includes(`-v "${prefix}/scripts:/work/scripts:ro"`));
    assert.ok(block.includes(`-v "${prefix}/build:/work/build:ro"`));
    assert.ok(block.includes(`-v "${prefix}/.git:/work/.git:ro"`));
  }
  assert.ok(build.indexOf('capture-source') < build.indexOf('name: Install dependencies'));
  assert.ok(build.indexOf('rev-parse HEAD)" = "$GITHUB_SHA"') < build.indexOf('name: Run build'));
  assert.ok(build.includes('diff --quiet --no-ext-diff "$GITHUB_SHA" --'));
  assert.ok(build.indexOf('seal-build') < build.indexOf('name: Upload full dist build artifact'));
  const server = build.split('name: Verify naidan-server build')[1].split('name: Verify individual artifact inputs')[0];
  assert.match(server, /--pull=never --network none[\s\S]*go run build\.go/);
  assert.match(server, /GOTMPDIR=\/scratch/);
});
