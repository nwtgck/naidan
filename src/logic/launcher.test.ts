import { beforeEach, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { launcherEntries, selectLauncherEntries } from './launcher';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('offers Chat first, six feature routes and three unavailable features without a dubbing entry', () => {
  const available = selectLauncherEntries({ category: 'all', query: '', unimplementedLauncherEntries: 'hide' });
  expect(available.map(entry => entry.destination)).toEqual([
    { kind: 'chat' },
    { kind: 'route', path: '/translation' },
    { kind: 'route', path: '/image-generation' },
    { kind: 'route', path: '/audio-generation' },
    { kind: 'route', path: '/live-conversation' },
    { kind: 'route', path: '/workflows' },
    { kind: 'route', path: '/audio-transcription' },
  ]);
  const all = selectLauncherEntries({ category: 'all', query: '', unimplementedLauncherEntries: 'show' });
  expect(all).toHaveLength(10);
  const unavailable = all.filter(entry => entry.destination.kind === 'unimplemented');
  expect(unavailable).toHaveLength(3);
  expect(unavailable.every(entry => !('path' in entry.destination))).toBe(true);
  expect(selectLauncherEntries({ category: 'all', query: 'dubbing', unimplementedLauncherEntries: 'show' })).toEqual([]);
  expect(selectLauncherEntries({ category: 'all', query: 'dictation', unimplementedLauncherEntries: 'hide' }).map(entry => entry.destination)).toEqual([{ kind: 'route', path: '/audio-transcription' }]);
});

it('filters category and case-insensitive title/description search without ranking the curated order', () => {
  expect(selectLauncherEntries({ category: 'write', query: '', unimplementedLauncherEntries: 'show' })).toEqual([launcherEntries[0], launcherEntries[1], launcherEntries[4], launcherEntries[6]]);
  expect(selectLauncherEntries({ category: 'all', query: '  VOICE  ', unimplementedLauncherEntries: 'show' })).toEqual([launcherEntries[3], launcherEntries[4], launcherEntries[9]]);
  expect(selectLauncherEntries({ category: 'all', query: 'VOICE', unimplementedLauncherEntries: 'hide' })).toEqual([launcherEntries[3], launcherEntries[4]]);
  expect(selectLauncherEntries({ category: 'write', query: 'voice', unimplementedLauncherEntries: 'show' })).toEqual([launcherEntries[4]]);
  expect(selectLauncherEntries({ category: 'edit', query: 'voice', unimplementedLauncherEntries: 'show' })).toEqual([]);
});

it('finds image generation by its English alias in the Japanese UI regardless of case', async () => {
  await ensureAllStringsForTest({ locale: 'ja' });
  const image = launcherEntries.find(entry => entry.destination.kind === 'route' && entry.destination.path === '/image-generation');
  expect(image).toBeDefined();
  expect(image?.title()?.toLowerCase()).not.toContain('image');
  for (const query of ['image', 'IMAGE']) {
    expect(selectLauncherEntries({ category: 'all', query, unimplementedLauncherEntries: 'show' })).toEqual([image]);
  }
});
