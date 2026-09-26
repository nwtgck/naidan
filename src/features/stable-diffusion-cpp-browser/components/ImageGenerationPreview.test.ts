import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/stable-diffusion-cpp-browser/use-image-generation-standalone';
import type { PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';
import ImageGenerationPreview from './ImageGenerationPreview.vue';

let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals();
});

function openPreview({ width = 32, height = 32, mode = 'projection', maxEdge = 256 }: {
  width?: number, height?: number, mode?: PreviewFrame['mode'], maxEdge?: number,
} = {}) {
  // Use the view-only facade with synthetic frame metadata. No native inference.
  const view = { ...useImageGeneration(), supported: computed(() => true), busy: computed(() => true) };
  view.parameters.value.width = 512; view.parameters.value.height = 512;
  view.preview.value = { ...view.preview.value, enabled: true, maxEdge };
  view.livePreview.value = { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 2, steps: 8,
    mode, width, height, url: 'blob:original-small-preview', id: 1 };
  wrapper = mount(ImageGenerationPreview, { props: { view } });
  return { view, wrapper };
}

it.each([
  { width: 32, height: 32, displayWidth: 256, displayHeight: 256 },
  { width: 32, height: 16, displayWidth: 256, displayHeight: 128 },
  { width: 16, height: 32, displayWidth: 128, displayHeight: 256 },
])('displays a $width × $height projection at the configured size without changing its pixels or URL', ({ width, height, displayWidth, displayHeight }) => {
  const { view, wrapper } = openPreview({ width, height });
  const image = wrapper.get('[data-testid="image-live-preview"] img');
  expect(image.attributes('width')).toBe(String(displayWidth));
  expect(image.attributes('height')).toBe(String(displayHeight));
  expect(image.attributes('src')).toBe('blob:original-small-preview');
  expect(view.livePreview.value).toMatchObject({ width, height });
  expect(wrapper.get('figcaption').text()).toContain(`${width} × ${height}`);
});

it('changes presentation immediately while busy and preserves explicit native-size display', async () => {
  const { wrapper, view } = openPreview({ width: 32, height: 16 });
  const size = wrapper.get('[data-testid="image-preview-size"]');
  expect(size.element.matches(':disabled')).toBe(false);
  await size.setValue(128);
  expect(wrapper.get('[data-testid="image-live-preview"] img').attributes('width')).toBe('128');
  await size.setValue(512);
  expect(wrapper.get('[data-testid="image-live-preview"] img').attributes('width')).toBe('512');
  await size.setValue(0);
  expect(wrapper.get('[data-testid="image-live-preview"] img').attributes('width')).toBe('32');
  expect(wrapper.get('[data-testid="image-live-preview"] img').attributes('height')).toBe('16');
  expect(view.livePreview.value?.url).toBe('blob:original-small-preview');
});

it.each([
  { width: 128, height: 64, expectedWidth: 128, expectedHeight: 64 },
  { width: 512, height: 256, expectedWidth: 256, expectedHeight: 128 },
])('keeps detailed decoder output within its native size and the display cap', ({ width, height, expectedWidth, expectedHeight }) => {
  const { wrapper } = openPreview({ width, height, mode: 'vae' });
  const image = wrapper.get('[data-testid="image-live-preview"] img');
  expect(image.attributes('width')).toBe(String(expectedWidth));
  expect(image.attributes('height')).toBe(String(expectedHeight));
});

it('sizes saved projection thumbnails too, while leaving the download link and metadata unchanged', async () => {
  const { view, wrapper } = openPreview({ width: 16, height: 32 });
  view.previewSnapshots.value = [{ ...view.livePreview.value!, id: 2, url: 'blob:saved-small-preview' }];
  await wrapper.vm.$nextTick();
  const snapshot = wrapper.get('[data-testid="image-preview-snapshot"]');
  expect(snapshot.get('img').attributes('width')).toBe('128');
  expect(snapshot.get('img').attributes('height')).toBe('256');
  expect(snapshot.get('a').attributes('href')).toBe('blob:saved-small-preview');
  expect(view.previewSnapshots.value[0]).toMatchObject({ width: 16, height: 32 });
});

it('defaults history ON without starting preview, and preserves an explicit opt-out across ON/OFF toggles', async () => {
  const view = { ...useImageGeneration(), supported: computed(() => true) };
  wrapper = mount(ImageGenerationPreview, { props: { view } });
  expect(view.preview.value.enabled).toBe(false);
  expect(view.keepPreviews.value).toBe(true);
  await wrapper.get('[data-testid="image-preview-enabled"]').setValue(true);
  expect(view.keepPreviews.value).toBe(true);
  await wrapper.get('[data-testid="image-keep-previews"]').setValue(false);
  await wrapper.get('[data-testid="image-preview-enabled"]').setValue(false);
  await wrapper.get('[data-testid="image-preview-enabled"]').setValue(true);
  expect(view.keepPreviews.value).toBe(false);
});
