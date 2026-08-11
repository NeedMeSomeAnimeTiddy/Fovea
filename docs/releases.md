# Signed Windows releases and application updates

Fovea uses GitHub Releases as its update source. Updates are available only to packaged x64
builds carrying the production release marker. Development runs and ordinary local packages do
not carry that marker and must not contact the production update feed.

The initial updater implementation uses the stable `latest` channel and the standard NSIS
installer. It does not support prereleases, automatic downgrades, ARM64, NSIS web installers, or
silent installation.

## Security model

An installable update must pass both checks:

1. Its bytes match the SHA-512 digest in `latest.yml`.
2. Its Authenticode signer exactly matches the publisher recorded in the installed application's
   production update configuration.

The application never downloads an update merely because a check found one, and an ordinary app
quit never installs a downloaded update. The user reviews the release notes, starts the download,
and explicitly chooses to run the installer.

The production builder configuration sets `forceCodeSigning: true`. A release build therefore
fails instead of emitting unsigned artifacts when signing is unavailable. It also embeds this
marker in the packaged `package.json`:

```json
{
  "foveaUpdateRelease": {
    "schemaVersion": 1,
    "enabled": true,
    "provider": "github",
    "repository": "NeedMeSomeAnimeTiddy/Fovea",
    "channel": "latest",
    "architectures": ["x64"],
    "publisherName": "the exact certificate common name",
    "integrity": "sha512-and-authenticode",
    "installMode": "user-confirmed"
  }
}
```

The updater treats a missing, malformed, wrong-repository, or wrong-architecture marker as
ineligible. The normal package configuration remains unsigned and marker-free for local testing.

## Repository configuration

Configure these GitHub values before pushing a release tag:

| Kind | Name | Purpose |
| --- | --- | --- |
| Actions variable | `FOVEA_WINDOWS_PUBLISHER` | Exact Common Name returned by the signing certificate |
| Actions secret | `WIN_CSC_LINK` | Base64 PFX content or another electron-builder-supported certificate reference |
| Actions secret | `WIN_CSC_KEY_PASSWORD` | Password for the signing certificate |

Do not commit the certificate or its password. If the publisher identity changes, ship a planned
certificate-transition release before changing the configured name. Existing installations trust
the publisher embedded in their own signed release configuration.

## Version and channel policy

- `package.json` contains the canonical version.
- A production tag is exactly `vMAJOR.MINOR.PATCH` and must match that package version.
- The `latest` channel contains stable releases only.
- Every replacement or emergency fix receives a higher version. Never replace the bytes of an
  already published version or reuse its tag.
- The first production rollout is x64 only. ARM64 needs its own measured, signed, end-to-end tested
  artifact and feed policy before it can be added to the release marker.

## Release procedure

1. Update the package version and release notes, then merge the fully validated source.
2. Push the matching version tag, for example `v0.2.0`.
3. The `Signed Windows release` workflow runs the normal release checks.
4. The workflow loads `build/electron-builder.release.cjs`. The config refuses to load without all
   three signing values, signs the unpacked application and NSIS installer, and generates the
   installer blockmap and `latest.yml`.
5. The workflow verifies the embedded release marker, both Authenticode signatures, the timestamp,
   exact publisher name, artifact set, version, installer URL, and SHA-512 digest.
6. Only after those checks pass, the workflow creates a draft GitHub Release and attaches the
   installer, blockmap, and `latest.yml`.
7. Download the preserved workflow artifact and complete the installed-update test below.
8. Publish the draft release manually. Draft releases are not visible to the production updater.

If any verification step fails, do not upload or publish the artifacts manually as a workaround.
Correct the source, version, signing configuration, or release environment and create a new tag.

## Installed-update acceptance test

This test requires two signed versions and cannot be replaced by an unpackaged development run.

1. Install signed version N on a clean supported Windows x64 machine.
2. Confirm automatic checks default to off and normal capture/settings use remains available.
3. Publish signed version N+1 as the latest stable GitHub Release.
4. In version N, check manually. Confirm the version and release notes are shown without downloading.
5. Enable and disable automatic checks, restart, and confirm the preference survives both changes.
6. Download N+1. Confirm progress is visible and normal use remains available after an offline or
   interrupted attempt.
7. Quit normally before choosing install. Confirm N+1 is not installed.
8. Download again if needed, explicitly choose install, complete the visible NSIS flow, and confirm
   Fovea restarts as N+1 with settings and history intact.
9. In an isolated test release, verify a corrupted installer is rejected by SHA-512 validation and
   an installer signed by another publisher is rejected by Authenticode validation.

An existing build that did not contain updater support cannot update itself. The first signed,
updater-capable version is therefore a manual bridge install for users of earlier builds.

## Failure and recovery

Update failures do not prevent Fovea from starting or handling captures. The UI should retain a
short actionable failure state, allow an appropriate retry, and keep technical details free of
tokens and local user paths.

Fovea does not perform automatic rollback or downgrade. For manual recovery:

1. Quit Fovea.
2. Download a previously retained signed installer from its immutable GitHub Release.
3. Verify its Authenticode publisher before running it.
4. Run the installer interactively. Do not delete application data; settings and history are kept
   by the NSIS configuration.

If a bad release reached users, publish a corrected build with a higher version so every affected
installation can move forward. Removing or replacing `latest.yml` is not a rollback strategy.
