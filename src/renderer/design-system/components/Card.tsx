import { forwardRef, type HTMLAttributes, type Ref } from 'react'

import { classNames } from '../internal/classNames'

export type CardElement = 'div' | 'section' | 'article'
export type CardVariant = 'default' | 'interactive'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: CardElement
  variant?: CardVariant
}

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { as: Element = 'div', className, variant = 'default', ...cardProps },
  ref
) {
  return (
    <Element
      {...cardProps}
      className={classNames('fui-card', className)}
      data-variant={variant}
      ref={ref as Ref<HTMLDivElement>}
    />
  )
})
