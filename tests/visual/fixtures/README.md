# Visual fixture policy

Everything rendered by this folder is synthetic and deterministic. The fixtures must never contain:

- a real screenshot, account, email address, filesystem path, provider response, token, or API key;
- live network content or a URL that the harness can navigate to;
- timestamps, random values, animation-dependent text, or machine-specific state.

`synthetic-captures.ts` generates the wide, tall, tiny, and desktop-shaped images as inline SVG data URLs. The address `demo@fixture.invalid` and the `C:\Synthetic` path are reserved-looking examples, not live data. Keep all future visual content similarly explicit.

The mock implements the production `FoveaApi` type. If the preload contract changes, type checking must force the fixture to change with it. It may return state and no-op results, but it must never import Electron or call a provider, desktop capture, the filesystem, or the public network.
