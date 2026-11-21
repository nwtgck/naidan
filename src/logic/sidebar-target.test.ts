import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type LocationQuery } from 'vue-router';
import { resolveInitialRoute } from '@/logic/startup/startup-route';
import { resolveSidebarTarget } from './sidebar-target';

describe('sidebar target', () => {
  it.each([
    ['/', 'chat'],
    ['/chat/current', 'chat'],
    ['/chat-group/research', 'chat'],
    ['/image-generation', 'image_generation'],
    ['/image-generation/session/current', 'image_generation'],
    ['/image-generation/models', 'image_generation'],
    ['/image-generation/diagnostics', 'image_generation'],
    ['/live-conversation', 'live_conversation'],
    ['/live-conversation/diagnostics/transcription', 'live_conversation'],
    ['/translation', 'translation'],
    ['/translation/models/', 'translation'],
    ['/workflows', 'workflow'],
    ['/workflows/runs/current', 'workflow'],
    ['/audio-generation', 'audio_generation'],
    ['/audio-transcription', 'audio_transcription'],
    ['/audio-transcription/files', 'audio_transcription'],
    ['/audio-transcription/files/', 'audio_transcription'],
    ['/debug', 'developer_tools'],
    ['/debug/standalone', 'developer_tools'],
    ['/llama-cpp-browser/diagnostics', 'developer_tools'],
    ['/settings', 'settings'],
    ['/settings/connection', 'settings'],
  ] as const)('selects the family of %s without requiring a mounted workspace', (path, target) => {
    expect(resolveSidebarTarget({ route: { path, params: {}, query: {} }, entryKind: 'ordinary' })).toBe(target);
  });

  it.each(['pending', 'home', 'ordinary', 'model-preview'] as const)('waits when no effective route is available for %s', entryKind => {
    expect(resolveSidebarTarget({ route: undefined, entryKind })).toBe('pending');
  });

  it.each(['pending', 'home'] as const)('uses the resolved feature route while the entry kind is still %s', entryKind => {
    expect(resolveSidebarTarget({ route: { path: '/image-generation/models', params: {}, query: {} }, entryKind })).toBe('image_generation');
  });

  it.each([
    '/image-generation-other', '/live-conversation-old', '/translation-tools',
    '/workflows-backup', '/audio-generation-other', '/audio-transcription-other', '/chatroom', '/chat-groups',
    '/debugging', '/llama-cpp-browser/diagnostics-other', '/settings-old', '/unknown',
  ])('does not claim the unrelated route %s by its prefix', path => {
    expect(resolveSidebarTarget({ route: { path, params: {}, query: {} }, entryKind: 'ordinary' })).toBe('recovery');
  });

  it('gives the entry controller model preview priority over the original destination', () => {
    expect(resolveSidebarTarget({ route: { path: '/translation/models', params: {}, query: {} }, entryKind: 'model-preview' })).toBe('model_preview');
  });

  it.each([{ input: 'owner/model' }, { input: '' }, { input: null }, { input: ['owner/first', 'owner/second'] }] satisfies { input: LocationQuery[string] }[])('gives an explicitly present model query priority over recovery and settings: %j', ({ input }) => {
    const route = { path: '/image-generation/unknown', params: { path: ['image-generation', 'unknown'] }, query: { 'llama-cpp-browser-model': input, settings: 'connection' } };
    expect(resolveSidebarTarget({ route, entryKind: 'ordinary' })).toBe('model_preview');
  });

  it('uses the resolved query after the router omits an absent model value', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/audio-generation', component: { template: '<div />' } }] });
    const route = router.resolve({ path: '/audio-generation', query: { 'llama-cpp-browser-model': undefined } });
    expect(route.query).not.toHaveProperty('llama-cpp-browser-model');
    expect(resolveSidebarTarget({ route, entryKind: 'ordinary' })).toBe('audio_generation');
  });

  it.each(['/image-generation/unknown', '/audio-transcription/unknown', '/debug/unknown', '/settings/unknown', '/chat/unknown/extra'])('prefers the resolved catch-all over the apparent family of %s', path => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:path(.*)*', component: { template: '<div />' } }],
    });
    const route = router.resolve(path);
    expect('path' in route.params).toBe(true);
    expect(resolveSidebarTarget({ route, entryKind: 'ordinary' })).toBe('recovery');
  });

  it.each([
    ['/live-conversation/diagnostics/transcription', 'live_conversation'],
    ['/audio-transcription/files', 'audio_transcription'],
  ] as const)('selects the initial %s deep link before navigation or its lazy page starts', (path, target) => {
    const history = createMemoryHistory();
    history.replace(`${path}?settings=connection`);
    const loadPage = vi.fn(async () => ({ template: '<div />' }));
    const router = createRouter({ history, routes: [{ path, component: loadPage }] });
    const route = resolveInitialRoute({ router });
    expect(router.currentRoute.value.matched).toHaveLength(0);
    expect(resolveSidebarTarget({ route, entryKind: 'pending' })).toBe(target);
    expect(loadPage).not.toHaveBeenCalled();
  });

  it.each([
    ['/chat/current', 'chat'], ['/image-generation/models', 'image_generation'],
    ['/live-conversation', 'live_conversation'], ['/debug/standalone', 'developer_tools'],
    ['/audio-transcription/files', 'audio_transcription'],
  ] as const)('keeps the underlying family when query settings open on %s', (path, target) => {
    expect(resolveSidebarTarget({ route: { path, params: {}, query: { settings: 'developer' } }, entryKind: 'ordinary' })).toBe(target);
  });
});
