/** Temporary, narrowly scoped exception for the newly released Abiray Turbo
 * quants, whose 40-digit repository revision is not yet independently verified.
 * Never use this for other publishers or files. Remote file bytes are still
 * checked against the SHA-256 reported by Hugging Face LFS before publication.
 * Remove this exception when the catalog source can be commit-pinned.
 */
export function isExperimentalImageCatalogMain({ repository, revision, path }: {
  repository: string;
  revision: string;
  path: string;
}): boolean {
  return repository === 'Abiray/Qwen-Image-2.1-Turbo-GGUF'
    && revision === 'main'
    && /^qwen_image_2\.1_turbo_Q(?:3_K_M|4_K_[SM]|5_K_M|6_K|8_0)\.gguf$/.test(path);
}

export const TEST_ONLY = {
};
