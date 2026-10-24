import { z } from 'zod';
import { modelSourceRepositorySchema as repositorySchema } from '@/01-models/llama-cpp-browser-model-launch';

export function parseRepository({ input }: { input: string }): { repository: string, requestedVariant: string | undefined } {
  let value = input.trim();
  if (value.startsWith('hf.co/')) {
    value = `https://${value}`;
  }
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (!['huggingface.co', 'hf.co'].includes(url.hostname) || url.port || url.username || url.password) {
      throw new Error('Invalid Hugging Face repository');
    }
    // Any URL suffix deliberately points to main, regardless of path, query or fragment.
    value = url.pathname.replace(/^\/+/, '').split('/').slice(0, 2).map(part => decodeURIComponent(part)).join('/');
  }
  const separator = value.indexOf(':');
  const repository = repositorySchema.parse(separator < 0 ? value : value.slice(0, separator));
  const requestedVariant = separator < 0 ? undefined : z.string().min(1).regex(/^[^\p{Cc}]+$/u).parse(value.slice(separator + 1));
  return { repository, requestedVariant };
}


export const TEST_ONLY = {
};
