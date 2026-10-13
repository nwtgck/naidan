export const strings = {
  title: 'Connect Naidan to Ollama or a llama.cpp server',
  description: 'Use an Ollama or llama.cpp server running on your device with Naidan. Choose the matching API provider, check its local URL, select a model, and resolve browser connection errors.',
  intro: [
    'A local inference engine can run a model outside the browser while you use Naidan for the conversation. Start the engine and make a model available there first. Naidan connects to its HTTP API; the engine runs as a separate process with its own permissions.',
    'Naidan provides local URL presets. Use the one that matches the API your engine exposes, then check the connection before choosing a model. The preset is an address to try, not a server that Naidan starts for you.',
  ],
  flow: {
    browser: 'Naidan in your browser',
    connection: 'HTTP request to local API',
    engine: 'Engine process + model',
    caption: 'Naidan sends the chat request to the selected engine address; that process generates the answer and returns it to the browser.',
  },
  enginesTitle: 'Match the engine to the API provider',
  openGuide: 'View setup guide',
  engines: [
    {
      title: 'Ollama',
      guide: 'models/ollama' as const,
      provider: 'API Provider: Ollama',
      preset: 'Ollama (local) · http://localhost:11434',
      body: 'Choose the Ollama preset when the Ollama service is listening at its usual local address. Naidan uses the Ollama API and lists models that the service reports.',
    },
    {
      title: 'llama.cpp server',
      guide: 'models/openai-compatible' as const,
      provider: 'API Provider: OpenAI Compatible',
      preset: 'llama-server (local) · http://localhost:8080/v1',
      body: 'The llama-server preset uses its OpenAI-compatible API, so keep the /v1 path. This server is distinct from llama.cpp running inside the browser. Naidan also offers an LM Studio preset at http://localhost:1234/v1 under the same API provider.',
    },
  ],
  stepsTitle: 'Connect during first-run setup',
  steps: [
    {
      title: 'Start the engine and its model',
      body: 'Follow the engine’s own setup to start its HTTP service and make at least one model available. Confirm its listening address. If you changed its port or base path, enter that actual URL in Naidan instead of using a preset.',
    },
    {
      title: 'Choose the matching provider and URL',
      body: 'In Naidan’s first-run setup, choose ［Ollama］ or ［OpenAI Compatible］, then select the matching local preset. You can also enter an existing server URL. Local-only and Curated permit local HTTP servers at localhost or 127.0.0.1; use regular Hosted or another edition that permits the address for a LAN or other-device server. Add ［Custom HTTP Headers］ only if your endpoint needs them.',
    },
    {
      title: 'Check, select, and start',
      body: 'Select ［Check Connection］. When Naidan reports a successful connection, choose a ［Default Model］ from the server’s list and select ［Get Started］. If no model appears, check that the engine has one available before retrying.',
    },
  ],
  laterTitle: 'Change the connection later',
  later: 'Open ［Settings］ → ［Connection］. Under ［Endpoint Configuration］, set ［API Provider］ and ［Endpoint URL］, then select ［Check Connection］. Under ［Model Selection］, choose ［Default Model］ and ［Save Changes］. Existing and new conversations that inherit the global endpoint or model use those saved values; check a chat or group override when one uses a different setting.',
  troubleTitle: 'If the connection check fails',
  trouble: [
    {
      title: 'The address or API does not match',
      body: 'Verify that the engine is running, the port matches its listener, and you selected ［Ollama］ for Ollama or ［OpenAI Compatible］ for llama-server. Keep /v1 on the llama-server preset. A server can respond at its base URL but still lack the model-list API Naidan needs.',
    },
    {
      title: 'The browser blocks the request',
      body: 'The browser enforces origin, CORS, mixed-content and, on some hosted editions, Content Security Policy rules. Standalone opens from file:// and can send Origin: null; the engine may need to allow that origin. Inspect the browser error and configure your own endpoint’s allowed origins before retrying.',
    },
    {
      title: 'The model list is empty',
      body: 'Check that your engine has a model and that its API returns a list. Naidan automatically checks only localhost URLs in the ［Connection］ settings; use ［Check Connection］ manually for other addresses. After switching endpoints, refresh and select the model from the new server.',
    },
  ],
  boundary: 'A local URL sends chat requests to that engine process. If you use an engine on another machine or an external endpoint, prompts and selected conversation context travel to that address. Its model behavior, file access and network connections are determined by the engine and its configuration.',
  next: 'Run an AI model in your browser',
  nextDescription: 'Compare browser runtimes that generate answers without a separate inference server.',
};
