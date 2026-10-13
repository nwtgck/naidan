import type { FilesMessages } from '../../../site/messages';

export const strings = {
  "title": "Keep control of your files",
  "description": "Choose which files an AI can read or edit, and whether it works on a linked folder or an independent copy.",
  "intro": [
    "Sharing a project with AI does not have to mean sharing your entire computer. Naidan lets you choose the working folder and its access mode."
  ],
  "methods": [
    {
      "title": "Link a folder",
      "body": "A linked folder refers to files on your device through a browser-granted handle. Writing requires both browser permission and a writable mount in Naidan.",
    },
    {
      "title": "Copy a folder",
      "body": "A copied folder becomes an independent workspace in browser storage. Edits affect the copy; you can review and download the result.",
    }
  ],
  "permissions": {
    "title": "Read access and write access are different",
    "body": "Choose read-only access for inspection. Enable writing when the task involves editing. Availability depends on browser support and permissions.",
  },
  "stepsTitle": "Choose a working folder",
  "steps": [
    "Open the attachment menu in your Chat.",
    "Choose Folder Link or Folder Copy and select the folder.",
    "Check the mount path and access mode before asking AI to work on it."
  ],
  "next": "Read about the browser boundary",
} satisfies FilesMessages;
