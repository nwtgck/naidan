import { ImportExportService } from './service';
import { storageService } from '../storage';
import type { ImportConfig } from './types';

export const APPEND_ONLY_CONFIG: ImportConfig = {
  settings: {
    endpoint: 'none',
    model: 'none',
    titleModel: 'none',
    systemPrompt: 'none',
    lmParameters: 'none',
    providerProfiles: 'append',
  },
  data: {
    mode: 'append',
    chatTitlePrefix: '',
    chatGroupNamePrefix: '',
  },
};

export class URLImportExportLogic {
  private service: ImportExportService;

  constructor() {
    this.service = new ImportExportService(storageService);
  }

  /**
   * Encodes current storage to a Base64 ZIP string.
   */
  async exportToBase64({ exclude }: { exclude: Array<'chat' | 'binary_object'> | undefined }): Promise<{ zipBase64: string; size: number }> {
    const { stream } = await this.service.exportData({ exclude });

    // Collect stream chunks into an array to create a Blob
    const chunks: Uint8Array[] = [];
    const streamReader = stream.getReader();
    while (true) {
      const { done, value } = await streamReader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const blob = new Blob(chunks as unknown as BlobPart[], { type: 'application/zip' });

    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onloadend = () => {
        const zipBase64 = (fr.result as string).split(',')[1];
        if (zipBase64) {
          resolve({ zipBase64, size: zipBase64.length });
        } else {
          reject(new Error('Failed to encode to Base64'));
        }
      };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Decodes Base64 ZIP and imports it (append mode).
   */
  async importFromBase64({ zipBase64 }: { zipBase64: string }): Promise<void> {
    const binaryString = atob(zipBase64);
    let bytes: Uint8Array | null = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes] as unknown as BlobPart[], { type: 'application/zip' });

    await this.service.verify(blob, APPEND_ONLY_CONFIG);
    await this.service.executeImport(blob, APPEND_ONLY_CONFIG);

    // Explicitly help GC by clearing references to large data
    bytes = null;
  }

  /**
   * Gets the export URL for the current state.
   */
  async getExportURL({ exclude }: { exclude: Array<'chat' | 'binary_object'> | undefined }): Promise<string> {
    let data: { zipBase64: string; size: number } | null = await this.exportToBase64({ exclude });
    const zipBase64 = data.zipBase64;
    const currentType = storageService.getCurrentType();
    const url = new URL(window.location.href);

    // Use hash for vue-router compatibility (fragment)
    const params = new URLSearchParams();
    params.set('storage-type', currentType);
    params.set('data-zip', zipBase64);

    // Success check for hash assignment as requested
    url.hash = "";
    const emptyHashUrl = url.toString();
    url.hash = `/?${params.toString()}`;
    const finalUrl = url.toString();

    if (finalUrl === emptyHashUrl && zipBase64.length > 0) {
      const sizeMB = (data.size / (1024 * 1024)).toFixed(2);
      data = null; // Clear before throwing
      throw new Error(`Failed to generate export URL. The storage data (${sizeMB} MB) is likely too large to be shared via a URL link.`);
    }

    // Explicitly clear the large string reference before returning the final URL
    data = null;

    return finalUrl;
  }
}

export const urlImportExportLogic = new URLImportExportLogic();
