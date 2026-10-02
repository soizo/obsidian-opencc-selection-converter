# Markdown host fixtures

`host-tree-source.json` and `host-tree-live.json` were captured by `markdown/host-tree-probe` through the Obsidian CLI in the dedicated test vault (desktop 1.13.7). They contain synthetic test text only, not user notes.

The probe uses public `ensureSyntaxTree` and the plugin's public editor-extension association. No private `state.values` indexing is used. These files document observed token names; functional tests recreate the fixtures in the running host rather than treating saved JSON as a substitute for integration testing.

The complete executable case text and policy matrix live in `tests/cli/markdown.test.ts`. Math is explicitly unsupported until Task 7. Bare wikilinks with path/heading/block-reference syntax currently fail closed; simple bare wikilinks carry alias-insertion metadata and never authorize target replacement.
