import { vi } from 'vitest';

/** Real Node Blob URLs, but controlled DOM decode/canvas operations (not a browser codec). */
export function createImageElementPlatform({ completion }: { completion: 'decode' | 'events' }) {
  const live = new Map<string, Blob>();
  const created: Array<{ url: string, blob: Blob }> = [];
  const createURL = URL.createObjectURL.bind(URL);
  const revokeURL = URL.revokeObjectURL.bind(URL);
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    if (!(blob instanceof Blob)) throw new TypeError('Expected a native Blob, not MediaSource');
    const url = createURL(blob);
    live.set(url, blob); created.push({ url, blob }); return url;
  });
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => {
    live.delete(url); revokeURL(url);
  });
  const decoded = vi.fn(async () => {});
  const elements: TestImage[] = [];
  class TestImage extends EventTarget {
    naturalWidth = 2;
    naturalHeight = 1;
    // Layout dimensions deliberately do not match intrinsic dimensions.
    width = 500;
    height = 250;
    pixels = new Uint8ClampedArray([10, 20, 30, 255, 90, 80, 70, 0]);
    private url = '';
    decode: (() => Promise<void>) | undefined = (() => {
      switch (completion) {
      case 'decode': return decoded;
      case 'events': return undefined;
      default: { const _ex: never = completion; throw new Error(`Unknown image completion: ${String(_ex)}`); }
      }
    })();
    override addEventListener = vi.fn(super.addEventListener.bind(this));
    override removeEventListener = vi.fn(super.removeEventListener.bind(this));
    removeAttribute = vi.fn((name: string) => {
      if (name === 'src') this.url = '';
    });
    get src() {
      return this.url;
    }
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the native HTMLImageElement.src string setter.
    set src(url: string) {
      this.url = url;
      const blob = live.get(url);
      if (blob === undefined) throw new Error('Only owned local Blob URLs may be assigned');
      sourceAssigned({ element: this, blob });
    }
  }
  const sourceAssigned = vi.fn(({ element, blob }: { element: TestImage, blob: Blob }) => {
    if (blob.size === 70) {
      // Only model the known control PNG's expected pixel; no actual PNG decoder.
      element.naturalWidth = 1; element.naturalHeight = 1;
      element.pixels = new Uint8ClampedArray([255, 0, 0, 255]);
    }
    queueMicrotask(() => element.dispatchEvent(new Event('load')));
  });
  let drawn: TestImage | undefined;
  const drawImage = vi.fn((image: TestImage, _x: number, _y: number) => {
    drawn = image;
  });
  const getImageData = vi.fn(() => {
    if (drawn === undefined) throw new Error('No image drawn');
    return { data: drawn.pixels };
  });
  const context = { drawImage, getImageData };
  const canvases: Array<{ width: number, height: number, getContext: ReturnType<typeof vi.fn> }> = [];
  const getContext = vi.fn(() => context);
  const createElement = vi.fn((tag: string) => {
    switch (tag) {
    case 'img': {
      const element = new TestImage(); elements.push(element); return element;
    }
    case 'canvas': {
      const canvas = { width: 0, height: 0, getContext }; canvases.push(canvas); return canvas;
    }
    default: throw new Error(`Unexpected DOM allocation: ${tag}`);
    }
  });
  const appendChild = vi.fn(() => {
    throw new Error('Decode elements must not be attached');
  });
  vi.stubGlobal('document', { createElement, body: { appendChild } });
  vi.stubGlobal('createImageBitmap', undefined);
  vi.stubGlobal('OffscreenCanvas', undefined);
  return {
    live, created, createObjectURL, revokeObjectURL, decoded, elements, sourceAssigned,
    drawImage, getImageData, canvases, getContext, createElement, appendChild,
    dispose() {
      for (const url of live.keys()) revokeURL(url); live.clear();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
