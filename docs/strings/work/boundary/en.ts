import { boundaryComparisonEn } from './demo/en';
export const strings = {
  demo: boundaryComparisonEn,
  "title": "Understand local AI processing and browser permissions",
  "description": "See how Naidan processes AI input on your device, limits file access through browser permissions, and separates model downloads from inference connections.",
  "intro": [
    "A useful AI environment needs access to the data for a task. That does not require unrestricted access to a PC. Naidan uses the browser’s sandbox and permission model as the starting point, then implements models and tools inside it."
  ],
  "diagramTitle": "Follow the OS and browser boundaries",
  "motionNote": "Naidan runs inside the browser, which runs on the OS. Direct OS operations stop at the browser boundary. Browser APIs provide permitted file, clipboard and network access, including an allowed connection to a localhost server.",
  "sections": [
    {
      "title": "01 · You choose the input",
      "body": "Text and selected files enter the conversation. File and folder access follows the browser’s APIs and grants. A linked folder can be writable when explicitly permitted; the boundary is controlled access, not a ban on useful file operations.",
    },
    {
      "title": "02 · The browser runs the model",
      "body": "A supported in-browser model processes input on the device. WebGPU can use the device’s graphics processor, while WebAssembly runs compiled code in the browser. Availability and performance depend on the model, runtime and browser.",
    },
    {
      "title": "03 · Connections have a purpose and a destination",
      "body": "Getting model files contacts a model provider. Choosing an external engine or a network-enabled tool adds its own connections. The Local-only deployment narrows allowed destinations with Content Security Policy (CSP). Browser developer tools help you inspect requests; a local engine such as llama.cpp server runs with its own native-process permissions.",
    }
  ],
  "next": "Choose which files and folders AI can read or edit",
  localOnlyGuide: 'Limit external connections with the Local-only edition',
  nextDescription: 'Grant access to a chosen folder and decide what the assistant may change.',
};
