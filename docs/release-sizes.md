# Windows release sizes

Record the output of `npm run package:size:check` for every release architecture.
Sizes use MiB (1,048,576 bytes). “Full installed” is the minimal unpacked package
plus the optional verified ChatGPT runtime; settings, history, and caches are excluded.

## 0.1.0 baseline — 2026-08-04

| Architecture | Minimal installer | Minimal unpacked | ChatGPT runtime | Full installed | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| x64 | 111.6 MiB (116,970,213 B) | 414.8 MiB (434,937,301 B) | 325.3 MiB (341,142,832 B) | 740.1 MiB (776,080,133 B) | Measured |
| ARM64 | ≤125.0 MiB release budget | ≤465.0 MiB release budget | 280.3 MiB (293,900,080 B) | ≤745.3 MiB release budget | Measure on ARM64 release runner |

The previous x64 package bundled Codex: its installer was 192.1 MiB and its unpacked
directory was 774.8 MiB. The minimal x64 build therefore removes about 80.5 MiB from
the installer and 360.0 MiB from the installed core for users of API-key providers.

## Release procedure

1. Run `npm run package:win` on each release architecture.
2. Copy the exact installer and unpacked values printed by the size report into this table.
3. Add the pinned runtime size from `resources/runtime/codex-runtime-manifest.json`.
4. Investigate every warning and update `package-size-budget.json` only with a documented reason.
