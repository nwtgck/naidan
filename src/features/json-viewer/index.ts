export { default as JsonCodeView } from './components/JsonCodeView.vue';
export {
  formatJsonSource,
  tokenizeJson,
  type FormattedJsonSource,
  type JsonSyntaxToken,
  type JsonSyntaxTokenType,
} from './logic/json-syntax';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
