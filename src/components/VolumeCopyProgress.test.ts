import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { toVolumeId } from '@/01-models/ids';
import type { LazyVolumeState } from '@/01-models/volume-access';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import VolumeCopyProgress from './VolumeCopyProgress.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function state({ phase }: { phase: LazyVolumeState['phase'] }): LazyVolumeState {
  return {
    volume: { id: toVolumeId({ raw: 'copy-volume' }), name: 'Project', type: 'opfs', createdAt: 0 },
    phase,
    progress: { processed: 1, total: 4 },
    error: phase === 'failed' ? 'Storage is full' : undefined,
  };
}

function mountProgress({ phase }: { phase: LazyVolumeState['phase'] }) {
  const wrapper = mount(VolumeCopyProgress, { props: { state: state({ phase }) } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('VolumeCopyProgress', () => {
  it('keeps availability separate from unfinished storage and pauses without removing the volume', async () => {
    using view = mountProgress({ phase: 'copying' });
    expect(view.wrapper.text()).toContain('You can use this folder now');
    expect(view.wrapper.text()).toContain('not finished yet');
    expect(view.wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('1');
    expect(view.wrapper.get('[role="progressbar"]').attributes('aria-valuemax')).toBe('4');
    await view.wrapper.get('[data-testid="copy-pause-btn"]').trigger('click');
    expect(view.wrapper.emitted('pause')).toEqual([[]]);
    expect(view.wrapper.emitted('resume')).toBeUndefined();
    expect(view.wrapper.find('[data-testid="copy-cancel-btn"]').exists()).toBe(false);
  });

  it('explains that an in-flight file finishes and allows background copying to resume', async () => {
    using view = mountProgress({ phase: 'paused' });
    expect(view.wrapper.text()).toContain('currently being copied will finish before pausing');
    await view.wrapper.get('[data-testid="copy-resume-btn"]').trigger('click');
    expect(view.wrapper.emitted('resume')).toEqual([[]]);
    expect(view.wrapper.emitted('pause')).toBeUndefined();
  });

  it('retains a failed copy with its error and offers retry', async () => {
    using view = mountProgress({ phase: 'failed' });
    expect(view.wrapper.text()).toContain('Could not copy "Project"');
    expect(view.wrapper.text()).toContain('Storage is full');
    await view.wrapper.get('[data-testid="copy-retry-btn"]').trigger('click');
    expect(view.wrapper.emitted('resume')).toEqual([[]]);
  });

  it('removes unfinished-copy controls once the volume is saved', () => {
    using view = mountProgress({ phase: 'saved' });
    expect(view.wrapper.find('[data-testid="copy-progress"]').exists()).toBe(false);
  });
});
