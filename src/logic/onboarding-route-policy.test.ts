import { describe, expect, it } from 'vitest';
import { isOnboardingExcludedPath } from './onboarding-route-policy';

describe('onboarding route policy', () => {
  it.each([
    '/image-generation',
    '/image-generation/models',
    '/image-generation/session/a',
    '/audio-generation',
    '/audio-generation/voices',
  ])('excludes %s and its feature area from chat onboarding', path => {
    expect(isOnboardingExcludedPath({ path })).toBe(true);
  });

  it.each([
    '/',
    '/chat/123',
    '/settings',
    '/image-generation-other',
    '/audio-generation-other',
    '/not-image-generation',
  ])('does not exclude %s', path => {
    expect(isOnboardingExcludedPath({ path })).toBe(false);
  });
});
