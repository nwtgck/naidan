import { describe, expect, it } from 'vitest';
import type { LocationQuery } from 'vue-router';
import type { Settings } from '@/01-models/types';
import { hasModelEntryQuery, resolveAppEntryKind, shouldDeferInitialModelRefresh } from './entry-intent';

const unconfiguredSettings: Pick<Settings, 'endpoint' | 'defaultModelId'> = { endpoint: { type: 'openai', url: '' }, defaultModelId: undefined };

describe('application entry intent', () => {
  it.each([undefined, '', null, ['owner/first', 'owner/second']])('claims an explicitly present model key independently of its validity: %j', input => {
    const query: LocationQuery = input === undefined ? {} : { 'llama-cpp-browser-model': input, q: 'ignored', settings: 'connection' };
    expect(hasModelEntryQuery({ query })).toBe(input !== undefined);
    if (input !== undefined) {
      expect(resolveAppEntryKind({ route: { path: '/chat/existing', query }, initialized: true, settings: unconfiguredSettings })).toBe('model-preview');
    }
  });

  it.each([
    '/chat/existing', '/chat/123', '/chat-group/existing', '/settings', '/settings/connection',
    '/image-generation', '/image-generation/models', '/image-generation/session/a',
    '/audio-generation', '/audio-generation/voices',
    '/image-generation-other', '/audio-generation-other', '/not-image-generation',
  ])('preserves an ordinary deep link without setup and gives an explicit model intent priority: %s', path => {
    expect(resolveAppEntryKind({ route: { path, query: {} }, initialized: false, settings: unconfiguredSettings })).toBe('ordinary');
    expect(shouldDeferInitialModelRefresh({ route: { path, query: {} } })).toBe(false);
    const route = { path, query: { 'llama-cpp-browser-model': 'owner/model' } };
    expect(resolveAppEntryKind({ route, initialized: false, settings: unconfiguredSettings })).toBe('model-preview');
    expect(shouldDeferInitialModelRefresh({ route })).toBe(true);
  });

  it('waits for settings, then shows an unconfigured root home without probing readiness', () => {
    const route = { path: '/', query: {} };
    expect(resolveAppEntryKind({ route, initialized: false, settings: unconfiguredSettings })).toBe('pending');
    expect(resolveAppEntryKind({ route, initialized: true, settings: unconfiguredSettings })).toBe('home');
    expect(resolveAppEntryKind({ route, initialized: true, settings: { endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'temp/missing' } })).toBe('ordinary');
  });

  it('keeps explicit home and prompt navigation distinct from automatic root routing', () => {
    const settings = { endpoint: { type: 'llama_cpp_browser' as const }, defaultModelId: 'chosen' };
    expect(resolveAppEntryKind({ route: { path: '/home', query: {} }, initialized: true, settings })).toBe('home');
    expect(resolveAppEntryKind({ route: { path: '/', query: { q: 'draft' } }, initialized: true, settings: unconfiguredSettings })).toBe('ordinary');
  });
});
