import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  waitForTwoAnimationFrames,
  waitUntilOnboardingDismissed,
} from './onboarding-wait';

describe('onboarding startup waits', () => {
  it('resolves immediately when onboarding is already dismissed', async () => {
    await expect(waitUntilOnboardingDismissed({
      isOnboardingDismissed: ref(true),
    })).resolves.toBeUndefined();
  });

  it('resolves when the existing onboarding state becomes dismissed', async () => {
    const isOnboardingDismissed = ref(false);
    const completed = waitUntilOnboardingDismissed({ isOnboardingDismissed });

    isOnboardingDismissed.value = true;

    await expect(completed).resolves.toBeUndefined();
  });

  it('waits for two animation frames before resolving preview work', async () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const completed = waitForTwoAnimationFrames({
      window: { requestAnimationFrame },
    });

    expect(callbacks).toHaveLength(1);
    callbacks.shift()!(0);
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!(0);

    await expect(completed).resolves.toBeUndefined();
  });
});
