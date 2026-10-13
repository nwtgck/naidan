export const strings = {
  title: 'Run an AI model in your browser',
  description: 'Choose a browser-run model in Naidan, prepare its files, and start a chat. Compare llama.cpp, Transformers.js and a browser-provided language model, including Standalone availability.',
  intro: [
    'You can run a chat model on your device without starting a separate inference server. The browser loads the model and performs the generation. Start with the llama.cpp choice if you have a GGUF model or want to choose one from the built-in catalog.',
    'Model files may need to be downloaded first. That download contacts the model distributor; afterward, generation uses the selected browser runtime. Browser and hardware support determine which models will run and how fast they respond.',
  ],
  flow: {
    input: 'Your Chat message',
    execution: 'Browser runtime + model',
    output: 'Answer in Chat',
    caption: 'For this choice, the selected model generates the answer in your browser. Preparing model files can involve a separate download.',
  },
  choicesTitle: 'Choose the browser runtime that fits your setup',
  openGuide: 'View setup guide',
  choices: [
    {
      title: 'llama.cpp in the browser',
      guide: 'models/llama-cpp-browser' as const,
      availability: 'Hosted and Standalone',
      body: 'Choose a suggested GGUF model, inspect a Hugging Face repository, or import your own GGUF file or model folder. The model manager shows downloaded files and lets you choose browser storage or a supported device folder as the destination.',
    },
    {
      title: 'Transformers.js',
      guide: 'models/transformers-js' as const,
      availability: 'Hosted edition only · experimental',
      body: 'Open the Transformers.js manager and download a supported ONNX model. When the download completes, Naidan starts loading it automatically; the downloaded list offers ［Load］ for a complete model or ［Resume］ for an incomplete one. Its model files are stored in the browser’s OPFS. This option is unavailable in Standalone because local-file browser restrictions affect its workers and WebAssembly.',
    },
    {
      title: 'Browser-provided model',
      guide: 'models/browser-provided' as const,
      availability: 'Only when your browser provides one',
      body: 'Choose ［Browser-provided］ and read the availability status. If the browser offers a model that needs preparation, use ［Prepare browser-provided model］. The browser manages that model, so its availability and download behavior depend on the browser.',
    },
  ],
  stepsTitle: 'Start a chat with a GGUF model',
  steps: [
    {
      title: 'Select llama.cpp',
      body: 'At the first-run setup, choose llama.cpp under ［In-Browser AI］. If you have already started using Naidan, open the llama.cpp browser tab in ［Settings］ to manage models, then choose ［llama.cpp browser (Experimental)］ as the ［API Provider］ on the ［Connection］ tab.',
    },
    {
      title: 'Prepare the model files',
      body: 'Use the ［Model catalog］ to inspect a suggested model and its size before ［Download］, or import a GGUF file or model folder you already have. For a Hugging Face repository, check the file plan and quantization before downloading. Large models take storage and memory.',
    },
    {
      title: 'Select it for conversation',
      body: 'Pick the imported model in ［Default model］ during setup, or choose it in the ［Connection］ settings and ［Save changes］. Existing and new conversations that inherit the global model use this default; a chat or group can choose another model.',
    },
    {
      title: 'Try a short message',
      body: 'Select ［Get started］ and send a simple text prompt. If the model is missing when you send, Naidan offers a path back to model preparation while keeping your draft.',
    },
  ],
  limitsTitle: 'Before using images or other media',
  limits: [
    'An image attached to a llama.cpp chat needs a matching mmproj GGUF alongside the model. The current llama.cpp chat input does not support audio or video. Generating an image or speech uses separate model features and setup.',
    'Standalone includes browser llama.cpp through its embedded WebGPU runtime, without a CPU fallback. The hosted edition has more execution profiles. Check the in-app availability notice on your browser and device. Transformers.js is a hosted-only choice.',
    'Downloaded models and chat history have different storage controls. Removing browser site data can remove cached models; choosing a device model folder depends on browser permission and folder access.',
  ],
  next: 'Connect to an Ollama or llama.cpp server instead',
};
