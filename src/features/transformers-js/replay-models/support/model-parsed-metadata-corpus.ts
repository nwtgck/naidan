import context from './model-parsed-metadata-source.evidence.json';
import model0 from '@/features/transformers-js/replay-models/huggingfacetb--smollm2-1.7b-instruct/model-parsed-metadata.evidence.json';
import model1 from '@/features/transformers-js/replay-models/huggingfacetb--smollm2-135m-instruct/model-parsed-metadata.evidence.json';
import model2 from '@/features/transformers-js/replay-models/liquidai--lfm2.5-2.6b-onnx/model-parsed-metadata.evidence.json';
import model3 from '@/features/transformers-js/replay-models/liquidai--lfm2.5-230m-onnx/model-parsed-metadata.evidence.json';
import model4 from '@/features/transformers-js/replay-models/liquidai--lfm2.5-350m-onnx/model-parsed-metadata.evidence.json';
import model5 from '@/features/transformers-js/replay-models/onnx-community--gemma-4-e2b-it-onnx/model-parsed-metadata.evidence.json';
import model6 from '@/features/transformers-js/replay-models/onnx-community--gpt-oss-20b-onnx/model-parsed-metadata.evidence.json';
import model7 from '@/features/transformers-js/replay-models/onnx-community--qwen3.5-2b-onnx/model-parsed-metadata.evidence.json';
import model8 from '@/features/transformers-js/replay-models/onnx-community--qwen3.5-4b-onnx/model-parsed-metadata.evidence.json';

// Collection membership is explicit; adding an observation must not replace existing model input.
export default { ...context, models: [model0, model1, model2, model3, model4, model5, model6, model7, model8] };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
