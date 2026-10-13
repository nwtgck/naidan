import type { StandaloneMessages } from '../../../site/messages';

export const strings = {
  "title": "Open Naidan directly with file://",
  "description": "Download the Standalone edition, extract it and open index.html in your browser.",
  "intro": [
    "Using AI should not require giving an application more access to your PC just to start it. Naidan’s Standalone edition runs from local files in the browser, keeping the browser’s boundaries without a separate application server.",
    "Keep the application as a folder you can open. Model preparation, saved conversations and any local inference engine are separate parts of the setup."
  ],
  "diagramCaption": "From the extracted Standalone folder to a browser tab. The address begins with file:// because the browser is opening the local index.html directly.",
  "download": "Download the Standalone ZIP",
  "stepsTitle": "Start from the downloaded folder",
  "steps": [
    {
      "title": "Download and extract",
      "body": "Download naidan-standalone.zip and extract the whole archive. Keep the directory structure, including assets, intact.",
    },
    {
      "title": "Open index.html",
      "body": "Open index.html in your usual browser. Its address starts with file://. Keep the supporting files next to it; the entry HTML is part of the extracted application, not a replacement for the entire archive.",
    },
    {
      "title": "Choose a model or engine",
      "body": "Use a supported in-browser model or connect an engine such as Ollama or llama.cpp server. Fetching model files may need a connection. A local inference server runs separately with its own process permissions.",
    }
  ],
  "modesTitle": "What “no server” means here",
  "modes": [
    {
      "title": "No server to serve the application",
      "body": "Opening the files directly replaces the need to run an HTTP server for the Naidan interface. It also avoids choosing a listening port for that server.",
    },
    {
      "title": "The inference engine is your choice",
      "body": "An in-browser model runs inside the browser. Connecting a local engine is another option, with its own setup, model support and performance. Running from file:// does not automatically choose either mode.",
    }
  ],
  "details": [
    {
      "title": "Browser capabilities still matter",
      "body": "File URLs have different origin rules from HTTPS pages. A connection endpoint may need to allow the file page’s origin, and some browser capabilities work differently. Follow Naidan’s availability notices. The hosted edition is an alternative when a feature needs an ordinary web origin.",
    },
    {
      "title": "Choose how to retain conversations",
      "body": "Browser storage and the extracted application folder are separate. The Memory option keeps Naidan conversation data in application memory rather than writing it to persistent storage. Reloading then ends that session; downloaded files, model caches and OS memory management are separate.",
    },
    {
      "title": "Keep a backup before changing environments",
      "body": "Export your data before switching browsers, moving between hosted and file-based use, or replacing your installation. Download and extract a fresh Standalone folder for an update, keeping its own assets together.",
    }
  ],
  "next": "Understand the browser’s access boundaries",
} satisfies StandaloneMessages;
