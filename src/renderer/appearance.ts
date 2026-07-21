import type { AppearanceState } from '@shared/types/app'

export function applyAppearance(state: AppearanceState): void {
  document.documentElement.dataset.appearance = state.preference
  document.documentElement.dataset.theme = state.resolved
}

export async function initialiseAppearance(): Promise<() => void> {
  applyAppearance((await window.fovea.settings.get()).appearance)
  return window.fovea.settings.onAppearanceChanged(applyAppearance)
}
