# Project Agent Guidelines

## UI and interaction design

- Design from the user’s task, not the implementation model.
- Follow Obsidian’s native settings, modal, menu, notice, and command patterns. Reuse Obsidian components before adding custom UI.
- Keep the entry barrier low and the capability ceiling high: common actions should require minimal knowledge and as few steps as practical; advanced configuration must remain available through progressive disclosure.
- Prefer useful defaults. The first scheme may become the default, names may be inferred when safe, and official presets should be quick to add.
- Keep primary flows obvious: add, edit, save, cancel, and return must behave consistently. Put infrequent or destructive actions in a native secondary menu.
- Do not expose implementation details such as cache identifiers, snapshot internals, dependency mechanics, or long source paths unless the user asks for details or needs them to resolve a problem.
- Keep interface copy short and action-oriented. Do not repeat explanations already implied by labels or Obsidian conventions.
- Preserve required validation, security confirmations, recovery behavior, accessibility, and advanced controls. Simplicity must not remove safety or capability.
- Keep conversion, storage, and Markdown behavior unchanged during UI-only work unless the task explicitly requests otherwise.
- Verify changed UI in the real Obsidian host, including relevant light/dark and narrow-window states. Run the smallest relevant tests plus the full regression before claiming completion.

## Git

- Create focused local commits when the user requests automatic commits.
- Never push; the user handles all pushes.
- Preserve unrelated working-tree changes and exclude them from the commit.
