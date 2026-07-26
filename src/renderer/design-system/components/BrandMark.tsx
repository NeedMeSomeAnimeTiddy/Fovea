import { forwardRef, type ImgHTMLAttributes } from 'react'

import brandMarkUrl from '../../../../resources/assets/fovea-aperture.svg?url'
import { classNames } from '../internal/classNames'

export type BrandMarkProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>

export const BrandMark = forwardRef<HTMLImageElement, BrandMarkProps>(function BrandMark(
  { alt = '', className, ...imageProps },
  ref
) {
  return (
    <img
      {...imageProps}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={classNames('fui-brand-mark', className)}
      draggable={false}
      ref={ref}
      src={brandMarkUrl}
    />
  )
})
