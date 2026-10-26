import { createRequire } from 'node:module';
import type { ConstructorOptions, JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

/** Keep DOM parsing out of config initialization, including bundled configs. */
export function createBuildDom({ html, options }: { html: string, options: ConstructorOptions | undefined }): JSDOM {
  const jsdom: typeof import('jsdom') = require('jsdom');
  return new jsdom.JSDOM(html, options);
}
