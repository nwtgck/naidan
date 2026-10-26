import { expect, it } from 'vitest';
import { componentRequirements, type ImageFamily } from './model-configuration';
import { chooseInitialImagePrimary, chooseImageCompanion, imagePrimarySlot, reconcileImageComponents } from './model-selection';
import { imageSelectionCandidate as candidate } from './model-selection.test-support';

it.each<ImageFamily>(['z-image', 'qwen-image-2.1', 'flux1', 'flux2-klein-4b', 'anima', 'krea2', 'ernie-image', 'sd-checkpoint'])('resolves the existing component rules for %s', family => {
  const primary = candidate({ key: 'main', family, roles: [imagePrimarySlot({ family })!] });
  const components = componentRequirements({ family }).map((requirement, index) => candidate({ key: requirement.slot, roles: [requirement.slot], classes: requirement.accepts.slice(0, 1), tieBreakRank: index + 1 }));
  const candidates = [primary, ...components];
  expect(chooseInitialImagePrimary({ candidates })).toBe('main');
  const resolved = reconcileImageComponents({ primaryKey: 'main', candidates, choices: {}, previous: {}, recipe: undefined });
  expect(resolved.ready).toBe(true);
  expect(resolved.missingRequiredSlots).toEqual([]);
  expect(resolved.components.filter(component => component.key !== undefined).map(component => component.slot)).toEqual(componentRequirements({ family }).filter(requirement => requirement.required).map(requirement => requirement.slot));
});

it('selects initial primary by total bytes then supplied source rank, not arrival or transport keys', () => {
  const main = candidate({ key: 'main', family: 'z-image', roles: ['diffusion'], totalBytes: 1000, tieBreakRank: 2 });
  const other = { ...main, key: 'z', tieBreakRank: 1 };
  const invalid = [
    { ...main, key: 'broken', totalBytes: 1, issue: 'broken shard' },
    { ...main, key: 'wrong-role', totalBytes: 1, roles: ['vae' as const] },
    { ...main, key: 'adapter', totalBytes: 1, classes: ['lora'] },
    { ...main, key: 'unknown', totalBytes: 1, family: 'unknown' as const },
  ];
  expect(chooseInitialImagePrimary({ candidates: [main, ...invalid, other] })).toBe('z');
  expect(chooseInitialImagePrimary({ candidates: [other, ...invalid, main] })).toBe('z');
  expect(chooseInitialImagePrimary({ candidates: invalid })).toBeUndefined();
});

it('requires both role and class and prioritizes repository before size and rank', () => {
  const primary = candidate({ key: 'main', family: 'z-image', roles: ['diffusion'] });
  const requirement = componentRequirements({ family: primary.family })[0]!;
  const remote = candidate({ key: 'remote', repositoryGroup: 'elsewhere', roles: ['vae'], classes: ['vae-flux16'], totalBytes: 1 });
  const same = { ...remote, key: 'same', repositoryGroup: primary.repositoryGroup, totalBytes: 500, tieBreakRank: 4 };
  const smaller = { ...same, key: 'smaller', totalBytes: 200, tieBreakRank: 3 };
  const tied = { ...smaller, key: 'tie', tieBreakRank: 2 };
  const wrongRole = { ...remote, key: 'wrong-role', roles: ['lm' as const], repositoryGroup: primary.repositoryGroup };
  const unverified = { ...same, key: 'unverified', classes: [], totalBytes: 1 };
  const adapter = { ...same, key: 'adapter', classes: ['vae-flux16', 'lora'], totalBytes: 1 };
  expect(chooseImageCompanion({ primary, candidates: [remote, same, smaller, wrongRole, unverified, adapter, tied], requirement })).toBe('tie');
  expect(chooseImageCompanion({ primary, candidates: [wrongRole, unverified, adapter], requirement })).toBeUndefined();
});

it('retains a compatible previous auto choice but never overrides explicit none or a pinned file', () => {
  const main = candidate({ key: 'main', family: 'z-image', roles: ['diffusion'] });
  const vae = candidate({ key: 'vae', roles: ['vae'], classes: ['vae-flux16'] });
  const smaller = { ...vae, key: 'smaller', totalBytes: 1 };
  const lm = candidate({ key: 'lm', roles: ['lm'], classes: ['lm-qwen3-4b'] });
  const candidates = [main, vae, smaller, lm];
  const retained = reconcileImageComponents({ primaryKey: 'main', candidates, choices: {}, previous: { vae: 'vae' }, recipe: undefined });
  expect(retained.components[0]?.key).toBe('vae');
  const cleared = reconcileImageComponents({ primaryKey: 'main', candidates, choices: { vae: { kind: 'none' } }, previous: { vae: 'vae' }, recipe: undefined });
  expect(cleared.missingRequiredSlots).toEqual(['vae']);
  expect(cleared.ready).toBe(false);
  const pinned = reconcileImageComponents({ primaryKey: 'main', candidates, choices: { vae: { kind: 'file', key: 'missing' } }, previous: {}, recipe: undefined });
  expect(pinned.components[0]?.key).toBe('missing');
  expect(pinned.ready).toBe(false);
});

it('honors recipes without silently substituting missing required or optional files', () => {
  const main = candidate({ key: 'main', family: 'sd-checkpoint', roles: ['model'] });
  const vae = candidate({ key: 'vae', roles: ['vae'], classes: ['vae-sd4'] });
  const candidates = [main, vae];
  const embedded = reconcileImageComponents({ primaryKey: 'main', candidates, choices: {}, previous: {}, recipe: undefined });
  expect(embedded.ready).toBe(true);
  expect(embedded.components[0]?.key).toBeUndefined();
  const missing = reconcileImageComponents({ primaryKey: 'main', candidates, choices: {}, previous: { vae: 'vae' }, recipe: { vae: '' } });
  expect(missing.ready).toBe(false);
  expect(missing.components[0]?.key).toBe('');
  const explicit = reconcileImageComponents({ primaryKey: 'main', candidates, choices: { vae: { kind: 'none' } }, previous: {}, recipe: { vae: '' } });
  expect(explicit.ready).toBe(true);
});

it('reports an incomplete composition rather than choosing an unrelated complete checkpoint', () => {
  const main = candidate({ key: 'main', family: 'z-image', roles: ['diffusion'], totalBytes: 1 });
  const checkpoint = candidate({ key: 'checkpoint', family: 'sd-checkpoint', roles: ['model'], totalBytes: 100 });
  const candidates = [main, checkpoint];
  expect(chooseInitialImagePrimary({ candidates })).toBe('main');
  expect(reconcileImageComponents({ primaryKey: 'main', candidates, choices: {}, previous: {}, recipe: undefined })).toMatchObject({ ready: false, missingRequiredSlots: ['vae', 'lm'] });
});

export const TEST_ONLY = {
};

it('does not treat a recipe as permission to use a class-matching file with the wrong role', () => {
  const main = candidate({ key: 'main', family: 'sd-checkpoint', roles: ['model'] });
  const wrongRole = candidate({ key: 'wrong', roles: ['lm'], classes: ['vae-sd4'] });
  const resolved = reconcileImageComponents({ primaryKey: 'main', candidates: [main, wrongRole], choices: {}, previous: {}, recipe: { vae: 'wrong' } });
  expect(resolved.ready).toBe(false);
  expect(resolved.components[0]?.key).toBe('');
});
