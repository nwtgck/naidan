import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import GeneratedImageBlock from './GeneratedImageBlock.vue';
import { storageService } from '../../services/storage';
import { useImagePreview } from '../../composables/useImagePreview';
import { ImageDownloadHydrator } from '../ImageDownloadHydrator';

// Mock storage service
vi.mock('../../services/storage', () => ({
  storageService: {
    getFile: vi.fn(),
    getBinaryObject: vi.fn(),
  }
}));

// Mock global events
vi.mock('../../composables/useGlobalEvents', () => ({
  useGlobalEvents: vi.fn().mockReturnValue({
    addErrorEvent: vi.fn(),
  })
}));

// Mock image preview composable
vi.mock('../../composables/useImagePreview', () => ({
  useImagePreview: vi.fn().mockReturnValue({
    openPreview: vi.fn(),
  })
}));

describe('GeneratedImageBlock', () => {
  const binaryObjectId = 'test-image-id';
  const blockData = {
    binaryObjectId,
    displayWidth: 400,
    displayHeight: 300,
    prompt: 'a beautiful sunset',
    steps: 25,
    seed: 42
  };
  const json = JSON.stringify(blockData);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('renders loading skeleton initially', async () => {
    // Delay storage response
    vi.mocked(storageService.getFile).mockReturnValue(new Promise(() => {}));

    const wrapper = mount(GeneratedImageBlock, {
      props: { json }
    });

    expect(wrapper.find('.naidan-image-skeleton').exists()).toBe(true);
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('renders image after loading', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));

    const wrapper = mount(GeneratedImageBlock, {
      props: { json }
    });

    await flushPromises();
    await nextTick();

    const img = wrapper.find('img.naidan-clickable-img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('blob:mock-url');
    expect(img.attributes('width')).toBe('400');
    expect(img.attributes('height')).toBe('300');
  });

  it('renders error state when image fails to load', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(null);

    const wrapper = mount(GeneratedImageBlock, {
      props: { json }
    });

    await flushPromises();
    await nextTick();

    expect(wrapper.text()).toContain('Image not found in storage');
    // More robust check for the icon, could be an SVG or a component depending on mocking
    expect(wrapper.findComponent({ name: 'AlertTriangle' }).exists() || wrapper.find('svg').exists()).toBe(true);
  });

  it('shows info and download overlays when image is loaded', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));

    const wrapper = mount(GeneratedImageBlock, {
      props: { json }
    });

    await flushPromises();
    await nextTick();

    expect(wrapper.findComponent({ name: 'ImageInfoDisplay' }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'ImageDownloadButton' }).exists()).toBe(true);

    const infoProps = wrapper.findComponent({ name: 'ImageInfoDisplay' }).props();
    expect(infoProps.prompt).toBe('a beautiful sunset');
    expect(infoProps.steps).toBe(25);
    expect(infoProps.seed).toBe(42);
  });

  it('calls ImageDownloadHydrator.download when download is triggered', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));
    const downloadSpy = vi.spyOn(ImageDownloadHydrator, 'download').mockResolvedValue(undefined as any);

    const wrapper = mount(GeneratedImageBlock, {
      props: { json }
    });

    await flushPromises();
    await nextTick();

    const downloadBtn = wrapper.findComponent({ name: 'ImageDownloadButton' });
    await downloadBtn.vm.$emit('download', { withMetadata: true });

    expect(downloadSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: binaryObjectId,
      prompt: 'a beautiful sunset',
      steps: 25,
      seed: 42,
      withMetadata: true
    }));
  });

  it('opens preview when image is clicked', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));
    const mockBinaryObj = { id: binaryObjectId, name: 'sunset.png' };
    vi.mocked(storageService.getBinaryObject).mockResolvedValue(mockBinaryObj as any);

    const wrapper = mount(GeneratedImageBlock, {
      props: { json }
    });

    await flushPromises();
    await nextTick();

    const img = wrapper.find('img.naidan-clickable-img');
    await img.trigger('click');

    const { openPreview } = useImagePreview();
    expect(openPreview).toHaveBeenCalledWith({
      objects: [mockBinaryObj],
      initialId: binaryObjectId
    });
  });

  it('detects metadata support and passes it to download button', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));
    const detectSpy = vi.spyOn(ImageDownloadHydrator, 'detectSupport').mockResolvedValue(true);

    const wrapper = mount(GeneratedImageBlock, {
      props: { json }
    });

    await flushPromises();
    await nextTick();

    expect(detectSpy).toHaveBeenCalled();
    const downloadBtn = wrapper.findComponent({ name: 'ImageDownloadButton' });
    expect(downloadBtn.props('isSupported')).toBe(true);
  });

  it('revokes URL on unmount', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));

    const wrapper = mount(GeneratedImageBlock, {
      props: { json }
    });

    await flushPromises();
    wrapper.unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('handles invalid JSON gracefully', () => {
    const wrapper = mount(GeneratedImageBlock, {
      props: { json: '{ invalid }' }
    });

    expect(wrapper.text()).toContain('Invalid Image Block Data');
  });
});
