import { naidanAutoprefixerOptions } from './build/static-tailwind/css-postprocessor';

export default {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: naidanAutoprefixerOptions,
  },
};
