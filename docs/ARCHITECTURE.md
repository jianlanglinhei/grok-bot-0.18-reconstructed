# Architecture

The repository keeps two editable source roots:

- `source/` contains the Electron main, host, coordinator, local-exec, shared,
  and protocol reconstruction.
- `frontend/` contains the React renderer reconstruction.

The upstream 0.24.0 application is an external, checksum-pinned build input.
`npm run bootstrap` extracts its `dist` tree to ignored `src/app/dist`. Build
scripts stage that baseline, compile reviewed source runtimes, overlay the 12
eligible clean outputs, apply the reconstructed updater guard and Router UI
extension, and pack a new ASAR. The 0.24 Electron main, Host, renderer,
ABI-matched dependencies, native tools, and Electron shell remain explicit
artifact boundaries; the prior 0.18 clean bindings are not relabeled as 0.24
source without release-specific evidence.

`npm run recover:upstream` separately parses and readable-prints inspectable
application payloads to `recovered/upstream/0.24.0`. This is a forensic aid, not
an exact source restoration: the release contains no source maps.

Small manifests remain checked in only where the build consumes them directly.
Large recovery reports, source capsules, rejected candidate evidence, and
screenshots live only in the private forensic history and are not part of this
branch's product tree.
