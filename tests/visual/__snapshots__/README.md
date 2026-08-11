# Approved visual baselines

Playwright writes reviewed PNG baselines below a project-specific directory here. Generate them only in the pinned Windows environment described in `docs/visual-qa.md`; CI must never accept or update them automatically during a pull request.

The initial dependency install and baseline generation are intentionally separate from the renderer harness so reviewers can inspect every first-generation image before committing it.
