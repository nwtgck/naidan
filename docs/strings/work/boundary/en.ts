import type { BoundaryMessages } from '../../../site/messages';

export const strings = {
  "title": "Use the browser’s existing boundaries",
  "description": "Where input is processed, which files are accessible and when network connections are made.",
  "intro": [
    "A useful AI environment needs access to the data for a task. That does not require unrestricted access to a PC. Naidan uses the browser’s sandbox and permission model as the starting point, then implements models and tools inside it."
  ],
  "diagramTitle": "Follow one local inference request",
  "motionNote": "After the model is ready, input, inference and the response stay within the browser on this device. The separate download lane shows where acquiring model files can involve a network connection.",
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
  "next": "Choose the files exposed to a Chat",
} satisfies BoundaryMessages;
