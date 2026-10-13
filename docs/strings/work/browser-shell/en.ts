import type { ShellMessages } from '../../../site/messages';

export const strings = {
  "title": "Work with a shell inside the browser",
  "description": "Use familiar file, text and Git commands without handing over the PC’s native shell.",
  "intro": [
    "Inspecting a project is easier with tools that can list, search and transform files. Naidan provides those tools inside the browser, with access to the workspace and folders selected for the Chat."
  ],
  "diagramCaption": "The terminal layout follows Naidan’s Shell view. This read-only example lists the current Chat through /sys/fs/naidan; paths belong to the browser’s virtual filesystem.",
  "sections": [
    {
      "title": "Familiar commands, a browser-backed filesystem",
      "body": "The shell is called Wesh internally. Commands such as ls, cat, grep, sed, jq and Git operate on its mounted filesystems. An OS executable is not automatically a Wesh command: each supported command is implemented for this environment.",
    },
    {
      "title": "A workspace scoped to the conversation",
      "body": "Shell-enabled Chats can have a writable workspace. Global, Chat Group and Chat settings resolve which folders are mounted; a more specific mount at the same path takes precedence. Read-only settings separate inspecting data from modifying it.",
    },
    {
      "title": "Let the AI read the conversation as files",
      "body": "Naidan projects Chat information into /sys/fs/naidan as read-only Markdown and JSON files. Choose the current Chat, its Chat Group or the main Chat collection as the visible scope. These familiar file formats let the AI use ordinary shell commands to find information without exposing all history by default.",
    }
  ],
  "stepsTitle": "Give a Chat a working shell",
  "steps": [
    "Open the Chat’s tool settings and enable Shell. Check whether a setting is inherited from the Chat Group or global settings.",
    "Inspect the effective folder mounts, write access and which Chats the shell can see.",
    "Start with a listing or a read-only question. When using the human-facing terminal, choose the session belonging to the same Chat."
  ],
  "exampleTitle": "Inspect the current Chat",
  "exampleNote": "These commands read the current Chat when that scope is enabled. The metadata file describes the Chat; content-md and branches expose its messages and paths. This example does not modify data.",
  "next": "Set file and folder access",
} satisfies ShellMessages;
