import { isModelPagePath } from '@/features/llama-cpp-browser/model-launch/page-url';

/** Keep the current origin, file:// filename and portable hosted subdirectory. */
export function appUrlFromLocation({ href }: { href: string }): URL {
  const url = new URL(href);
  if (!__BUILD_MODE_IS_STANDALONE__ && (url.protocol === 'https:' || url.protocol === 'http:')
    && isModelPagePath({ pathname: url.pathname })) {
    url.pathname = '/';
    url.searchParams.delete('quant');
  }
  return url;
}

export const TEST_ONLY = {
};
