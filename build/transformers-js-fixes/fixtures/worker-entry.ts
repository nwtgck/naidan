// This is an actual module Worker build fixture, never a main-thread import.
// eslint-disable-next-line no-restricted-imports
import { AutoModelForCausalLM } from '@huggingface/transformers';

// Retain actual model resource consumers without running ORT or requesting data.
globalThis.addEventListener('message', () => {
  globalThis.postMessage(typeof AutoModelForCausalLM.from_pretrained);
});
