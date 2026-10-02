# OpenCC Selection Converter

Safely convert the current visible selection in Obsidian using real OpenCC custom configurations while preserving Markdown structure and source outside the selection.

The plugin supports desktop and mobile code paths, vault files and URL-based schemes, offline caching, strict equal-length checks, atomic undo, the command palette, per-scheme commands and a context-menu entry. Release verification currently covers the Obsidian desktop application and its mobile simulation; Android and iOS devices have not yet been tested.

## Installation

There is currently no public community-store release. Build the plugin, then copy the release files to the vault’s plugin directory:

```text
npm ci
npm run build

Copy dist/main.js, dist/manifest.json and dist/versions.json to:
<Vault>/.obsidian/plugins/opencc-selection-converter/
```

Reload Obsidian and enable **OpenCC Selection Converter** under **Community plugins**. The fixed native engine assets in `engine/generated/` are bundled at build time; a clean plugin build needs only Node.js and npm dependencies. Conversion requires no network access at runtime.

To rebuild the native assets after changing the engine, run `npm run build:engine` with the OpenCC and emsdk source versions pinned in `engine/upstream.lock.json`. This regenerates `engine/generated/opencc.mjs` and `engine/generated/opencc.wasm`; include both updated assets with native source changes.

## Usage

```text
1. Open Settings → OpenCC Selection Converter → Add scheme.
2. Enter a scheme name and choose a vault JSON configuration or configuration URL.
3. Preview the configuration’s dictionary dependencies; review and explicitly approve HTTP resources when prompted.
4. Select text in Source mode or Live Preview.
5. Use Convert selection, a scheme command, or the context menu.
6. Undo once when needed to restore the complete conversion.
```

Each active scheme has its own stable command, which can be assigned a separate shortcut in Obsidian’s **Hotkeys** settings. No selection means no conversion of the whole note.

## Schemes and cache

- Supports real OpenCC JSON/JSONC configurations, inline, text, ocd and ocd2 dictionaries, and the conversion stages defined by the configuration.
- URL-relative dependencies are resolved relative to the configuration URL by default; vault-relative dependencies are resolved relative to the configuration file. Advanced settings can specify a dependency base or per-file overrides.
- HTTP uses exact-URL authorisation rather than authorising an entire domain. Selected note text is processed locally by the WASM engine; it is not uploaded, logged or written to the cache.
- A successful scheme saves a complete immutable snapshot for offline reuse. If a refresh fails, the previous usable snapshot is retained and its status is shown.

## Safe mapping and equal length

Strict mode checks every actual native OpenCC match and the final Unicode code-point count for the conversion. Any length change cancels the complete write.

**Force mode** allows length changes, but does not bypass selection boundaries, Markdown structure, link targets, region rules or candidate-source re-parsing. When a cross-format phrase cannot be assigned uniquely, the output inherits the formatting at the start of the phrase.

Manual **Length check** shows:

- Complete: equal length
- Length risk found
- Check incomplete

This is a scheme audit. It does not replace the actual per-conversion checks.

## Region rules

Inline code, code blocks, quotes, inline maths, block maths and maths groups each support three policies: always convert, convert only when the complete selection is inside the region, or never convert.

When a parent region is excluded, its child regions are excluded too. Maths supports a verified fixed subset, including common Greek and symbol commands, text and font commands, fractions, roots, subscripts, superscripts and escapes. Unknown macros, environments or ambiguous structures are rejected explicitly; the plugin does not guess the source mapping.

## Known limitations

- Only Markdown Source mode and Live Preview selections are supported; Reading mode selections are not supported.
- Multiple selections are rejected. Without a selection, the plugin never falls back to converting the whole note.
- Complex wikilink paths without aliases, headings and block references may be rejected conservatively.
- When conversion inside code is allowed, surrounding fences are protected, but programming-language semantics are not guaranteed.
- When Obsidian opens and saves a CRLF file, it may normalise line endings to LF. The plugin ensures that its conversion logic does not rewrite editor line endings, but does not promise byte-level fidelity on disk.
- Desktop mobile simulation is not equivalent to Android/iOS device acceptance; user-provided schemes must also be verified independently.

## Development and verification

Tests use a dedicated vault and clear this plugin’s test cache. Do not point them at a real vault. See [`docs/testing.md`](docs/testing.md) and [`docs/verification.md`](docs/verification.md).

```text
npm run check
npm run test:build
npm run test:cli -- smoke
npm run test:cli -- mapping
npm run test:cli -- editor
npm run test:cli -- settings
npm run test:cli -- production
npm test
```

## Acknowledgements

The conversion core is based on [OpenCC](https://github.com/BYVoid/OpenCC). Complete third-party sources, pinned versions and licences are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and `engine/licenses/`.

## Contributing

This repository currently has no public remote, issue tracker or formal contribution process. Do not assume that pull requests are accepted. Confirm with the repository owner before submitting changes; at minimum, run `npm run check` and the smallest relevant dedicated-vault test.

## Licence

[MIT](LICENSE) © 2026 OpenCC Selection Converter contributors. Third-party components, including the bundled native engine, retain the licences listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
