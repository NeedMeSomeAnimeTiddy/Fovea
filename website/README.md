# Fovea showcase site

The marketing and product page for [Fovea](../README.md), the Windows-first
visual assistant. It is a single-page site (`app/page.tsx`) with a hero,
"how it works" story, feature carousel, an interactive "Ask lab" demo, a
privacy section, and a GitHub link. The "Download for Windows" button currently
shows an "installer coming soon" toast rather than a real download.

## Stack

- [vinext](https://github.com/cloudflare/vinext) `0.0.50` — Next.js 16 App
  Router semantics (`app/layout.tsx`, `app/page.tsx`, `next/font`,
  `generateMetadata`) compiled by Vite 8 with React 19 server components.
- Tailwind CSS 4 through `@tailwindcss/postcss`; the page's own styles and
  light/dark theme tokens live in `app/globals.css`.
- `@cloudflare/vite-plugin` and Wrangler: the build emits a Cloudflare Worker
  (`worker/index.ts`) that serves the RSC app and vinext image optimisation.
- Drizzle ORM with an intentionally empty `db/schema.ts`; D1/R2 bindings are
  declared in `.openai/hosting.json` (both `null` today) and simulated locally
  by `vite.config.ts`. `examples/d1/` shows how to opt in.
- `app/chatgpt-auth.ts` provides optional Sign-in-with-ChatGPT helpers. The
  showcase page does not use them.

## Running locally

Requires Node.js 22.13 or later. All commands run inside `website/`:

```bash
npm ci
npm run dev      # vinext dev server with HMR
npm run build    # writes the worker and assets to dist/
npm run start    # serves the production build
npm run lint     # eslint with eslint-config-next
npm test         # runs the build, then node --test tests/
```

`npm run db:generate` produces Drizzle migrations if a schema is ever added.

## Tests

`tests/rendered-html.test.mjs` imports the built worker from
`dist/server/index.js`, fetches `/`, and asserts that the Fovea showcase page
renders (title, navigation, hero, feature carousel, Open Graph image) and that
none of the vinext starter's preview scaffolding is left in the tree. CI runs
`npm test` on every change under `website/`.

## Deployment

`vite.config.ts` composes `vinext()`, the local `sites()` plugin from
`build/sites-vite-plugin.ts`, and `cloudflare()` with a `worker/index.ts`
entry, `nodejs_compat`, and any declared D1/R2 bindings. There is no
`wrangler.jsonc`; the `sites()` plugin copies `.openai/hosting.json` and the
`drizzle/` folder into `dist/.openai/` after each build, which is what the
hosting control plane reads. The output is a Cloudflare Workers bundle and can
be deployed with Wrangler by supplying that configuration.
