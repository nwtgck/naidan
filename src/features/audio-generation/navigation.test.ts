import { expect, it, vi } from 'vitest';
import { revealAudioGenerationSection } from './navigation';

it('opens the model management panel and focuses its summary for the existing section hash', () => {
  const target = document.createElement('details');
  target.id = 'audio-generation-models';
  const summary = document.createElement('summary');
  summary.textContent = 'Models';
  target.append(summary);
  document.body.append(target);
  using _section = {
    [Symbol.dispose]() {
      target.remove();
    },
  };
  const scrollIntoView = vi.fn();
  target.scrollIntoView = scrollIntoView;

  revealAudioGenerationSection({ hash: '#audio-generation-models', root: document });

  expect(target.open).toBe(true);
  expect(document.activeElement).toBe(summary);
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
});
