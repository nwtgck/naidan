import { boundaryComparisonEn } from '../../browser-boundaries/strings/demo/en';
import { standaloneDemoEn } from '../../standalone/strings/demo/en';
import { storageChoiceDemoEn } from './storage-demo/en';

const answerIntroChunks = ['Here ', 'is ', 'the ', 'plan:'];
const answerItemChunks = [
  ['Review ', 'the ', 'prototype.'],
  ['Check ', 'the ', 'remaining ', 'tasks.'],
  ['Prepare ', 'the ', 'next ', 'iteration.'],
];

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
    answerIntroChunks,
    answerItemChunks,
    "placeholder": "Type a message...",
    "capabilities": [
      "Text generation",
      "Image generation",
      "Speech generation"
    ],
  },
  boundary: boundaryComparisonEn,
  "title": "An AI environment in your web browser",
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
      "body": "The Local-only deployment uses Content Security Policy (CSP) to limit the page's API request destinations to its own site and local servers. Browser developer tools help you inspect traffic.",
    }
  ],
  "boundaryNote": "Model downloads contact their distribution service. When you choose an external engine or tool, its permissions and connections also become part of your setup.",
  localOnlyLink: 'Learn about the Local-only edition’s connection limits',
  appPermissionsLink: 'Compare what web and native apps can access',
  appPermissionsDescription: 'See where each can reach on your device and what it can send afterward.',
  "modelsTitle": "Choose where your model runs.",
  "models": [
    {
      "title": "Run it in the browser",
      "body": "Download or import a supported model and use your device for generation. Local-only blocks external model downloads; you can import a GGUF you already have. Model support and performance depend on your browser and hardware.",
    },
    {
      "title": "Connect a local engine",
      "body": "Ollama and llama.cpp server run independently of Naidan. Connect through their APIs when their model support or performance better fits your work. These engines use the permissions of their native process.",
    }
  ],
  storageCaption: 'The diagram’s “all data” and “no persistent footprint” refer to data held by the selected in-memory Naidan storage provider, including chats and settings.',
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
  "storageNote": "This choice covers chats, groups, settings and files held by Naidan’s selected storage provider. Model caches, exported files and operating-system memory management have separate lifetimes.",
  "standalone": { "title": "Double-click to start using AI.", "body": "Extract the Standalone ZIP, then double-click index.html on your PC. Naidan opens in your browser without an installer or a server to serve the app. Then choose a model or local engine for your work." },
  "standaloneLink": "Start without an installer or app server",
  standaloneDescription: 'Follow the steps from downloading the ZIP to opening the app and choosing a model.',
  "guidesTitle": "Find what you want to do.",
  "guidesLead": "Open the guide you need. Each page includes its own context, examples and important choices.",
  "guides": {
    gguf: {
      title: 'Chat with a GGUF model in your browser',
      body: 'Pick a model to try, or import a GGUF file you already have.',
    },
    image: {
      title: 'Create images on your device',
      body: 'Generate a first image with a local model, then reuse settings for another try.',
    },
    audio: {
      title: 'Make speech from text on your device',
      body: 'Generate, listen to and save a WAV with a local speech model.',
    },
    "branching": {
      "title": "Branch and edit a conversation",
      "body": "Try a different answer or revise an earlier message while keeping the original.",
    },
    "shell": {
      "title": "Let AI work with selected files",
      "body": "Choose files and folder access, then review the shell commands and results.",
    },
    groups: {
      title: 'Keep chats organized by purpose',
      body: 'Create a group, move chats into it and start another chat there.',
    },
    wikipedia: {
      title: 'Use Wikipedia to inform local AI answers',
      body: 'Look up articles during a chat and use them as a source for answers.',
    },
    offline: {
      title: 'Use Naidan offline as a PWA',
      body: 'Prepare the app and an on-device model while online, then test them without a connection.',
    },
  },
};
