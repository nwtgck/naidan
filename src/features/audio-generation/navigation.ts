// Keep existing section URLs working when opened directly or from browser history.
export function revealAudioGenerationSection({ hash, root }: { hash: string, root: ParentNode }): void {
  if (hash !== '#audio-generation-input' && hash !== '#audio-generation-models' && hash !== '#audio-generation-results') {
    return;
  }
  const target = root.querySelector<HTMLElement>(hash);
  if (target === null) {
    return;
  }
  if (target instanceof HTMLDetailsElement) {
    target.open = true;
    target.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
  } else {
    target.focus({ preventScroll: true });
  }
  target.scrollIntoView?.({ block: 'start' });
}

export const TEST_ONLY = {
};
