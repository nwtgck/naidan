import type { BoundaryMessages } from '../../../site/messages';

export const strings = {
  "title": "How the browser limits access",
  "description": "Use the browser’s existing permission boundaries as the starting point for running AI.",
  "intro": [
    "Useful AI tools need access to data, not unrestricted access to the whole device. The browser already provides a boundary around a web page. Naidan builds its working environment inside that boundary."
  ],
  "diagramTitle": "Where the work happens",
  "app": "Naidan",
  "runtime": "Local model",
  "files": "Selected files",
  "permission": "Browser permission boundary",
  "flowLabel": "Data processed inside the browser",
  "motionLabel": "Animate the flow",
  "motionNote": "This diagram illustrates a boundary. It does not grant permissions or run a model.",
  "sections": [
    {
      "title": "The browser mediates access",
      "body": "A page uses browser APIs to access files, folders and device features. The available APIs and permissions determine which operations it can perform.",
    },
    {
      "title": "Local processing keeps input on this device",
      "body": "With a browser model selected, inference runs on this device. Downloading a model still contacts its distribution service.",
    },
    {
      "title": "Connections have their own boundary",
      "body": "Content Security Policy (CSP) can further restrict connections. A local native engine, or an external tool, operates under its own permissions.",
    }
  ],
  "next": "Choose file and folder access",
} satisfies BoundaryMessages;
