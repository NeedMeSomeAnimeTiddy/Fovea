import { forwardRef, type HTMLAttributes, type Ref } from 'react'

import { classNames } from '../internal/classNames'

export type GlassPanelElement = 'div' | 'section' | 'article'
export type GlassPanelVariant = 'subtle' | 'default' | 'strong'
export type GlassPanelElevation = 'flat' | 'surface' | 'floating'

export interface GlassPanelProps extends HTMLAttributes<HTMLElement> {
  as?: GlassPanelElement
  elevation?: GlassPanelElevation
  variant?: GlassPanelVariant
}

export const GlassPanel = forwardRef<HTMLElement, GlassPanelProps>(function GlassPanel(
  { as: Element = 'div', className, elevation = 'surface', variant = 'default', ...panelProps },
  ref
) {
  return (
    <Element
      {...panelProps}
      className={classNames('fui-glass-panel', className)}
      data-elevation={elevation}
      data-variant={variant}
      ref={ref as Ref<HTMLDivElement>}
    />
  )
})
