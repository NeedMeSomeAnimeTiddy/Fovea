# Analyze evaluation fixtures

Each frozen-screen case is a pair of files with the same prefix:

- `<name>.expected.json` describes only features visibly present in the frozen bitmap.
- `<name>.actual.json` contains the `CaptureAnalysis.features` emitted by a backend.

All bounds are normalized `{ "x", "y", "width", "height" }` values between 0 and 1.
Expected features may set `"visible": false` or `"ignore": true`. Use
`"forbiddenRegions"` for parts of the bitmap where a detector must not emit boxes,
such as an occluded window or a known empty panel.

Run `npm run analyze:evaluate`, or pass another fixture directory as the first
argument. Add `--json` for machine-readable output.
