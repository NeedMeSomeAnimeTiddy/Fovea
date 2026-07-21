import type { WindowMaterial } from '@shared/contracts/ipc'
import type { Rectangle, Size } from '@shared/types/geometry'
import { deriveOuterSize, fitWindowSizesToWorkArea, type FittedWindowSizes } from './window-geometry'

// Keep paired with --fovea-color-canvas in the renderer design system.
export const WINDOW_BACKGROUND_COLOR = '#090b10'
export const WINDOW_LIGHT_BACKGROUND_COLOR = '#f3f6fa'
export const WINDOW_TRANSPARENT_BACKGROUND_COLOR = '#00000000'
let resolvedBackgroundColor = WINDOW_LIGHT_BACKGROUND_COLOR

export function setWindowBackgroundAppearance(appearance: 'dark' | 'light'): void {
  resolvedBackgroundColor = appearance === 'dark' ? WINDOW_BACKGROUND_COLOR : WINDOW_LIGHT_BACKGROUND_COLOR
}

export function resolveWindowBackgroundColor(
  material: WindowMaterial,
  appearance: 'dark' | 'light'
): string {
  if (material === 'transparent') return WINDOW_TRANSPARENT_BACKGROUND_COLOR
  return appearance === 'dark' ? WINDOW_BACKGROUND_COLOR : WINDOW_LIGHT_BACKGROUND_COLOR
}

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

export interface WindowAppearanceOptions extends WindowAppearanceSizes {
  frame: false
  transparent: boolean
  backgroundColor: string
  show: false
  useContentSize: true
  hasShadow: boolean
  resizable: boolean
  maximizable: boolean
  minimizable: true
  closable: true
  movable: true
  fullscreenable: false
  thickFrame: boolean
  roundedCorners: false
}

export interface WindowMaterialSelectionOptions {
  disableTransparentWindows?: boolean
  argv?: readonly string[]
  environment?: Readonly<Record<string, string | undefined>>
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

export function getWindowAppearanceOptions(
  sizes: WindowSurfaceSizes,
  material: WindowMaterial,
  workArea?: Rectangle
): WindowAppearanceOptions {
  const appearance = getWindowAppearanceSizes(sizes, material, workArea)
  const solid = material === 'solid'

  return {
    ...appearance,
    frame: false,
    transparent: !solid,
    backgroundColor: solid ? resolvedBackgroundColor : WINDOW_TRANSPARENT_BACKGROUND_COLOR,
    show: false,
    useContentSize: true,
    hasShadow: solid,
    resizable: solid,
    maximizable: solid,
    minimizable: true,
    closable: true,
    movable: true,
    fullscreenable: false,
    thickFrame: solid,
    roundedCorners: false
  }
}

export function selectWindowMaterial({
  disableTransparentWindows = false,
  argv = process.argv,
  environment = process.env
}: WindowMaterialSelectionOptions = {}): WindowMaterial {
  const commandLineDisabled =
    disableTransparentWindows || argv.some((argument) => argument === '--disable-transparent-windows')
  const development = !environment.NODE_ENV || environment.NODE_ENV === 'development'
  const environmentDisabled = development && isEnabledOverride(environment.FOVEA_DISABLE_TRANSPARENT_WINDOWS)
  return commandLineDisabled || environmentDisabled ? 'solid' : 'transparent'
}

function isEnabledOverride(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}
