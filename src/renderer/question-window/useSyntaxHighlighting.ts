import { useEffect, useMemo, useState } from 'react'
import type { Options } from 'react-markdown'

type RehypePlugins = NonNullable<Options['rehypePlugins']>
type RehypePlugin = RehypePlugins[number]

/**
 * `rehype-highlight` statically imports lowlight's 37 common grammars, which is roughly half of
 * this window's script and cannot be trimmed by passing a smaller `languages` option. Loading it
 * after first paint lets an answer start rendering against a much smaller bundle; the import is a
 * local file, so highlighting almost always arrives before a streamed code block finishes.
 */
let pending: Promise<RehypePlugin> | null = null

function loadHighlighter(): Promise<RehypePlugin> {
  pending ??= import('rehype-highlight').then((module) => module.default as RehypePlugin)
  return pending
}

const NONE: RehypePlugins = []

export function useSyntaxHighlighting(): RehypePlugins {
  const [plugin, setPlugin] = useState<RehypePlugin | null>(null)
  useEffect(() => {
    let active = true
    // The plugin is itself a function, so it has to be stored behind an updater.
    void loadHighlighter()
      .then((loaded) => { if (active) setPlugin(() => loaded) })
      .catch(() => undefined)
    return () => { active = false }
  }, [])
  return useMemo(() => (plugin ? [plugin] : NONE), [plugin])
}
