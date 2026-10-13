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
    "note": "Illustrative conversation only. Your Naidan chats are unchanged.",
  },
  "detail": {
    "title": "Keep the earlier path",
    "body": "Changing which branch you view does not overwrite the other branch. A Chat Group can organize related Chats while each Chat keeps its conversation paths.",
  },
  "next": "Explore the browser shell",
} satisfies BranchingMessages;
