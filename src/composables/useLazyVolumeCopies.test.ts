import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { toVolumeId } from '@/01-models/ids';
import type { VolumeId } from '@/01-models/ids';
import type { LazyVolumeState } from '@/01-models/volume-access';
import { listLazyVolumeStates, publishLazyVolumeState, removeLazyVolumeState } from '@/00-storage/service/lazy-volume-state';
import { useLazyVolumeCopies } from './useLazyVolumeCopies';

const firstId = toVolumeId({ raw: 'first-copy' });
const secondId = toVolumeId({ raw: 'second-copy' });

afterEach(() => {
  for (const state of listLazyVolumeStates()) {
    removeLazyVolumeState({ volumeId: state.volume.id });
  }
});

function copyState({ volumeId, phase }: { volumeId: VolumeId, phase: LazyVolumeState['phase'] }): LazyVolumeState {
  return { volume: { id: volumeId, name: 'Docs', type: 'opfs', createdAt: 0 }, phase, progress: { processed: 0, total: 2 }, error: undefined };
}

function mountObserver({ volumeIds }: { volumeIds: VolumeId[] | undefined }) {
  const ids = volumeIds === undefined ? undefined : ref(volumeIds);
  const wrapper = mount(defineComponent({
    setup() {
      const { pendingStates } = useLazyVolumeCopies({ volumeIds: ids });
      return () => h('div', pendingStates.value.map(state => `${state.volume.name}:${state.phase}`).join(','));
    },
  }));
  return {
    wrapper,
    ids,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('useLazyVolumeCopies', () => {
  it('shares copy state across surfaces and preserves it after an observer unmounts', async () => {
    publishLazyVolumeState({ state: copyState({ volumeId: firstId, phase: 'copying' }) });
    const initial = mountObserver({ volumeIds: [firstId] });
    expect(initial.wrapper.text()).toBe('Docs:copying');
    initial.wrapper.unmount();

    publishLazyVolumeState({ state: copyState({ volumeId: firstId, phase: 'paused' }) });
    using reopened = mountObserver({ volumeIds: [firstId] });
    using settings = mountObserver({ volumeIds: undefined });
    expect(reopened.wrapper.text()).toBe('Docs:paused');
    expect(settings.wrapper.text()).toBe('Docs:paused');

    publishLazyVolumeState({ state: copyState({ volumeId: firstId, phase: 'saved' }) });
    await nextTick();
    expect(reopened.wrapper.text()).toBe('');
    expect(settings.wrapper.text()).toBe('');
  });

  it('tracks the currently displayed chat mounts without observing unrelated copies', async () => {
    publishLazyVolumeState({ state: copyState({ volumeId: firstId, phase: 'copying' }) });
    publishLazyVolumeState({ state: copyState({ volumeId: secondId, phase: 'paused' }) });
    using view = mountObserver({ volumeIds: [firstId] });
    expect(view.wrapper.text()).toBe('Docs:copying');
    if (view.ids === undefined) {
      throw new Error('Expected scoped observer');
    }
    view.ids.value = [secondId];
    await nextTick();
    expect(view.wrapper.text()).toBe('Docs:paused');
    publishLazyVolumeState({ state: copyState({ volumeId: firstId, phase: 'failed' }) });
    await nextTick();
    expect(view.wrapper.text()).toBe('Docs:paused');
    removeLazyVolumeState({ volumeId: secondId });
    await nextTick();
    expect(view.wrapper.text()).toBe('');
  });
});
