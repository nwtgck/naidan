import { watch, type Ref } from 'vue';

export function waitUntilOnboardingDismissed({ isOnboardingDismissed }: {
  isOnboardingDismissed: Readonly<Ref<boolean>>,
}): Promise<void> {
  if (isOnboardingDismissed.value) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const stop = watch(
      isOnboardingDismissed,
      (dismissed) => {
        if (!dismissed) return;
        stop();
        resolve();
      },
      { flush: 'sync' },
    );
  });
}

export async function waitForTwoAnimationFrames({ window }: {
  window: Pick<Window, 'requestAnimationFrame'>,
}): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}
