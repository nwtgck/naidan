import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_ENDPOINT, type Settings } from '@/01-models/types';
import type { useSettings } from '@/composables/useSettings';
import { useFileExplorerPaneWidth } from './useFileExplorerPaneWidth';

const { settingsStore } = vi.hoisted(() => ({ settingsStore: vi.fn() }));
vi.mock('@/composables/useSettings', () => ({ useSettings: settingsStore }));

let generation: number;
const defaultSettings: Settings = { ...DEFAULT_SETTINGS, endpoint: DEFAULT_SETTINGS_ENDPOINT, storageType: 'memory' };
const settings = shallowRef<Settings>(defaultSettings);
const initialized = ref(true);
const update = vi.fn<ReturnType<typeof useSettings>['updateExperimentalForStorage']>();

beforeEach(() => {
  vi.useFakeTimers();
  generation = 0;
  settings.value = { ...defaultSettings, experimental: { fileExplorer: { previewWidthPx: 360, treeWidthPx: 250, wordWrap: 'wrap' } } };
  update.mockReset().mockImplementation(async ({ isCurrent, updater }) => {
    if (!isCurrent()) {
      return 'changed';
    }
    settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
    return 'saved';
  });
  settingsStore.mockReturnValue({
    settings,
    initialized,
    captureExperimentalStorage: () => {
      const captured = generation;
      return () => generation === captured;
    },
    updateExperimentalForStorage: update,
  });
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

function mountPane({ preference }: { preference: 'previewWidthPx' | 'treeWidthPx' }) {
  const scope = effectScope();
  const panel = shallowRef<HTMLElement | null>(null);
  const pane = scope.run(() => useFileExplorerPaneWidth({ panel, preference }))!;
  return {
    panel,
    pane,
    [Symbol.dispose]() {
      scope.stop();
    },
  };
}

function pointer({ target, clientX }: { target: HTMLElement, clientX: number }): PointerEvent {
  const event = new MouseEvent('pointer', { button: 0, clientX, cancelable: true });
  Object.defineProperties(event, { currentTarget: { value: target }, pointerId: { value: 1 } });
  return event as PointerEvent;
}

describe('File Explorer pane preferences', () => {
  it('loads both widths, saves a completed drag once, and restores the result in a new pane', async () => {
    using preview = mountPane({ preference: 'previewWidthPx' });
    using tree = mountPane({ preference: 'treeWidthPx' });
    expect(preview.pane.width.value).toBe(360);
    expect(tree.pane.width.value).toBe(250);
    const target = document.createElement('div');
    preview.pane.start({ event: pointer({ target, clientX: 500 }) });
    preview.pane.move({ event: pointer({ target, clientX: 440 }) });
    preview.pane.move({ event: pointer({ target, clientX: 430 }) });
    expect(preview.pane.width.value).toBe(430);
    expect(update).not.toHaveBeenCalled();
    preview.pane.end({ event: pointer({ target, clientX: 430 }), finish: 'save' });
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledOnce();
    expect(settings.value.experimental?.fileExplorer).toEqual({ previewWidthPx: 430, treeWidthPx: 250, wordWrap: 'wrap' });
    using reopened = mountPane({ preference: 'previewWidthPx' });
    expect(reopened.pane.width.value).toBe(430);
  });

  it('debounces keyboard input and keeps a stored width while the container temporarily clamps it', async () => {
    using tree = mountPane({ preference: 'treeWidthPx' });
    const press = () => tree.pane.onKeydown({ event: new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }) });
    press();
    press();
    expect(tree.pane.width.value).toBe(298);
    expect(update).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledOnce();
    const container = document.createElement('div');
    container.appendChild(document.createElement('aside'));
    Object.defineProperty(container, 'clientWidth', { value: 500 });
    tree.panel.value = container.firstElementChild as HTMLElement;
    await nextTick();
    expect(tree.pane.width.value).toBe(225);
    press();
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledOnce();
    expect(settings.value.experimental?.fileExplorer?.treeWidthPx).toBe(298);
    tree.panel.value = null;
    await nextTick();
    expect(tree.pane.width.value).toBe(298);
  });

  it('discards a cancelled drag and a queued key adjustment after settings storage switches', async () => {
    using preview = mountPane({ preference: 'previewWidthPx' });
    const target = document.createElement('div');
    preview.pane.start({ event: pointer({ target, clientX: 500 }) });
    preview.pane.move({ event: pointer({ target, clientX: 430 }) });
    preview.pane.end({ event: pointer({ target, clientX: 430 }), finish: 'cancel' });
    expect(preview.pane.width.value).toBe(360);
    expect(update).not.toHaveBeenCalled();
    preview.pane.onKeydown({ event: new KeyboardEvent('keydown', { key: 'ArrowLeft' }) });
    expect(preview.pane.width.value).toBe(384);
    generation += 1;
    settings.value = { ...defaultSettings, experimental: { fileExplorer: { previewWidthPx: 510 } } };
    expect(preview.pane.width.value).toBe(510);
    await vi.runAllTimersAsync();
    expect(settings.value.experimental?.fileExplorer?.previewWidthPx).toBe(510);
  });

  it('restores the stored width after an error and accepts another adjustment', async () => {
    using preview = mountPane({ preference: 'previewWidthPx' });
    update.mockRejectedValueOnce(new Error('Write failed'));
    const press = () => preview.pane.onKeydown({ event: new KeyboardEvent('keydown', { key: 'ArrowLeft' }) });
    press();
    expect(preview.pane.width.value).toBe(384);
    await vi.runAllTimersAsync();
    expect(preview.pane.width.value).toBe(360);
    press();
    await vi.runAllTimersAsync();
    expect(settings.value.experimental?.fileExplorer?.previewWidthPx).toBe(384);
  });
});
