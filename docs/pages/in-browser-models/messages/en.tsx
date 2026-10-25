import AppEntryLink from '../../../components/AppEntryLink.vue';
import type { AppDestination } from '../../../navigation/app-entry';
import type { DocsLocale } from '../../../navigation/routes';
import UiLabel from '../../../components/UiLabel.vue';

export const messages = {
  title: 'Run an AI model in your browser',
  description: 'Run a local LLM on your device and start a chat. Compare llama.cpp, Transformers.js and browser-provided models, including Standalone availability.',
  intro: () => ['To try a local LLM in your browser, start with a GGUF model through llama.cpp. The model answers on your device without sending your prompt to an inference server. You can use a model you already have or choose one from the built-in catalog.', 'GGUF response generation can work offline once the app, runtime and model files are available locally. Downloading model files first contacts their distributor. Browser and hardware support determine which models will run and how fast they respond.'],
  chat_message: 'Your Chat message',
  browser_runtime_and_model: 'Browser runtime + model',
  chat_answer: 'Answer in Chat',
  browser_model_flow_caption: 'For this choice, the selected model generates the answer in your browser. Preparing model files can involve a separate download.',
  browser_runtime_choices_heading: 'Choose the browser runtime that fits your setup',
  view_setup_guide: 'View setup guide',
  llama_cpp_heading: 'llama.cpp in the browser',
  llama_cpp_availability: 'Hosted and Standalone',
  llama_cpp_description: () => <>Choose a suggested GGUF, search Hugging Face, or use files you already have. You can save a copy in browser storage, link a supported device folder, or try files temporarily without saving a copy.</>,
  transformers_js_heading: 'Transformers.js',
  transformers_js_availability: 'Hosted edition only · experimental',
  transformers_js_description: () => <>Open the Transformers.js manager and download a supported ONNX model. When the download completes, Naidan starts loading it automatically; the downloaded list offers <UiLabel text="Load" /> for a complete model or <UiLabel text="Resume" /> for an incomplete one. Its model files are stored in the browser’s OPFS. This option is unavailable in Standalone because local-file browser restrictions affect its workers and WebAssembly.</>,
  browser_provided_model_heading: 'Browser-provided model',
  browser_provided_model_availability: 'Only when your browser provides one',
  browser_provided_model_description: () => <>Choose <UiLabel text="Browser-provided" /> and read the availability status. If the browser offers a model that needs preparation, use <UiLabel text="Prepare browser-provided model" />. The browser manages that model, so its availability and download behavior depend on the browser.</>,
  start_gguf_chat_heading: 'Start a chat with a GGUF model',
  open_app: ({ locale, destination }: { locale: DocsLocale; destination: AppDestination }) => <>Open <AppEntryLink locale={locale} destination={destination} display="label">Naidan</AppEntryLink> to choose a model. These steps use llama.cpp; follow the separate guides above for ONNX or a browser-provided model.</>,
  select_llama_cpp_heading: 'Choose a GGUF model',
  select_llama_cpp_instructions: () => <>On the home screen, choose one of the suggested models, or use the local-file area to select a GGUF or model folder from your device.</>,
  prepare_model_files_heading: 'Check the choice and prepare it',
  prepare_model_files_instructions: () => <>For a suggested model, check its quantization and size, then select <UiLabel text="Run in your browser" />. The home screen downloads required files into browser storage (OPFS) and prepares the runtime. A model link can contact Hugging Face for repository details before this action; model-file downloads require the explicit start. Local-only needs files obtained separately. Files selected from your device start with temporary access, and you can save a browser copy later.</>,
  choose_conversation_model_heading: 'Use the prepared model in the chat',
  choose_conversation_model_instructions: () => <>Once preparation is complete, the chat uses the model you selected. You do not need to save a global default to start this chat. The model selector beside the input can choose another available model for this chat.</>,
  send_first_message_heading: 'Try a short message',
  send_first_message_instructions: () => <>Send a short text prompt when the chat is ready. If its model is missing, select <UiLabel text="Choose a model" /> beside the input. You can choose files, search Hugging Face, or reuse a saved model while keeping your draft; a missing file does not start a download by itself.</>,
  media_input_limits_heading: 'Before using images or other media',
  media_input_limits: () => ['To attach an image to a llama.cpp chat, you need a matching mmproj GGUF, the model’s companion file for image input. The current llama.cpp chat input does not support audio or video. Generating an image or speech uses separate model features and setup.', 'Standalone includes browser llama.cpp through its embedded WebGPU runtime, without a CPU fallback. The hosted edition has more execution profiles. Check the in-app availability notice on your browser and device. Transformers.js is a hosted-only choice.', 'Model files and chat history have different storage controls. Removing browser site data can remove saved models. Linked folders need browser permission and access; temporary file registrations last until this page is reloaded or closed, even if a chat still remembers their model selection.'],
  local_server_guide_title: 'Connect Naidan to Ollama or a llama.cpp server',
  local_server_guide_description: 'Choose an endpoint and model on a local inference server already running on your device.',
};
