import { render, h as vueH } from 'vue';
import ImageDownloadButton from './ImageDownloadButton.vue';
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
    try {
      const vnode = vueH(ImageDownloadButton, {
        isSupported,
        onDownload
      });

      render(vnode, portal);

      return () => {
        render(null, portal);
      };
    } catch (err) {
      console.warn('[Hydrator] Vue render() failed, falling back to basic UI:', err);

      portal.innerHTML = `
        <div class="naidan-download-fallback flex shadow-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm">
          <button class="naidan-download-gen-image p-1.5 text-gray-500 hover:text-blue-600 rounded-l-lg" title="Download image" data-testid="download-gen-image-button">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
          </button>
          <button class="naidan-download-with-meta flex items-center gap-1 p-1.5 text-blue-500 hover:text-blue-600 border-l border-gray-200 dark:border-gray-700 rounded-r-lg" title="With Metadata" data-testid="download-with-metadata-option">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
            <span class="text-[10px] font-bold">With Metadata</span>
          </button>
        </div>
      `;

      const btn = portal.querySelector('.naidan-download-gen-image');
      const metaBtn = portal.querySelector('.naidan-download-with-meta');
      const handler = () => onDownload({ withMetadata: false });
      const metaHandler = () => onDownload({ withMetadata: true });

      btn?.addEventListener('click', handler);
      metaBtn?.addEventListener('click', metaHandler);

      return () => {
        btn?.removeEventListener('click', handler);
        metaBtn?.removeEventListener('click', metaHandler);
        portal.innerHTML = '';
      };
    }
  }
};
