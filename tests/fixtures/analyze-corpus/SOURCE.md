# ScreenSpot Analyze regression corpus

These 20 screenshots are a deterministic subset of the ScreenSpot `test`
split hosted at <https://huggingface.co/datasets/bevaya/ScreenSpot>.
ScreenSpot is published under the Apache License 2.0 and provides one annotated
GUI target per screenshot. `manifest.json` records each selected row, original
filename, instruction, dimensions, normalized target bounds, and downloaded
image SHA-256.

The expected files set `partialAnnotations: true` because ScreenSpot annotates
the instructed target, not every visible element. They use ScreenSpot's GUI
grounding rule: a target is found when the centre of an Analyze result lands
inside the annotated region. Target recall, empty results, invalid labels, and
timing remain meaningful; unrelated Analyze targets are not counted as false
positives. The stricter hand-annotated fixtures in `../analyze` continue to use
box IoU and check duplicates and forbidden/occluded regions.

Reproduce the corpus and run the current screenshot-native pipeline with:

```powershell
npm run analyze:corpus:fetch
npm run analyze:regression
```

`analyze:regression` regenerates the `*.actual.json` results with the current
pipeline and enforces `thresholds.json`. `npm run analyze:corpus:check` checks
the committed baseline without loading the optional models.

The copied Apache 2.0 license is stored as `LICENSE.apache-2.0.txt`. See the
ScreenSpot/SeeClick dataset card for its academic citation and collection notes.
