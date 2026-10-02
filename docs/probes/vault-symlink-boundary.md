# Vault symbolic-link boundary probe

Obsidian desktop 1.13.7; dedicated `OpenCC-Selection-Converter-Test` vault.

## Observed

A newly created, agent-owned fixture directory outside the vault was linked into `__opencc_tests__`. Obsidian indexed the linked file as a normal vault file. `app.vault.read(file)` returned the external fixture's unique synthetic marker.

```json
{"indexed":true,"path":"__opencc_tests__/link-c27fc295-ab3d-4d1f-ad50-5979b8b0c30a/probe.txt","readMatches":true}
```

Fixture directory: `~/Desktop/PlayGround/OpenCC-Outside-Fixture-Zc793y`. The directory/link are preserved as evidence; they contain only the synthetic test marker, not user data. Node prepared fixtures and invoked the CLI; the indexing/read checks executed inside Obsidian.

## Implication

`getAbstractFileByPath` plus `TFile` validation enforces the host's logical vault index, **not physical disk containment**. The installed public cross-platform API exposes no symlink/realpath field on `FileStats`; desktop-only `FileSystemAdapter` path methods do not establish a mobile-compatible isolation guarantee.

The user clarified the intended requirement: putting files in the vault should make them readable; physical disk sandboxing is not requested. Continue using the host's vault index without adding desktop-only Node realpath checks or disabling local sources. No OS sandbox claim is made.
