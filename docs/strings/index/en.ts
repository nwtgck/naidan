import type { HomeMessages } from '../../site/messages';

export const strings = {
  "title": "An easy-to-use AI environment, built around privacy.",
  "mock": "Illustration of an English interface. No model is running.",
  "headline": [
    "An easy-to-use AI environment, ",
    "built around privacy."
  ],
  "description": "Text, image and speech generation in your browser, with control over your data and the tools you choose.",
  "intro": [
    "Using AI should not depend on getting every privacy decision right, every time. The goal was to make an environment that limits what can go wrong and is easy to use.",
    "That idea led to Naidan: a place to work with AI that puts privacy first."
  ],
  "howTitle": "The browser sets the boundaries.",
  "howLead": "Naidan uses the browser as an execution environment, not just a window onto a remote AI service.",
  "mechanisms": [
    {
      "title": "Access is mediated by the browser",
      "body": "The browser sandbox limits access to files and device features. Files and folders you select are handled within the permissions you grant.",
    },
    {
      "title": "Models can process your inputs locally",
      "body": "Text, image and speech models can run in your browser. Supported runtimes use WebGPU to take advantage of your device’s graphics hardware.",
    },
    {
      "title": "Network access has an explicit scope",
      "body": "The Local-only deployment uses Content Security Policy (CSP) to limit connections to the site itself and local servers. Browser developer tools help you inspect traffic.",
    }
  ],
  "boundaryNote": "Model downloads contact their distribution service. When you choose an external engine or tool, its permissions and connections also become part of your setup.",
  "modelsTitle": "Choose where your model runs.",
  "models": [
    {
      "title": "Run it in the browser",
      "body": "Download a supported model and use your device for generation. Model support and performance depend on your browser and hardware.",
    },
    {
      "title": "Connect a local engine",
      "body": "Ollama and llama.cpp server run independently of Naidan. Connect through their APIs when their model support or performance better fits your work. These engines use the permissions of their native process.",
    }
  ],
  "storageTitle": "Save your conversations, or keep them in memory.",
  "storageLead": "Choose whether Naidan writes conversation data to persistent browser storage.",
  "storage": [
    {
      "title": "Save in the browser",
      "body": "Origin Private File System (OPFS) stores conversations and attachments in the browser’s private storage, ready for the next session.",
    },
    {
      "title": "Use memory only",
      "body": "Memory mode keeps conversation data in the running session instead of writing it to persistent storage. Reloading the page ends that session.",
    }
  ],
  "storageNote": "This choice concerns Naidan’s conversation storage. Model caches, exported files and operating-system memory management have separate lifetimes.",
  "guidesTitle": "Find what you want to do.",
  "guidesLead": "Open the guide you need. Each page includes its own context, examples and important choices.",
  "guides": {
    "files": {
      "title": "Work with files and folders",
      "body": "Choose between a linked folder and a separate copy, and decide which files AI can edit.",
    },
    "boundary": {
      "title": "Understand the browser boundary",
      "body": "See how browser permissions and local processing fit together.",
    },
    "branching": {
      "title": "Branch a conversation",
      "body": "Try a different instruction while keeping the original conversation.",
    },
    "shell": {
      "title": "Use a shell in your browser",
      "body": "Explore files and conversation context with familiar commands.",
    },
  },
} satisfies HomeMessages;
