import { ImportExportService } from './service';
import { storageService } from '@/00-storage/service';
import type { ExportExclusions, ImportConfig } from './types';
import { decodeZipBase64, encodeZipStreamAsBase64 } from './zip-base64';

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
    this.service = new ImportExportService({ storage: storageService });
  }

  /**
   * Encodes current storage to a Base64 ZIP string.
   */
  async exportToBase64({ exclude }: {
    exclude: ExportExclusions | undefined,
  }): Promise<{ zipBase64: string, size: number }> {
    const { stream } = await this.service.exportData({ exclude });
    const zipBase64 = await encodeZipStreamAsBase64({ stream, signal: undefined });
    if (zipBase64.length === 0) {
      throw new Error('Failed to encode to Base64');
    }
    return { zipBase64, size: zipBase64.length };
  }

  /**
   * Decodes Base64 ZIP and imports it (append mode).
   */
  async importFromBase64({ zipBase64 }: { zipBase64: string }): Promise<void> {
    const blob = decodeZipBase64({ serialized: zipBase64 });

    await this.service.verify({ zipFile: blob, config: APPEND_ONLY_CONFIG });
    await this.service.executeImport({ zipFile: blob, config: APPEND_ONLY_CONFIG });
  }

  /**
   * Gets the export URL for the current state.
   */
  async getExportURL({ exclude, baseUrl }: {
    exclude: ExportExclusions | undefined,
    baseUrl: string,
  }): Promise<string> {
    let data: { zipBase64: string, size: number } | null = await this.exportToBase64({ exclude });
    const zipBase64 = data.zipBase64;
    const currentType = storageService.getCurrentType();
    const url = new URL(baseUrl);

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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
