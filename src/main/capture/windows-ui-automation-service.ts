import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CaptureFeature, CaptureFeatureKind } from '@shared/types/app'
import type { Rectangle } from '@shared/types/geometry'

const execFileAsync = promisify(execFile)
const SNAPSHOT_TIMEOUT_MS = 3_500
const MAX_ELEMENTS = 4_000
const INVALID_SEMANTIC_STRINGS = new Set(['undefined', 'null', 'none', 'unknown', 'n/a', 'na'])

export interface UiAutomationElementSnapshot {
  name: string
  legacyName?: string
  labeledBy?: string
  controlType: string
  localizedControlType: string
  automationId: string
  helpText: string
  legacyDescription?: string
  itemStatus?: string
  acceleratorKey?: string
  accessKey?: string
  invokable?: boolean
  actionable?: boolean
  fullDescription?: string
  ariaProperties?: string
  enabled: boolean
  focusable: boolean
  visibleRatio: number
  centerVisible: boolean
  topmostVerified?: boolean
  bounds: Rectangle
}

export interface UiAutomationSnapshotService {
  snapshot(windowHandles?: string[], foregroundOnly?: boolean, frozenSnapshot?: boolean): Promise<UiAutomationElementSnapshot[]>
}

export class WindowsUiAutomationService implements UiAutomationSnapshotService {
  constructor(
    private readonly scriptPath: string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async snapshot(windowHandles: string[] = [], foregroundOnly = false, frozenSnapshot = false): Promise<UiAutomationElementSnapshot[]> {
    const handles = [...new Set(windowHandles.map((handle) => handle.replace(/^0+/, '').toLocaleLowerCase()))]
      .filter((handle) => /^[0-9a-f]+$/i.test(handle))
      .slice(0, 24)
    if (this.platform !== 'win32' || (!handles.length && !foregroundOnly)) return []
    const arguments_ = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.scriptPath
    ]
    if (handles.length) arguments_.push('-WindowHandles', handles.join(','))
    if (foregroundOnly) arguments_.push('-ForegroundOnly')
    if (frozenSnapshot) arguments_.push('-FrozenSnapshot')
    const { stdout } = await execFileAsync('powershell.exe', arguments_, {
      encoding: 'utf8',
      timeout: SNAPSHOT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2_000_000
    })
    return parseUiAutomationPayload(stdout)
  }
}

export function parseUiAutomationPayload(value: string): UiAutomationElementSnapshot[] {
  const payload = JSON.parse(value.trim()) as { elements?: unknown }
  if (!Array.isArray(payload.elements)) return []
  const elements: UiAutomationElementSnapshot[] = []
  for (const candidate of payload.elements.slice(0, MAX_ELEMENTS)) {
    if (!candidate || typeof candidate !== 'object') continue
    const item = candidate as Record<string, unknown>
    const x = finiteNumber(item.x)
    const y = finiteNumber(item.y)
    const width = finiteNumber(item.width)
    const height = finiteNumber(item.height)
    const visibleRatio = finiteNumber(item.visibleRatio)
    if (x === null || y === null || width === null || height === null || width < 2 || height < 2) continue
    elements.push({
      name: safeString(item.name, 200),
      legacyName: safeString(item.legacyName, 200),
      labeledBy: safeString(item.labeledBy, 200),
      controlType: safeString(item.controlType, 80),
      localizedControlType: safeString(item.localizedControlType, 100),
      automationId: safeString(item.automationId, 200),
      helpText: safeString(item.helpText, 300),
      legacyDescription: safeString(item.legacyDescription, 300),
      itemStatus: safeString(item.itemStatus, 300),
      acceleratorKey: safeString(item.acceleratorKey, 100),
      accessKey: safeString(item.accessKey, 100),
      invokable: item.invokable === true,
      actionable: item.actionable === true || item.invokable === true,
      fullDescription: safeString(item.fullDescription, 300),
      ariaProperties: safeString(item.ariaProperties, 500),
      enabled: item.enabled !== false,
      focusable: item.focusable === true,
      visibleRatio: clamp(visibleRatio ?? 0),
      centerVisible: item.centerVisible === true,
      topmostVerified: item.topmostVerified === true,
      bounds: { x, y, width, height }
    })
  }
  return elements
}

export function mapUiAutomationFeatures(
  elements: UiAutomationElementSnapshot[],
  displayBounds: Rectangle,
  toDip: (bounds: Rectangle) => Rectangle
): CaptureFeature[] {
  const features: CaptureFeature[] = []
  for (const [index, element] of elements.entries()) {
    // A centre hit proves that the owning control—not merely one of its exposed
    // corners—is the topmost element on the frozen desktop.
    if (!element.centerVisible) continue
    const bounds = toDip(element.bounds)
    const left = Math.max(displayBounds.x, bounds.x)
    const top = Math.max(displayBounds.y, bounds.y)
    const right = Math.min(displayBounds.x + displayBounds.width, bounds.x + bounds.width)
    const bottom = Math.min(displayBounds.y + displayBounds.height, bounds.y + bounds.height)
    if (right - left < 2 || bottom - top < 2) continue
    const accessibleName = firstString([element.name, element.legacyName ?? '', element.labeledBy ?? ''])
    const tooltipLabel = firstString([
      element.helpText,
      element.fullDescription ?? '',
      element.legacyDescription ?? '',
      ariaDescription(element.ariaProperties ?? '')
    ])
    const reportedRole = (element.localizedControlType || element.controlType).toLocaleLowerCase()
    const role = (element.actionable || element.invokable) && ['custom', 'group', 'pane', 'text'].includes(reportedRole)
      ? 'button'
      : reportedRole
    const preferredAccessibleLabel = isWeakAccessibleName(accessibleName) ? tooltipLabel : accessibleName
    const label = (
      preferredAccessibleLabel ||
      tooltipLabel ||
      humanizeAutomationId(element.automationId) ||
      genericFeatureLabel(role, element.localizedControlType || element.controlType)
    ).slice(0, 100)
    const description = firstDistinctString(label, [
      element.helpText,
      element.fullDescription ?? '',
      element.legacyDescription ?? '',
      element.itemStatus ?? '',
      ariaDescription(element.ariaProperties ?? ''),
      element.acceleratorKey ? `Keyboard shortcut: ${element.acceleratorKey}` : ''
    ])
    features.push({
      id: `uia-${index + 1}`,
      kind: uiFeatureKind(element.controlType, label),
      label,
      bounds: {
        x: clamp((left - displayBounds.x) / displayBounds.width),
        y: clamp((top - displayBounds.y) / displayBounds.height),
        width: clamp((right - left) / displayBounds.width),
        height: clamp((bottom - top) / displayBounds.height)
      },
      source: 'uia',
      role,
      ...(description ? { description } : {}),
      enabled: element.enabled,
      visibility: element.visibleRatio,
      visibilityVerified: element.topmostVerified === true
    })
  }
  return features
}

function ariaDescription(value: string): string {
  const match = /(?:description|roledescription|label)=([^;]+)/i.exec(value)
  return match?.[1]?.replaceAll('\\;', ';').trim() ?? ''
}

function firstDistinctString(label: string, candidates: string[]): string {
  const normalized = safeString(label, 300).toLocaleLowerCase()
  return candidates
    .map((candidate) => safeString(candidate, 300))
    .find((candidate) => candidate && candidate.toLocaleLowerCase() !== normalized) ?? ''
}

function firstString(candidates: string[]): string {
  return candidates.map((candidate) => safeString(candidate, 300)).find(Boolean) ?? ''
}

function isWeakAccessibleName(value: string): boolean {
  const normalized = safeString(value, 200)
  if (!normalized) return true
  if ([...normalized].length <= 2 || /^[.…⋯•·\-_=+<>?]+$/u.test(normalized) || /[\uE000-\uF8FF]/u.test(normalized)) return true
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, '')
  return (
    compact.length >= 4 &&
    (
      /^[\p{L}]*\p{N}[\p{L}\p{N}]*$/u.test(compact) ||
      (/^[A-Za-z]+$/.test(compact) && !/[aeiouy]/i.test(compact)) ||
      (
        /^[A-Za-z]+$/.test(compact) &&
        /[a-z]/.test(compact) &&
        /[A-Z]/.test(compact) &&
        !/^[A-Z][a-z]+$/.test(compact) &&
        !/^[a-z]+(?:[A-Z][a-z]{2,})+$/.test(compact)
      )
    )
  )
}

function genericFeatureLabel(role: string, reportedType: string): string {
  if (['button', 'menu item', 'tab item', 'header item'].includes(role)) return `Unlabelled ${role}`
  return safeString(reportedType, 100) || 'Interface element'
}

function humanizeAutomationId(value: string): string {
  const source = safeString(value, 200)
  if (
    !source ||
    /^[{(]?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[)}]?$/i.test(source) ||
    /^[0-9a-f]{12,}$/i.test(source.replace(/[-_]/g, '')) ||
    (/^(?=.*\d)[A-Za-z0-9]{6,}$/.test(source) && !/[a-z][A-Z][a-z]{2,}/.test(source)) ||
    (/^[A-Za-z]{5,}$/.test(source) && !/[aeiouy]/i.test(source))
  ) return ''
  const label = source
    .replace(/(?:button|btn|icon|control)$/i, '')
    .replace(/^(?:button|btn|icon|control)[-_]?/i, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return label ? label[0]!.toLocaleUpperCase() + label.slice(1) : ''
}

function uiFeatureKind(controlType: string, label: string): CaptureFeatureKind {
  if (/\b(?:error|failed|failure|warning|invalid|denied|unable|exception|not found|couldn['’]?t)\b/i.test(label)) return 'error'
  const type = controlType.replace(/^ControlType\./i, '').toLocaleLowerCase()
  if (type === 'hyperlink') return 'link'
  if (['progressbar', 'slider', 'spinner'].includes(type)) return 'value'
  if (['text', 'edit', 'document'].includes(type)) return 'text'
  if (type === 'image') return 'visual'
  return 'control'
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function safeString(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replaceAll('\0', '').replace(/\s+/g, ' ').trim()
  if (INVALID_SEMANTIC_STRINGS.has(normalized.toLocaleLowerCase())) return ''
  return normalized.slice(0, maximum)
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}
