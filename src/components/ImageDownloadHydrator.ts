import { render, h as vueH } from 'vue';
import ImageDownloadButton from './ImageDownloadButton.vue';
import ImageInfoDisplay from './ImageInfoDisplay.vue';
import { detectFormat, embedMetadataInPng, embedMetadataInWebp, UNSUPPORTED } from '../utils/image-metadata';
import { sanitizeFilename } from '../utils/string';
import type { StorageService } from '../services/storage';

/**
 * ImageDownloadHydrator handles the manual attachment of the Vue-based
 * download button and image elements to a DOM element within a v-html block.
 */
export const ImageDownloadHydrator = {
  /**
   * Extract all necessary data from the placeholder element to prepare for hydration.
   */
  async prepareContext(el: HTMLElement, storageService: StorageService) {
    const id = el.dataset.id;
    if (!id) return null;

    // Detect format for metadata support
    let isSupported = false;
    try {
      const blob = await storageService.getFile(id);
      if (blob) {
        const format = await detectFormat({ blob });
        isSupported = format !== UNSUPPORTED;
      }
    } catch (err) {
      console.warn('[Hydrator] Metadata support detection failed:', err);
    }

    return {
      id,
      isSupported,
      width: el.dataset.width,
      height: el.dataset.height,
      prompt: el.dataset.prompt || '',
      steps: el.dataset.steps ? parseInt(el.dataset.steps) : undefined,
      seed: el.dataset.seed ? parseInt(el.dataset.seed) : undefined,
    };
  },

  /**
   * Creates a standard image element for generated images with the correct styling and behavior.
   */
  createImageElement({ url, width, height, onPreview }: {
    url: string,
    width: string | undefined,
    height: string | undefined,
    onPreview: () => void
  }): HTMLImageElement {
    const imgEl = document.createElement('img');
    imgEl.src = url;
    imgEl.width = parseInt(width || '512');
    imgEl.height = parseInt(height || '512');
    imgEl.alt = 'generated image';
    imgEl.className = 'naidan-clickable-img rounded-xl shadow-lg border border-gray-100 dark:border-gray-800 max-w-full h-auto !m-0 block cursor-pointer hover:opacity-95 transition-opacity';
    imgEl.onclick = (e) => {
      e.stopPropagation();
      onPreview();
    };
    return imgEl;
  },

  /**
   * Orchestrates the download of a generated image, optionally embedding metadata.
   */
  async download({ id, prompt, steps, seed, model, withMetadata, storageService, onError }: {
    id: string,
    prompt: string,
    steps: number | undefined,
    seed: number | undefined,
    model: string | undefined,
    withMetadata: boolean,
    storageService: StorageService,
    onError: (err: unknown) => void
  }) {
    try {
      const obj = await storageService.getBinaryObject({ binaryObjectId: id });
      const blob = await storageService.getFile(id);
      if (!blob) throw new Error('Image blob not found');

      let suffix = '.png';
      if (obj?.name) {
        const lastDot = obj.name.lastIndexOf('.');
        if (lastDot !== -1) {
          suffix = obj.name.slice(lastDot);
        }
      }

      let finalBlob = blob;
      if (withMetadata) {
        try {
          const metadata = { prompt, steps, seed, model };
          if (suffix.toLowerCase() === '.png') {
            finalBlob = await embedMetadataInPng({ blob, metadata });
          } else if (suffix.toLowerCase() === '.webp') {
            finalBlob = await embedMetadataInWebp({ blob, metadata });
          }
        } catch (err) {
          console.error('[Hydrator] Failed to embed metadata:', err);
          onError(err);
        }
      }

      const filename = sanitizeFilename({
        base: prompt,
        suffix,
        fallback: 'generated-image',
      });

      const downloadUrl = URL.createObjectURL(finalBlob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Revoke the temporary URL after a delay
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } catch (err) {
      console.error('[Hydrator] Failed to download generated image:', err);
    }
  },

  /**
   * Mounts the download button into the portal.
   * Returns a cleanup function.
   */
  mount({ portal, isSupported, onDownload }: {
    portal: HTMLElement,
    isSupported: boolean,
    onDownload: (payload: { withMetadata: boolean }) => void
  }): () => void {
    const vnode = vueH(ImageDownloadButton, {
      isSupported,
      onDownload
    });

    render(vnode, portal);

    return () => {
      render(null, portal);
    };
  },

  /**
   * Mounts the info display into the portal.
   * Returns a cleanup function.
   */
  mountInfo({ portal, prompt, steps, seed }: {
    portal: HTMLElement,
    prompt: string,
    steps: number | undefined,
    seed: number | undefined
  }): () => void {
    const vnode = vueH(ImageInfoDisplay, {
      prompt,
      steps,
      seed
    });

    render(vnode, portal);

    return () => {
      render(null, portal);
    };
  }
}
