import { findModelSeoEntry } from '@/features/llama-cpp-browser/model-launch/seo-entries';

/** Keep the current origin, file:// filename and portable hosted subdirectory. */
export function appUrlFromLocation({ href }: { href: string }): URL {
  const url = new URL(href);
  if (!__BUILD_MODE_IS_STANDALONE__ && (url.protocol === 'https:' || url.protocol === 'http:')
    && findModelSeoEntry({ pathname: url.pathname }) !== undefined) {
    url.pathname = '/';
  }
  return url;
}

export const TEST_ONLY = {
};
