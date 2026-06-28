export async function waitForPresentationPaint({ window }: {
  window: Pick<Window, 'requestAnimationFrame'>,
}): Promise<void> {
  /**
   * WHY: A single requestAnimationFrame callback runs before that frame paints.
   * Waiting for the following frame guarantees the browser had one paint
   * opportunity before startup resumes CPU-heavy module evaluation.
   */
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}
