import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, h, nextTick, ref, type Ref } from 'vue';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { profileSchema, type RuntimeOptions } from '@/features/llama-cpp-browser/types';
import type { ProfileCapabilities, ProfileState } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { scheduleIdleTask } from '@/utils/idle-task';
import { useFirefoxWebGpuWarning } from './useFirefoxWebGpuWarning';

const service = vi.hoisted(() => ({
  subscribeOptions: vi.fn<LlamaCppBrowserService['subscribeOptions']>(),
  subscribeProfiles: vi.fn<LlamaCppBrowserService['subscribeProfiles']>(),
  probeProfiles: vi.fn<LlamaCppBrowserService['probeProfiles']>(),
  prepareModel: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: service }));
vi.mock('@/utils/idle-task', () => ({ scheduleIdleTask: vi.fn(() => ({ cancel: vi.fn() })) }));

type OptionsListener = Parameters<LlamaCppBrowserService['subscribeOptions']>[0]['listener'];
type ProfileListener = Parameters<LlamaCppBrowserService['subscribeProfiles']>[0]['listener'];
const optionsListeners = new Set<OptionsListener>();
const profileListeners = new Set<ProfileListener>();
let options: RuntimeOptions;
let profileState: ProfileState;
const wrappers: VueWrapper[] = [];
const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0';

function capabilities({ recommended }: { recommended: ProfileCapabilities['recommended'] }): ProfileCapabilities {
  return { recommended, profiles: profileSchema.options.map(profile => ({ profile, status: 'available' })) };
}

function publishProfiles({ state }: { state: ProfileState }): void {
  profileState = state;
  for (const listener of profileListeners) listener({ state });
}

function publishOptions({ profile }: { profile: RuntimeOptions['profile'] }): void {
  options = { profile };
  for (const listener of optionsListeners) listener({ options });
}

function mountWarning({ enabled }: { enabled: Ref<boolean> }): VueWrapper {
  const wrapper = mount(defineComponent({
    setup() {
      const warning = useFirefoxWebGpuWarning({ enabled: computed(() => enabled.value) });
      return () => h('div', { 'data-visible': warning.visible.value });
    },
  }));
  wrappers.push(wrapper);
  return wrapper;
}

async function runScheduledProbe(): Promise<void> {
  await nextTick();
  const call = vi.mocked(scheduleIdleTask).mock.calls.at(-1);
  if (!call) throw new Error('Expected a scheduled capability probe');
  await call[0].task();
  await nextTick();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(firefox);
  options = { profile: 'auto' };
  profileState = { status: 'idle' };
  service.subscribeOptions.mockImplementation(({ listener }) => {
    optionsListeners.add(listener); listener({ options });
    return () => {
      optionsListeners.delete(listener);
    };
  });
  service.subscribeProfiles.mockImplementation(({ listener }) => {
    profileListeners.add(listener); listener({ state: profileState });
    return () => {
      profileListeners.delete(listener);
    };
  });
  service.probeProfiles.mockImplementation(async () => {
    const report = capabilities({ recommended: 'webgpu-wasm32-asyncify' });
    publishProfiles({ state: { status: 'checking' } });
    publishProfiles({ state: { status: 'ready', capabilities: report } });
    return report;
  });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  expect(optionsListeners.size).toBe(0);
  expect(profileListeners.size).toBe(0);
  expect(service.prepareModel).not.toHaveBeenCalled();
  expect(service.generate).not.toHaveBeenCalled();
  expect(service.cancel).not.toHaveBeenCalled();
  expect(service.release).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useFirefoxWebGpuWarning', () => {
  it('does not observe or probe disabled contexts', async () => {
    const wrapper = mountWarning({ enabled: ref(false) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(service.subscribeOptions).not.toHaveBeenCalled();
    expect(service.subscribeProfiles).not.toHaveBeenCalled();
    expect(scheduleIdleTask).not.toHaveBeenCalled();
  });

  it.each(['Chrome/155.0', 'FxiOS/155.0'])('does not probe or subscribe for %s', async userAgent => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(service.subscribeOptions).not.toHaveBeenCalled();
    expect(service.subscribeProfiles).not.toHaveBeenCalled();
    expect(scheduleIdleTask).not.toHaveBeenCalled();
  });

  it('does not require navigator in a non-browser environment', async () => {
    vi.stubGlobal('navigator', undefined);
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(service.subscribeOptions).not.toHaveBeenCalled();
  });

  it('yields initial rendering and waits for a confirmed auto profile', async () => {
    const wrapper = mountWarning({ enabled: ref(true) });
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(service.probeProfiles).not.toHaveBeenCalled();
    await runScheduledProbe();
    expect(service.probeProfiles).toHaveBeenCalledOnce();
    expect(wrapper.attributes('data-visible')).toBe('true');
  });

  it.each(['cpu-wasm32', 'cpu-wasm64'] as const)('does not probe an explicit %s preference', async profile => {
    options = { profile };
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(scheduleIdleTask).not.toHaveBeenCalled();
    // Still observes preferences so a later WebGPU choice is reflected.
    expect(service.subscribeOptions).toHaveBeenCalledOnce();
  });

  it.each(profileSchema.options)('uses the ready auto recommendation %s', async profile => {
    profileState = { status: 'ready', capabilities: capabilities({ recommended: profile }) };
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe(String(profile.startsWith('webgpu-')));
    expect(scheduleIdleTask).not.toHaveBeenCalled();
    expect(service.probeProfiles).not.toHaveBeenCalled();
  });

  it.each(profileSchema.options)('respects explicit %s instead of the auto recommendation', async profile => {
    options = { profile };
    profileState = { status: 'ready', capabilities: capabilities({ recommended: 'cpu-wasm32' }) };
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe(String(profile.startsWith('webgpu-')));
  });

  it('suppresses an unavailable explicit WebGPU profile rather than treating it as a CPU fallback', async () => {
    options = { profile: 'webgpu-wasm64-jspi' };
    profileState = {
      status: 'ready',
      capabilities: {
        recommended: 'cpu-wasm32',
        profiles: [
          { profile: 'webgpu-wasm64-jspi', status: 'unavailable', reason: 'jspi' },
          { profile: 'cpu-wasm32', status: 'available' },
        ],
      },
    };
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(service.probeProfiles).not.toHaveBeenCalled();
  });

  it('uses a standalone report without assuming hosted CPU or Asyncify availability', async () => {
    profileState = {
      status: 'ready',
      capabilities: {
        recommended: 'webgpu-wasm32-jspi',
        profiles: [{ profile: 'webgpu-wasm32-jspi', status: 'available' }],
      },
    };
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('true');
    publishOptions({ profile: 'webgpu-wasm32-asyncify' });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
  });

  it.each<ProfileState>([
    { status: 'checking' },
    { status: 'error', code: 'worker-failed' },
    { status: 'ready', capabilities: { recommended: undefined, profiles: [] } },
  ])('does not guess or retry from $status support', async state => {
    profileState = state;
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(scheduleIdleTask).not.toHaveBeenCalled();
    expect(service.probeProfiles).not.toHaveBeenCalled();
  });

  it('observes an already running probe without starting a second one', async () => {
    profileState = { status: 'checking' };
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    publishProfiles({ state: { status: 'ready', capabilities: capabilities({ recommended: 'webgpu-wasm32-asyncify' }) } });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('true');
    expect(service.probeProfiles).not.toHaveBeenCalled();
  });

  it('rechecks shared state before a scheduled task to avoid redundant work', async () => {
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    publishProfiles({ state: { status: 'ready', capabilities: capabilities({ recommended: 'cpu-wasm64' }) } });
    await runScheduledProbe();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(service.probeProfiles).not.toHaveBeenCalled();
  });

  it('updates immediately when shared options change between WebGPU, CPU and auto', async () => {
    profileState = { status: 'ready', capabilities: capabilities({ recommended: 'webgpu-wasm32-asyncify' }) };
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('true');
    publishOptions({ profile: 'cpu-wasm32' });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    publishOptions({ profile: 'webgpu-wasm32-jspi' });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('true');
    publishOptions({ profile: 'auto' });
    publishProfiles({ state: { status: 'ready', capabilities: capabilities({ recommended: 'cpu-wasm32' }) } });
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(service.probeProfiles).not.toHaveBeenCalled();
  });

  it('starts one deferred check when changing an unprobed CPU preference to auto', async () => {
    options = { profile: 'cpu-wasm32' };
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    expect(scheduleIdleTask).not.toHaveBeenCalled();
    publishOptions({ profile: 'auto' });
    await runScheduledProbe();
    expect(wrapper.attributes('data-visible')).toBe('true');
    expect(service.probeProfiles).toHaveBeenCalledOnce();
  });

  it('cancels pending idle work when the context or profile no longer needs it', async () => {
    const enabled = ref(true);
    mountWarning({ enabled });
    await nextTick();
    const idle = vi.mocked(scheduleIdleTask).mock.results[0]?.value;
    enabled.value = false;
    await runScheduledProbe();
    expect(idle?.cancel).toHaveBeenCalledOnce();
    expect(service.probeProfiles).not.toHaveBeenCalled();
    expect(optionsListeners.size).toBe(0);
    expect(profileListeners.size).toBe(0);
    enabled.value = true;
    await nextTick();
    publishOptions({ profile: 'cpu-wasm32' });
    await runScheduledProbe();
    expect(service.probeProfiles).not.toHaveBeenCalled();
  });

  it('detaches an in-flight observer and ignores late results after leaving the chat context', async () => {
    const gate = Promise.withResolvers<ProfileCapabilities>();
    service.probeProfiles.mockReturnValue(gate.promise);
    const enabled = ref(true);
    const wrapper = mountWarning({ enabled });
    await nextTick();
    const task = vi.mocked(scheduleIdleTask).mock.calls[0]?.[0].task();
    const signal = service.probeProfiles.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    enabled.value = false;
    await nextTick();
    expect(signal?.aborted).toBe(true);
    const report = capabilities({ recommended: 'webgpu-wasm32-asyncify' });
    publishProfiles({ state: { status: 'ready', capabilities: report } });
    gate.resolve(report);
    await task;
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
    // A different eligible chat can reuse the shared report without a new probe.
    enabled.value = true;
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('true');
    expect(service.probeProfiles).toHaveBeenCalledOnce();
  });

  it('does not publish a stale Promise result over the current service state', async () => {
    const gate = Promise.withResolvers<ProfileCapabilities>();
    service.probeProfiles.mockReturnValue(gate.promise);
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    const task = vi.mocked(scheduleIdleTask).mock.calls[0]?.[0].task();
    publishProfiles({ state: { status: 'ready', capabilities: capabilities({ recommended: 'cpu-wasm32' }) } });
    gate.resolve(capabilities({ recommended: 'webgpu-wasm32-asyncify' }));
    await task;
    await nextTick();
    expect(wrapper.attributes('data-visible')).toBe('false');
  });

  it('keeps failed probes silent and does not retry on reactive updates', async () => {
    service.probeProfiles.mockImplementation(async () => {
      publishProfiles({ state: { status: 'error', code: 'unavailable' } });
      throw new Error('unavailable');
    });
    const wrapper = mountWarning({ enabled: ref(true) });
    await runScheduledProbe();
    await flushPromises();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(service.probeProfiles).toHaveBeenCalledOnce();
    expect(scheduleIdleTask).toHaveBeenCalledOnce();
  });

  it('hides invalidated support without reviving a released Worker', async () => {
    const wrapper = mountWarning({ enabled: ref(true) });
    await runScheduledProbe();
    expect(wrapper.attributes('data-visible')).toBe('true');
    publishProfiles({ state: { status: 'idle' } });
    await flushPromises();
    expect(wrapper.attributes('data-visible')).toBe('false');
    expect(service.probeProfiles).toHaveBeenCalledOnce();
    expect(scheduleIdleTask).toHaveBeenCalledOnce();
  });

  it('aborts only the observer and unsubscribes on unmount', async () => {
    const gate = Promise.withResolvers<ProfileCapabilities>();
    service.probeProfiles.mockReturnValue(gate.promise);
    const wrapper = mountWarning({ enabled: ref(true) });
    await nextTick();
    const task = vi.mocked(scheduleIdleTask).mock.calls[0]?.[0].task();
    const signal = service.probeProfiles.mock.calls[0]?.[0].signal;
    wrapper.unmount();
    expect(signal?.aborted).toBe(true);
    expect(optionsListeners.size).toBe(0);
    expect(profileListeners.size).toBe(0);
    gate.resolve(capabilities({ recommended: 'webgpu-wasm32-asyncify' }));
    await task;
  });
});
