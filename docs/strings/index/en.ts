import { boundaryComparisonEn } from '../work/boundary/demo/en';
import { standaloneDemoEn } from '../run/standalone/demo/en';
import { storageChoiceDemoEn } from './storage-demo/en';
export const strings = {
  standaloneDemo: standaloneDemoEn,
  storageDemo: storageChoiceDemoEn,
  "demo": {
    "title": "Project summary",
    "user": "You",
    "prompt": "Make a plan for tomorrow: review the prototype, check the remaining tasks, and prepare the next iteration.",
    "answerIntro": "Here is the plan:",
    "answerItems": [
      "Review the prototype.",
      "Check the remaining tasks.",
      "Prepare the next iteration."
    ],
    "placeholder": "Type a message...",
    "capabilities": [
      "Text generation",
      "Image generation",
      "Speech generation"
    ],
  },
  boundary: boundaryComparisonEn,
  "title": "AI in your browser, with control over your data",
  "headline": [
    "An easy-to-use AI environment, ",
    "built around privacy."
  ],
  "description": "Use Naidan for AI chat, image and speech generation in your browser. Choose local models, file permissions and how conversations are saved.",
  "intro": [
    "Using AI should not depend on getting every privacy decision right, every time. The goal was to make an environment that limits what can go wrong and is easy to use.",
    "That idea led to Naidan: a place to work with AI that puts privacy first."
  ],
  "howTitle": "The browser sets the boundaries.",
  "howLead": "Your everyday browser provides a constrained place to run AI and tools. Its APIs and permissions mediate access to files, the clipboard and connections.",
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
  appPermissionsLink: 'Compare what web and native apps can access',
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
  storageCaption: 'Local Storage is an alternative when OPFS is unavailable. Its capacity and support for saving sent images are limited.',
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
  "standalone": { "title": "Double-click to start using AI.", "body": "Extract the Standalone ZIP, then double-click index.html on your PC. Naidan opens in your browser without an installer or a server to serve the app. Then choose a model or local engine for your work." },
  "standaloneLink": "Start without an installer or app server",
  "guidesTitle": "Find what you want to do.",
  "guidesLead": "Open the guide you need. Each page includes its own context, examples and important choices.",
  "guides": {
    "files": {
      "title": "Choose which files AI can read or edit",
      "body": "Choose between a linked folder and a separate copy, and decide which files AI can edit.",
    },
    "boundary": {
      "title": "Understand local AI and browser permissions",
      "body": "See how browser permissions and local processing fit together.",
    },
    "branching": {
      "title": "Branch and edit AI conversations",
      "body": "Keep the original conversation while editing an earlier message, trying another answer, or opening a separate Chat.",
    },
    "shell": {
      "title": "Let AI work with files using a browser shell",
      "body": "Ask AI to search selected files with shell tools, then inspect the commands and results.",
    },
  },
};
