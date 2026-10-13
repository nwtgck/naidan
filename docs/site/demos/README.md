# Source-derived documentation demonstrations

These components intentionally duplicate selected application presentation code.
They never import stores, providers, browser file handles or model runtimes. This
keeps static Docs deterministic and independent of model assets. Text is sample
data and visual UI labels remain English in both language editions. Surrounding
localized captions describe the example and supply a stationary explanation.

## Source counterparts

The baseline is the application source delivered with `naidan-develop(142).zip`,
plus the applied Docs core. Check these files when updating the demonstrations.

| Demonstration | Application counterparts |
| --- | --- |
| `ReplicaChrome.vue`, `../BrowserMock.vue` | `src/components/Sidebar.vue`, `ChatPaneHeader.vue`, `ChatInput.vue`, `MessageActions.vue` |
| `FolderAccessDemo.vue` | `src/components/ChatAttachMenu.vue`, `VolumeMountList.vue`, folder link/copy entries |
| `ShellWorkspaceDemo.vue` | `src/features/wesh-terminal/`, `src/features/wesh/naidan-sysfs/entries/chat.ts` |
| `../../islands/branching/BranchingDemo.vue` | `src/components/MessageActions.vue`, message edit/regenerate/fork actions |
| `StandaloneDemo.vue` | root `README.md`, Standalone package layout and download instructions |
| `BoundaryDiagram.vue` | root `README.md`, browser-local execution and model download distinction |

The chat chrome uses the application's gray-900/800 surfaces, gray-700 borders,
blue action color, logo and Lucide icons. Ordinary CSS replaces Tailwind because
Docs use their own compiler. Decorative icon buttons in static examples are not
focusable or presented as usable actions. Actual controls are reserved for the
branching island, the theme selector and the motion pause control.

## Motion policy

Motion is enabled initially and illustrates one operation, with pauses between
cycles. The shared `data-docs-animation` contract allows the global CSS pause
control and reduced-motion preference to stop it. All explanatory content remains
in the surrounding prose; no instruction requires tracking a moving object.
Update static, reduced-motion and narrow-layout checks when changing a diagram.

A demonstration is not a captured running session. Captions identify sample data
without suggesting that the entire visual design is unrelated to Naidan. Future
screenshots can coexist with these examples and have a separate capture workflow.
