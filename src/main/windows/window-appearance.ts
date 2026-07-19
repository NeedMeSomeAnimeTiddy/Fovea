import type { WindowMaterial } from '@shared/contracts/ipc'
import type { Rectangle, Size } from '@shared/types/geometry'
import { deriveOuterSize, fitWindowSizesToWorkArea, type FittedWindowSizes } from './window-geometry'

// Keep paired with --fovea-color-canvas in the renderer design system.
export const WINDOW_BACKGROUND_COLOR = '#090b10'
export const WINDOW_TRANSPARENT_BACKGROUND_COLOR = '#00000000'

// Keep paired with --fovea-space-6. Electron and renderer geometry are both DIP/CSS pixels.
export const WINDOW_SURFACE_INSET = 12

export interface WindowSurfaceSizes {
  surfaceSize: Size
  minimumSurfaceSize: Size
}

export interface WindowAppearanceSizes extends FittedWindowSizes {
  material: WindowMaterial
  inset: number
}

export function getWindowAppearanceSizes(
  sizes: WindowSurfaceSizes,
  material: WindowMaterial,
  workArea?: Rectangle
): WindowAppearanceSizes {
  const inset = material === 'transparent' ? WINDOW_SURFACE_INSET : 0
  const size = deriveOuterSize(sizes.surfaceSize, material, WINDOW_SURFACE_INSET)
  const minimumSize = deriveOuterSize(sizes.minimumSurfaceSize, material, WINDOW_SURFACE_INSET)
  const fitted = workArea ? fitWindowSizesToWorkArea(size, minimumSize, workArea) : { size, minimumSize }

  return { ...fitted, material, inset }
}
