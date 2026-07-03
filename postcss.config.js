import { naidanAutoprefixerOptions } from './build/static-tailwind/css-postprocessor.mjs';

export default {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: naidanAutoprefixerOptions,
  },
};