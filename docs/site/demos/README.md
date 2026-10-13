# Source-derived documentation demonstrations

Docs deliberately owns independent replicas of application presentation.
Duplication is intentional: do not share or import the application’s UI
components, stores, providers, browser file handles or model runtimes. This keeps
static Docs deterministic and independent of model assets. Reproduce important
layout and interactions accurately using current source and tests. UI labels,
sample conversations, diagram text and accessible labels follow the page locale
through typed build-time props. Keep genuine commands, paths, filenames and tool
identifiers in their authentic form.

## Source counterparts

Use the current `src/` implementation and its behavior tests as the reference.
Check the following counterparts when updating a demonstration; old archives
and previous Docs versions do not define current application behavior.

| Demonstration | Application counterparts |
| --- | --- |
| `ReplicaChrome.vue`, `../BrowserMock.vue` | `src/components/Sidebar.vue`, `src/components/ChatPaneHeader.vue`, `src/components/ChatInput.vue`, `src/components/MessageItem.vue`, `src/components/MessageActions.vue`; `src/components/ChatInput.test.ts`, `src/components/Sidebar.test.ts` |
| `FolderAccessDemo.vue` | `src/components/ChatAttachMenu.vue`, `src/components/VolumeMountList.vue`, folder link/copy entries; `src/features/tools/wesh/chat-workspace.test.ts` |
| `ShellWorkspaceDemo.vue` | `src/components/AssistantProcessSequence.vue`, `src/features/tools/components/ShellExecuteToolCall.vue`, `src/features/tools/components/ToolCallItem.vue`; `src/features/tools/components/ShellExecuteToolCall.test.ts` |
| `../../islands/branching/BranchingDemo.vue` | `src/components/MessageActions.vue`, `src/components/MessageActionsMenu.vue`, `src/components/MessageItem.vue`, `src/logic/chat-tree.ts`; `src/components/MessageActionsMenu.test.ts`, `src/logic/chat-tree.test.ts` |
| `StandaloneDemo.vue` | root `README.md`, Standalone package layout and download instructions |
| `BoundaryDiagram.vue` | root `README.md`, nested OS/browser boundaries, browser API and permission paths, localhost engine connections |
| `ConnectionSettingsStep.vue` | `src/components/Sidebar.vue`, `SettingsModal.vue`, `ConnectionTab.vue`, `ModelSelector.vue`, `ServerSetupGuide.vue`; `src/components/SettingsModal.test.ts`; `src/constants.ts` local endpoint presets |

The chat chrome uses the application's gray-900/800 surfaces, gray-700 borders,
blue action color, logo and Lucide icons. Ordinary CSS replaces Tailwind because
Docs use their own compiler. Decorative icon buttons in static examples are not
focusable or presented as usable actions. Actual controls are reserved for the
branching island, the theme selector and the motion pause control.

## Motion policy

Motion is enabled initially and illustrates a specific operation. Streamed chat
content accumulates in reading order. A replay may reset the complete scene
together; do not erase individual messages from the bottom upward. Keep the
scene’s compact document footprint stable throughout an animation. Use pauses
where repeated movement helps explain an operation. The shared
`data-docs-animation` contract allows the global CSS pause
control and reduced-motion preference to stop it. All explanatory content remains
in the surrounding prose; no instruction requires tracking a moving object.
Update static, reduced-motion and narrow-layout checks when changing a diagram.

A demonstration is not a captured running session. Guide captions can explain
the operation where useful; the homepage does not need a disclaimer caption.
Maintain fidelity by inspecting source and behavior tests. Do not add screenshot
capture to the build or require a capture workflow before updating a replica.
