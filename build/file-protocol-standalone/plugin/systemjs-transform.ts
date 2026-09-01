import { transformSync } from '@swc/core';

export type SystemJsTransformInput = Readonly<{
  code: string;
  fileName: string;
}>;

export type SystemJsTransformResult = Readonly<{
  code: string;
}>;

export function transformToSystemJs({
  code,
  fileName,
}: SystemJsTransformInput): SystemJsTransformResult {
  const transformed = transformSync(code, {
    filename: fileName,
    swcrc: false,
    configFile: false,
    isModule: true,
    sourceMaps: false,
    // The upstream build already owns optimization; SWC only lowers the module format and prints compact code.
    minify: true,
    jsc: {
      parser: {
        syntax: 'ecmascript',
      },
      target: 'esnext',
      minify: {
        compress: false,
        mangle: false,
      },
    },
    module: {
      type: 'systemjs',
    },
  });
  if (typeof transformed.code !== 'string' || transformed.code.length === 0) {
    throw new Error(`No SystemJS transform output for ${fileName}`);
  }
  if (!transformed.code.includes('System.register(')) {
    throw new Error(`SystemJS transform did not emit System.register for ${fileName}`);
  }
  return { code: transformed.code };
}
