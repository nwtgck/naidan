/** User-selected sources. Bundling these entries does not authorize network I/O.
 * Resolve live files only after Check model, then confirm the actual download.
 * No guessed filenames, size-based identities, or cross-repository companions.
 */
export const audioModelCatalog = [
  { name: 'Qwen3-TTS 0.6B Base', input: 'https://huggingface.co/mradermacher/Qwen3-TTS-12Hz-0.6B-Base-GGUF', url: 'https://huggingface.co/mradermacher/Qwen3-TTS-12Hz-0.6B-Base-GGUF' },
  { name: 'Qwen3-TTS 1.7B Base · Q4_K_M', input: 'hf.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF:Q4_K_M', url: 'https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF' },
] as const;
export const TEST_ONLY = {
};
