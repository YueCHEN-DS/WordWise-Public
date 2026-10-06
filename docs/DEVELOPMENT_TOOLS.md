# Public developer tools

This repository publishes selected desktop source, core algorithms and support
tools. The hosted web portal is a separate service. Its backend, deployment
configuration and operator material are not part of this update.

## Check the staged public source

```bash
npm run check:public-files
```

`public-files.json` lists every approved public file. Stage your intended
changes, including any reviewed allowlist updates, before running the command.
The checker reads Git's **index**: an unstaged edit is not the content being
checked. It never stages, modifies or uploads files.

The check rejects paths outside the allowlist, private artifact paths, symlinks,
submodules, unresolved merges, unexpected binaries, files larger than 2 MiB,
and selected credential signatures or literal credential assignments. Paths
such as keys, runtime data, backups, datasets and model weights are refused
even if added to the allowlist. Public license verification keys are not
private signing keys. Failures identify filenames and reasons without printing
matched values.

This is a publication guard, not a complete secret or history audit. Review
the staged diff, screenshots and any allowlist additions yourself. It does not
inspect earlier commits or prove redistribution rights. Work from this public
repository; do not merge private repository history into it.

## Inspect desktop package selection

```bash
npm install
npm run check:package-files
```

This uses the installed electron-builder file matcher and the same platform
rules as the public build helper. It checks macOS and Windows runtime files,
selection of the appropriate native module/inference runtime, and exclusion
of private/development files. It does not rewrite package metadata, run a
build, or require private dictionaries, model weights, audio or prebuilt
native modules. Optional user-supplied runtime asset paths are checked without
reading their contents.

A passing selection check does not mean an installer was built or tested.

## Existing asset and build helpers

| Command | Purpose | Required local inputs |
| --- | --- | --- |
| `npm run pack-audio` | Pack MP3 files into the app's indexed `audio.pack` archive | Your own permitted `audio/*.mp3` files |
| `npm run prebuild-vocab` | Prepare SQLite vocabulary databases before packaging | A built `vocab-core` module and the expected wordlists in `db/` |
| `npm run dist:mac-arm64` / `npm run dist:mac-x64` | Build a macOS desktop package | Installed build dependencies, the matching native module and any runtime assets you intend to distribute |
| `npm run dist:win-x64` | Build a Windows desktop package | Installed build dependencies, the matching native module and any runtime assets you intend to distribute |

The audio packer also accepts explicit input/output paths:

```bash
node scripts/pack_audio_db.mjs --audio-dir ./my-audio --output ./audio.pack
```

The vocabulary prebuilder replaces matching generated vocabulary databases.
Run it in a dedicated build checkout, not over personal learning databases.
Missing wordlists are reported and skipped; a successful command alone does
not establish that every intended list was included.

The desktop build helper temporarily rewrites package/build metadata and
restores it afterward. Use a dedicated checkout for packaging. Model bundling
is opt-in with `WORDWISE_BUNDLE_MODELS=1` and requires the model files referenced
by the existing build script. These files are not supplied by this repository.
Use only vocabulary, audio and models you are allowed to redistribute.

The existing desktop package version remains **1.0.0**. The hosted portal's
v2.0 label does not change it.

## Tests

```bash
npm test
```

The public suite includes synthetic publication-guard cases and both package
selection checks. The native integration test skips when the matching
`vocab-core` binary has not been built. Report that skip explicitly; it is not
native-runtime or packaged-application acceptance.
