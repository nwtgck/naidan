import type { BranchingMessages } from '../../../site/messages';

export const strings = {
  "title": "Branch a conversation",
  "description": "Keep the original conversation and try a different reply or instruction from the same point.",
  "intro": [
    "A conversation can have more than one continuation. You can keep the original exchange and try another direction from an earlier message."
  ],
  "stepsTitle": "Try a different continuation",
  "steps": [
    "Open the actions for the message you want to revisit.",
    "Edit or resend the message, or regenerate a response.",
    "Switch between the resulting branches to compare them."
  ],
  "demoTitle": "Try switching branches",
  "demo": {
    "label": "Example conversation branches",
    "prompt": "Explain how a browser model handles my input.",
    "replies": [
      "The model processes the input on this device.",
      "Think of the model as a local tool: once ready, it works on the text you provide here."
    ],
    "choices": [
      "Original explanation",
      "Alternative explanation"
    ],
    "reset": "Return to original",
    "note": "Choose a path in this sample conversation. Both replies remain available.",
  },
  "detail": {
    "title": "Switch paths or start a separate Chat",
    "body": "Branches created by editing or regenerating can be compared within the same Chat. Fork creates a separate Chat from a chosen point instead. Use a branch for another continuation, or a fork for independent work. A Chat Group can keep related Chats together.",
  },
  "next": "Explore the browser shell",
} satisfies BranchingMessages;
