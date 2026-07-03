import autoprefixer from 'autoprefixer';
import postcss from 'postcss';

export const naidanAutoprefixerOptions = Object.freeze({});

const processor = postcss([
  autoprefixer(naidanAutoprefixerOptions),
]);

export function postprocessStaticTailwindCss({ css }) {
  return processor.process(css, { from: undefined }).css;
}
