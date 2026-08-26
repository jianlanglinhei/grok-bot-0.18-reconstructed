# Provenance

The reconstruction is based on the public macOS arm64 release artifact:

- Product: Grok Bot
- Version: 0.24.0
- Upstream bundle ID: `com.anysphere.sand`
- Electron framework: 42.1.0
- DMG URL: `https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.24.0/Grok_Bot_0.24.0.dmg`
- DMG SHA-256: `255873da42d2f19b27d7f34cdfb5b058002095ade883d8b321d6494f3cf6c615`
- Original `app.asar` SHA-256: `41f7d5008db4edcb198d9e466c9c1e776bb8a75a7651951257ff9a4f885a4540`
- Release manifest: `manifests/upstream/0.24.0.json`

The current 0.24.0 artifact is downloaded on demand and accepted only after its
DMG and ASAR hashes match the release manifest. Separately, the repository
preserves the historical 0.18.0 macOS and Windows installers through Git LFS.
The preserved Windows artifact identity is:

- Installer URL: `https://downloads.cursor.com/grokbot/stable/win32-x64/0.18.0/Grok_Bot_0.18.0_Setup.exe`
- Installer SHA-256: `464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e`
- Preservation manifest: `research-archives/original/0.18.0/artifacts.json`

The original application was Developer ID signed and notarized by Anysphere Incorporated. Reconstructed builds are intentionally given a different bundle ID and only ad-hoc signed; they do not retain or claim the upstream signature.

The 0.24.0 ASAR contains optimized production bundles and no source maps. The
`recover:upstream` command produces parsed, readable-printed JavaScript, not the
original authored source. Original names, comments, TypeScript types, and module
layout cannot be recovered exactly from this artifact. The readable `frontend/`
tree is therefore a partial evidence-backed reconstruction, while packaged
builds retain the pinned renderer and apply only a narrow, hash-recorded
settings transform.

No upstream source-code license is implied. Do not present reconstructed
material as original source or an official build, and complete an independent
rights review before public redistribution.

## Evidence-only reconstruction rule

The immutable release is the product specification. Recovered source may express
only behavior supported by at least one inspectable artifact anchor: emitted code
or source-path markers, extracted capsules/source maps, shipped strings/assets/CSS,
renderer DOM signatures, IPC/RPC contracts, or repeatable observation of the
shipped runtime.

This rule is especially strict for the renderer. Do not invent or redesign a
screen, route, control, label, selector, state, or interaction to fill an evidence
gap. A clean abstraction or test seam is acceptable only when it preserves
artifact-derived semantics and does not add product behavior. When evidence is
incomplete, record the uncertainty and leave the feature unmapped or
evidence-only instead of guessing.

Every UI-facing recovery must identify its artifact anchor in its evidence
catalog, focused test, or coverage note. Passing typecheck/build alone is not
proof of provenance; speculative behavior is a release-blocking defect.
