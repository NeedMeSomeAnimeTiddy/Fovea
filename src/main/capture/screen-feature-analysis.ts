import sharp from 'sharp'
import type { CaptureAnalysis, CaptureFeature, CaptureFeatureKind, OcrBounds, OcrEntity, OcrRegion } from '@shared/types/app'

const MAX_FEATURES = 240
const ANALYSIS_WIDTH = 3840
const ANALYSIS_HEIGHT = 2160
const VISUAL_DETECTOR_WIDTH = 1920
const VISUAL_DETECTOR_HEIGHT = 1080
const MAX_VALIDATION_SAMPLES = 65_536
const MAX_VISUAL_CONTROL_CANDIDATES = 32
const MIN_OCR_CONFIDENCE = 50
const MIN_UI_VISIBILITY = 0.6
const ACTIONABLE_ROLES = new Set(['button', 'calendar', 'check box', 'checkbox', 'combo box', 'combobox', 'edit', 'header item', 'hyperlink', 'link', 'list item', 'menu item', 'radio button', 'slider', 'spinner', 'tab item', 'thumb', 'tree item'])
const GENERIC_UI_LABELS = new Set([
  'button',
  'control',
  'custom',
  'group',
  'interface element',
  'null',
  'pane',
  'undefined',
  'unknown',
  'unlabelled button',
  'unlabeled button'
])

interface ScreenEvidence {
  data: Buffer
  width: number
  height: number
}

export interface CaptureAnalysisSources {
  lines: OcrRegion[]
  words?: OcrRegion[]
  entities?: OcrEntity[]
  uiFeatures?: CaptureFeature[]
  visualFeatures?: CaptureFeature[]
}

export async function detectVisualControlFeatures(
  image: Buffer,
  sources: CaptureAnalysisSources
): Promise<CaptureFeature[]> {
  try {
    return detectVisualControlCandidates(await loadScreenEvidence(image), sources)
  } catch {
    return []
  }
}

export async function buildCaptureAnalysis(image: Buffer, sources: CaptureAnalysisSources): Promise<CaptureAnalysis> {
  let evidence: ScreenEvidence | null = null
  try {
    evidence = await loadScreenEvidence(image)
  } catch {
    // OCR and accessibility results remain usable when visual analysis is unavailable.
  }
  const visualFeatures = sources.visualFeatures ?? (evidence ? detectVisualControlCandidates(evidence, sources) : [])
  const candidates = rankedSourceFeatures({ ...sources, visualFeatures })
  const validation = evidence
    ? validateFeatures(candidates, evidence)
    : { features: candidates, rejections: new Map<EvidenceRejectionReason, number>() }
  if (visualFeatures.length || validation.rejections.size) {
    console.info(
      `[capture] Feature analysis kept ${validation.features.length}/${candidates.length} candidates ` +
      `(${sources.uiFeatures?.length ?? 0} UIA, ${sources.lines.length} OCR lines, ${visualFeatures.length} visual; ` +
      `${formatRejections(validation.rejections)}).`
    )
  }
  return {
    features: validation.features.slice(0, MAX_FEATURES),
    truncated: validation.features.length > MAX_FEATURES || sources.lines.length > MAX_FEATURES || (sources.entities?.length ?? 0) > MAX_FEATURES || (sources.uiFeatures?.length ?? 0) > MAX_FEATURES || visualFeatures.length >= MAX_VISUAL_CONTROL_CANDIDATES,
    stage: 'text',
    complete: true
  }
}

export function buildCaptureAnalysisStage(
  sources: CaptureAnalysisSources,
  stage: 'semantic' | 'text'
): CaptureAnalysis {
  const stageSources = stage === 'semantic' ? { ...sources, lines: [], words: [], entities: [] } : sources
  const features = rankedSourceFeatures(stageSources)
  return {
    features: features.slice(0, MAX_FEATURES),
    truncated: features.length > MAX_FEATURES || sources.lines.length > MAX_FEATURES || (sources.entities?.length ?? 0) > MAX_FEATURES || (sources.uiFeatures?.length ?? 0) > MAX_FEATURES,
    stage,
    complete: false
  }
}

export async function validateCaptureAnalysis(
  image: Buffer,
  analysis: CaptureAnalysis
): Promise<CaptureAnalysis> {
  let evidence: ScreenEvidence
  try {
    evidence = await loadScreenEvidence(image)
  } catch {
    return analysis
  }
  return { ...analysis, features: validateFeatures(analysis.features, evidence).features }
}

function rankedSourceFeatures(sources: CaptureAnalysisSources): CaptureFeature[] {
  const textRegions = phraseRegions(sources.lines, sources.words ?? [])
  const textFeatures = textRegions
    .filter((region) =>
      hasUsableOcrConfidence(region.confidence) &&
      hasMeaningfulText(region.text) &&
      region.bounds.width > 0 &&
      region.bounds.height > 0
    )
    .map((region, index) => textFeature(region, index))
  const visualCodeFeatures = (sources.entities ?? [])
    .filter((entity) => (entity.kind === 'qr' || entity.kind === 'barcode') && entity.bounds)
    .map((entity, index) => visualCodeFeature(entity, index))
  const uiFeatures = (sources.uiFeatures ?? [])
    .filter(isVerifiedActionableUiFeature)
    .map((feature) => ({ ...feature, rank: featureRank(feature, feature.visibility ?? 0) }))
  const visualControlFeatures = (sources.visualFeatures ?? [])
    .filter((feature) => feature.source === 'visual' && isActionableRole(feature.role))
    .map((feature) => ({ ...feature, rank: featureRank(feature, feature.visibility ?? 0) }))
  const controlFeatures = [...uiFeatures, ...visualControlFeatures]
  const matchedControlIds = new Set<string>()
  const enrichedTextFeatures = textFeatures.map((text) => {
    const match = bestUiFeatureMatch(text, controlFeatures)
    if (match) {
      matchedControlIds.add(match.id)
      return enrichTextFeature(text, match)
    }
    const toolbarRole = inferredToolbarRole(text, controlFeatures)
    return toolbarRole ? promoteToolbarTextFeature(text, toolbarRole) : text
  })
  const visibleControlOnlyFeatures = controlFeatures.filter(({ id }) => !matchedControlIds.has(id))
  return rankAndResolveOverlaps([...enrichedTextFeatures, ...visualCodeFeatures, ...visibleControlOnlyFeatures])
}

function hasMeaningfulText(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value)
}

function hasUsableOcrConfidence(confidence: number): boolean {
  // Legacy Windows OCR provides geometry but no confidence value, represented as zero.
  return confidence === 0 || confidence >= MIN_OCR_CONFIDENCE
}

function isVerifiedActionableUiFeature(feature: CaptureFeature): boolean {
  const area = boundsArea(feature.bounds)
  return feature.source === 'uia' &&
    (feature.visibilityVerified === true || (feature.visibility ?? 0) >= MIN_UI_VISIBILITY) &&
    isActionableRole(feature.role) &&
    area > 0 &&
    area <= 0.12
}

function bestUiFeatureMatch(text: CaptureFeature, uiFeatures: CaptureFeature[]): CaptureFeature | null {
  let best: { feature: CaptureFeature; score: number } | null = null
  for (const uiFeature of uiFeatures) {
    const textWithinUi = overlapRatio(text.bounds, uiFeature.bounds)
    const uiWithinText = overlapRatio(uiFeature.bounds, text.bounds)
    const intersection = intersectionOverUnion(text.bounds, uiFeature.bounds)
    const tokenScore = tokenContainment(text.label, uiFeature.label)
    const genericLabel = isGenericUiLabel(uiFeature)
    const role = normalizedLabel(uiFeature.role ?? '')
    const labelsMatch = labelsOverlap(text.label, uiFeature.label) || tokenScore >= 0.6
    const geometryMatch = Math.max(textWithinUi, uiWithinText) >= 0.55 || intersection >= 0.28
    const geometryOnlyMatch = genericLabel &&
      textWithinUi >= 0.72 &&
      boundsArea(text.bounds) / Math.max(0.000001, boundsArea(uiFeature.bounds)) >= 0.06
    const iconGlyphMatch = isLikelyControlGlyph(text.label) &&
      centreWithin(text.bounds, padBounds(uiFeature.bounds, 0.01, 0.01)) &&
      boundsArea(text.bounds) / Math.max(0.000001, boundsArea(uiFeature.bounds)) <= 0.8
    const tabGeometryMatch = role === 'tab item' &&
      textWithinUi >= 0.55 &&
      centreWithin(text.bounds, padBounds(uiFeature.bounds, 0.006, 0.006))
    if ((!geometryMatch && !iconGlyphMatch) || (!labelsMatch && !geometryOnlyMatch && !iconGlyphMatch && !tabGeometryMatch)) continue
    const score = Math.max(textWithinUi, uiWithinText) * 3 + intersection * 2 + tokenScore + (uiFeature.visibility ?? 0)
    if (!best || score > best.score) best = { feature: uiFeature, score }
  }
  return best?.feature ?? null
}

function isGenericUiLabel(feature: CaptureFeature): boolean {
  const label = normalizedLabel(feature.label)
  const role = normalizedLabel(feature.role ?? '')
  return !label || label === role || GENERIC_UI_LABELS.has(label)
}

function enrichTextFeature(text: CaptureFeature, semantic: CaptureFeature): CaptureFeature {
  const semanticArea = boundsArea(semantic.bounds)
  const textArea = boundsArea(text.bounds)
  const useSemanticBounds = semanticArea <= Math.max(0.025, textArea * 16)
  const genericSemanticLabel = isGenericUiLabel(semantic)
  const label = genericSemanticLabel
    ? reliableVisibleControlLabel(text.label) || genericControlLabel(semantic.role)
    : semantic.label
  const feature: CaptureFeature = {
    ...text,
    id: semantic.id,
    kind: semantic.kind,
    bounds: useSemanticBounds ? semantic.bounds : text.bounds,
    source: 'hybrid',
    label,
    role: semantic.role,
    description: semantic.description,
    enabled: semantic.enabled,
    visibility: semantic.visibility,
    visibilityVerified: semantic.visibilityVerified
  }
  return { ...feature, rank: Math.max(text.rank ?? 0, featureRank(feature, semantic.visibility ?? 0)) + 4 }
}

function isLikelyControlGlyph(value: string): boolean {
  return /^[\p{L}\p{N}]{1,12}$/u.test(value.trim())
}

function reliableVisibleControlLabel(value: string): string {
  const label = value.replace(/\s+/g, ' ').trim().slice(0, 100)
  const normalized = normalizedLabel(label)
  if (!normalized || GENERIC_UI_LABELS.has(normalized)) return ''
  if (classifyText(label) === 'control') return label
  if ([...label].length < 3 || [...label].length > 42) return ''
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\s&+./:'’()-]*$/u.test(label)) return ''
  const words = label.split(/\s+/)
  if (words.length > 1) {
    return words.every((word) => /^[\p{Lu}]?[\p{Ll}]{2,}$|^[\p{Lu}]{2,6}$|^\d+$/u.test(word))
      ? label
      : ''
  }
  if (!/^[\p{Lu}]?[\p{Ll}]{2,}$|^[\p{Lu}]{2,6}$/u.test(label)) return ''
  if (/^[A-Za-z]+$/.test(label) && !/[aeiouy]/i.test(label)) return ''
  return label
}

function genericControlLabel(role?: string): string {
  const normalizedRole = role?.trim().toLocaleLowerCase()
  return normalizedRole ? `Unlabelled ${normalizedRole}` : 'Unlabelled control'
}

function inferredToolbarRole(text: CaptureFeature, controlFeatures: CaptureFeature[]): string | null {
  if (!['text', 'link'].includes(text.kind)) return null
  if (text.bounds.y + text.bounds.height / 2 > 0.18 || text.bounds.height > 0.065 || boundsArea(text.bounds) > 0.035) return null
  const words = text.label.trim().split(/\s+/)
  if (!words.length || words.length > 10 || text.label.trim().length > 120) return null

  const textCenterY = text.bounds.y + text.bounds.height / 2
  const rowControls = controlFeatures.filter((feature) => {
    const featureCenterY = feature.bounds.y + feature.bounds.height / 2
    const verticalTolerance = Math.max(0.014, Math.min(0.045, Math.max(text.bounds.height, feature.bounds.height) * 0.72))
    return featureCenterY <= 0.18 &&
      feature.bounds.height <= 0.09 &&
      Math.abs(featureCenterY - textCenterY) <= verticalTolerance
  })
  if (!rowControls.length) return null

  const nearestGap = Math.min(...rowControls.map((feature) => horizontalBoundsGap(text.bounds, feature.bounds)))
  const tabControls = rowControls.filter(({ role }) => normalizedLabel(role ?? '') === 'tab item')
  if (!tabControls.length && (rowControls.length < 2 || nearestGap > 0.065)) return null
  if (tabControls.length && Math.min(...tabControls.map((feature) => horizontalBoundsGap(text.bounds, feature.bounds))) > 0.16) return null
  return tabControls.length ? 'tab item' : 'button'
}

function promoteToolbarTextFeature(text: CaptureFeature, role: string): CaptureFeature {
  const feature: CaptureFeature = {
    ...text,
    kind: 'control',
    source: 'hybrid',
    role,
    description: role === 'tab item'
      ? 'Visible website or document tab'
      : 'Visible label in a detected toolbar row'
  }
  return { ...feature, rank: featureRank(feature, 0.82) + 2 }
}

function horizontalBoundsGap(left: OcrBounds, right: OcrBounds): number {
  if (left.x + left.width < right.x) return right.x - left.x - left.width
  if (right.x + right.width < left.x) return left.x - right.x - right.width
  return 0
}

function visualCodeFeature(entity: OcrEntity, index: number): CaptureFeature {
  const value = entity.value.replace(/\s+/g, ' ').trim().slice(0, 100)
  const feature: CaptureFeature = {
    id: `visual-code-${index + 1}`,
    kind: /^(?:https?:\/\/|www\.)/i.test(value) ? 'link' : 'value',
    label: value,
    bounds: padBounds(entity.bounds!, 0.006, 0.008),
    source: 'visual',
    role: entity.kind === 'qr' ? 'QR code' : 'barcode',
    description: entity.kind === 'qr' ? 'Visible QR code' : 'Visible barcode'
  }
  return { ...feature, rank: featureRank(feature, 1) }
}

function textFeature(region: OcrRegion, index: number): CaptureFeature {
  const label = region.text.replace(/\s+/g, ' ').trim().slice(0, 240)
  const feature: CaptureFeature = {
    id: `ocr-line-${index + 1}`,
    kind: classifyText(label),
    label,
    bounds: padBounds(region.bounds, 0.004, 0.006),
    source: 'ocr-line'
  }
  return {
    ...feature,
    rank: featureRank(feature, region.confidence === 0 ? 0.75 : Math.max(0, Math.min(1, region.confidence / 100)))
  }
}

function phraseRegions(lines: OcrRegion[], words: OcrRegion[]): OcrRegion[] {
  if (!lines.length) return groupWordsIntoPhrases(words)
  const tightenedLines = lines.map((line) => {
    const contained = words.filter((word) => centreWithin(word.bounds, padBounds(line.bounds, 0.012, 0.012)))
    if (!contained.length) return line
    return { ...line, bounds: unionBounds(contained.map(({ bounds }) => bounds)) }
  })
  return groupLinesIntoParagraphs(tightenedLines)
}

function groupLinesIntoParagraphs(lines: OcrRegion[]): OcrRegion[] {
  const sorted = [...lines].sort((left, right) =>
    left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x
  )
  const groups: OcrRegion[][] = []
  for (const line of sorted) {
    const group = groups
      .filter((candidate) => {
        const previous = candidate.at(-1)
        return previous ? linesBelongToSameParagraph(previous, line, candidate) : false
      })
      .sort((left, right) => paragraphContinuationScore(left, line) - paragraphContinuationScore(right, line))[0]
    if (group) group.push(line)
    else groups.push([line])
  }
  return groups.map((group, index) => ({
    id: group.length === 1 ? group[0]!.id : `paragraph-${index + 1}`,
    text: group.map(({ text }) => text.trim()).filter(Boolean).join(' '),
    confidence: group.reduce((sum, item) => sum + item.confidence, 0) / group.length,
    bounds: unionBounds(group.map(({ bounds }) => bounds))
  }))
}

function linesBelongToSameParagraph(previous: OcrRegion, current: OcrRegion, group: OcrRegion[]): boolean {
  const previousBottom = previous.bounds.y + previous.bounds.height
  const verticalGap = current.bounds.y - previousBottom
  const minimumHeight = Math.min(previous.bounds.height, current.bounds.height)
  const maximumHeight = Math.max(previous.bounds.height, current.bounds.height)
  if (minimumHeight <= 0 || maximumHeight / minimumHeight > 1.8) return false
  if (verticalGap < -minimumHeight * 0.2 || verticalGap > Math.max(0.012, minimumHeight * 0.85)) return false

  const groupBounds = unionBounds(group.map(({ bounds }) => bounds))
  const leftDifference = Math.abs(current.bounds.x - groupBounds.x)
  const alignedLeft = leftDifference <= Math.max(0.018, minimumHeight * 1.4)
  const horizontalOverlap = axisOverlapRatio(
    groupBounds.x,
    groupBounds.width,
    current.bounds.x,
    current.bounds.width
  )
  if (!alignedLeft && horizontalOverlap < 0.35) return false

  const paragraphScale = Math.max(previous.bounds.width, current.bounds.width, groupBounds.width)
  const proseLike = paragraphScale >= 0.14 ||
    previous.text.trim().length >= 18 ||
    current.text.trim().length >= 18 ||
    group.length > 1
  return proseLike
}

function paragraphContinuationScore(group: OcrRegion[], current: OcrRegion): number {
  const previous = group.at(-1)!
  const groupBounds = unionBounds(group.map(({ bounds }) => bounds))
  const lineHeight = Math.max(0.001, Math.min(previous.bounds.height, current.bounds.height))
  const verticalGap = Math.max(0, current.bounds.y - previous.bounds.y - previous.bounds.height) / lineHeight
  const leftDifference = Math.abs(current.bounds.x - groupBounds.x) / lineHeight
  const overlap = axisOverlapRatio(
    groupBounds.x,
    groupBounds.width,
    current.bounds.x,
    current.bounds.width
  )
  return verticalGap + leftDifference * 0.3 - overlap * 0.2
}

function groupWordsIntoPhrases(words: OcrRegion[]): OcrRegion[] {
  const sorted = words
    .filter((word) => word.text.trim() && word.bounds.width > 0 && word.bounds.height > 0)
    .sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x)
  const rows: OcrRegion[][] = []
  for (const word of sorted) {
    const row = rows.find((candidate) => {
      const bounds = unionBounds(candidate.map((item) => item.bounds))
      const centre = word.bounds.y + word.bounds.height / 2
      return centre >= bounds.y - bounds.height * 0.45 && centre <= bounds.y + bounds.height * 1.45
    })
    if (row) row.push(word)
    else rows.push([word])
  }
  const phrases: OcrRegion[] = []
  for (const row of rows) {
    row.sort((left, right) => left.bounds.x - right.bounds.x)
    let phrase: OcrRegion[] = []
    const flush = (): void => {
      if (!phrase.length) return
      phrases.push({
        id: `phrase-${phrases.length + 1}`,
        text: phrase.map(({ text }) => text.trim()).join(' '),
        confidence: phrase.reduce((sum, item) => sum + item.confidence, 0) / phrase.length,
        bounds: unionBounds(phrase.map(({ bounds }) => bounds))
      })
      phrase = []
    }
    for (const word of row) {
      const previous = phrase.at(-1)
      const gap = previous ? word.bounds.x - previous.bounds.x - previous.bounds.width : 0
      const maximumGap = Math.max(0.025, Math.max(previous?.bounds.height ?? 0, word.bounds.height) * 1.8)
      if (previous && gap > maximumGap) flush()
      phrase.push(word)
    }
    flush()
  }
  return phrases
}

export function classifyText(value: string): CaptureFeatureKind {
  if (/\b(?:error|failed|failure|warning|invalid|denied|unable|exception|not found|couldn['’]?t)\b/i.test(value)) return 'error'
  if (/(?:https?:\/\/|www\.|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b)/i.test(value)) return 'link'
  if (/^(?:[$£€¥]\s*)?[-+]?\d[\d,.]*(?:\s*%|\s+[A-Z]{3})?$/.test(value) || /^\d{1,2}:\d{2}(?:\s*[AP]M)?$/i.test(value)) return 'value'
  if (
    value.length <= 42 &&
    /^(?:ok|cancel|save|submit|continue|next|back|close|open|send|search|sign in|log in|retry|try again|settings|download|upload|copy|delete|edit|add|remove|learn more|view|show|hide|apply|confirm|allow|deny)(?:\b|$)/i.test(value)
  ) return 'control'
  return 'text'
}

interface EdgeComponent {
  left: number
  top: number
  right: number
  bottom: number
  pixels: number
}

function detectVisualControlCandidates(
  evidence: ScreenEvidence,
  sources: CaptureAnalysisSources
): CaptureFeature[] {
  const detector = buildEdgeComponents(evidence)
  if (!detector.components.length) return []
  const uiFeatures = (sources.uiFeatures ?? []).filter(isVerifiedActionableUiFeature)
  const proposals: CaptureFeature[] = []

  for (const component of detector.components) {
    const componentBounds = detectorBounds(component, detector.width, detector.height)
    if (uiFeatures.some((feature) => centreWithin(componentBounds, padBounds(feature.bounds, 0.002, 0.002)))) continue
    const match = nearestToolbarSeed(component, uiFeatures, detector.width, detector.height)
    if (!match) continue
    const bounds = inferredToolbarCell(component, match.feature, detector.width, detector.height)
    if (uiFeatures.some((feature) => intersectionOverUnion(bounds, feature.bounds) >= 0.18)) continue
    proposals.push({
      id: `visual-control-${proposals.length + 1}`,
      kind: 'control',
      label: 'Unlabelled button',
      bounds,
      source: 'visual',
      role: 'button',
      description: 'Visually inferred beside a detected toolbar control',
      enabled: true,
      visibility: match.confidence
    })
  }

  for (const line of sources.lines) {
    if (
      !hasUsableOcrConfidence(line.confidence) ||
      classifyText(line.text.trim()) !== 'control' ||
      line.bounds.width <= 0 ||
      line.bounds.height <= 0
    ) continue
    const outline = detector.components.find((component) => {
      if (!looksLikeControlOutline(component, detector.edges, detector.width, detector.height)) return false
      const bounds = detectorBounds(component, detector.width, detector.height)
      return centreWithin(line.bounds, bounds) &&
        bounds.width >= line.bounds.width * 1.08 &&
        bounds.height >= line.bounds.height * 1.15
    })
    if (!outline) continue
    const bounds = padBounds(detectorBounds(outline, detector.width, detector.height), 2 / detector.width, 2 / detector.height)
    if (uiFeatures.some((feature) => intersectionOverUnion(bounds, feature.bounds) >= 0.18)) continue
    proposals.push({
      id: `visual-control-${proposals.length + 1}`,
      kind: 'control',
      label: line.text.trim().slice(0, 100),
      bounds,
      source: 'visual',
      role: 'button',
      description: 'Visible bordered control',
      enabled: true,
      visibility: 0.82
    })
  }

  return deduplicateVisualControls(proposals).slice(0, MAX_VISUAL_CONTROL_CANDIDATES)
}

function buildEdgeComponents(evidence: ScreenEvidence): {
  components: EdgeComponent[]
  edges: Uint8Array
  width: number
  height: number
} {
  const stride = Math.max(
    1,
    Math.ceil(Math.max(evidence.width / VISUAL_DETECTOR_WIDTH, evidence.height / VISUAL_DETECTOR_HEIGHT))
  )
  const width = Math.max(1, Math.floor((evidence.width - 1) / stride) + 1)
  const height = Math.max(1, Math.floor((evidence.height - 1) / stride) + 1)
  const edges = new Uint8Array(width * height)
  for (let y = 0; y + 1 < height; y += 1) {
    const sourceY = y * stride
    for (let x = 0; x + 1 < width; x += 1) {
      const sourceX = x * stride
      const sourceIndex = sourceY * evidence.width + sourceX
      const value = evidence.data[sourceIndex] ?? 0
      const horizontal = Math.abs(value - (evidence.data[sourceIndex + stride] ?? value))
      const vertical = Math.abs(value - (evidence.data[sourceIndex + evidence.width * stride] ?? value))
      if (Math.max(horizontal, vertical) >= 16) edges[y * width + x] = 1
    }
  }

  const components: EdgeComponent[] = []
  const queue = new Int32Array(width * height)
  for (let start = 0; start < edges.length; start += 1) {
    if (edges[start] !== 1) continue
    let head = 0
    let tail = 0
    queue[tail++] = start
    edges[start] = 2
    let left = start % width
    let right = left
    let top = Math.floor(start / width)
    let bottom = top
    while (head < tail) {
      const index = queue[head++]!
      const x = index % width
      const y = Math.floor(index / width)
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = y + offsetY
        if (nextY < 0 || nextY >= height) continue
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue
          const nextX = x + offsetX
          if (nextX < 0 || nextX >= width) continue
          const nextIndex = nextY * width + nextX
          if (edges[nextIndex] !== 1) continue
          edges[nextIndex] = 2
          queue[tail++] = nextIndex
        }
      }
    }
    const componentWidth = right - left + 1
    const componentHeight = bottom - top + 1
    const aspect = componentWidth / Math.max(1, componentHeight)
    if (
      tail >= 3 &&
      componentWidth >= 2 &&
      componentHeight >= 2 &&
      componentWidth <= 180 &&
      componentHeight <= 110 &&
      aspect >= 0.12 &&
      aspect <= 8
    ) {
      components.push({ left, top, right: right + 1, bottom: bottom + 1, pixels: tail })
    }
  }
  // Restore a binary edge mask for outline scoring after component traversal.
  for (let index = 0; index < edges.length; index += 1) if (edges[index] === 2) edges[index] = 1
  return { components, edges, width, height }
}

function detectorBounds(component: EdgeComponent, width: number, height: number): OcrBounds {
  return {
    x: component.left / width,
    y: component.top / height,
    width: (component.right - component.left) / width,
    height: (component.bottom - component.top) / height
  }
}

function nearestToolbarSeed(
  component: EdgeComponent,
  features: CaptureFeature[],
  width: number,
  height: number
): { feature: CaptureFeature; confidence: number } | null {
  const componentWidth = component.right - component.left
  const componentHeight = component.bottom - component.top
  const componentCenterX = (component.left + component.right) / 2
  const componentCenterY = (component.top + component.bottom) / 2
  let best: { feature: CaptureFeature; score: number; maximumDistance: number } | null = null
  for (const feature of features) {
    const featureWidth = feature.bounds.width * width
    const featureHeight = feature.bounds.height * height
    if (featureHeight < 12 || featureHeight > 110 || featureWidth < 12 || featureWidth > 260) continue
    if (featureWidth / featureHeight > 2.2) continue
    if (componentHeight < Math.max(3, featureHeight * 0.22) || componentHeight > featureHeight * 1.2) continue
    if (componentWidth < Math.max(3, featureHeight * 0.22)) continue
    if (componentWidth / componentHeight < 0.3 || componentWidth / componentHeight > 2.4) continue
    if (componentWidth > Math.max(featureHeight * 2.2, featureWidth * 1.35)) continue
    const featureLeft = feature.bounds.x * width
    const featureRight = (feature.bounds.x + feature.bounds.width) * width
    const featureCenterX = (feature.bounds.x + feature.bounds.width / 2) * width
    const featureCenterY = (feature.bounds.y + feature.bounds.height / 2) * height
    const verticalDistance = Math.abs(componentCenterY - featureCenterY)
    if (verticalDistance > Math.max(6, featureHeight * 0.52)) continue
    const centerDistance = Math.abs(componentCenterX - featureCenterX)
    if (centerDistance < featureHeight * 0.65 || centerDistance > featureHeight * 2.8) continue
    const horizontalGap = componentCenterX < featureLeft
      ? featureLeft - componentCenterX
      : componentCenterX > featureRight
        ? componentCenterX - featureRight
        : 0
    const maximumDistance = Math.max(30, featureHeight * 2.4, featureWidth * 0.9)
    if (horizontalGap <= featureHeight * 0.35 || horizontalGap > maximumDistance) continue
    const score = horizontalGap + verticalDistance * 2
    if (!best || score < best.score) best = { feature, score, maximumDistance }
  }
  if (!best) return null
  return {
    feature: best.feature,
    confidence: Math.max(0.42, Math.min(0.9, 1 - best.score / (best.maximumDistance * 1.4)))
  }
}

function inferredToolbarCell(
  component: EdgeComponent,
  seed: CaptureFeature,
  width: number,
  height: number
): OcrBounds {
  const componentCenterX = (component.left + component.right) / 2
  const seedWidth = seed.bounds.width * width
  const seedHeight = seed.bounds.height * height
  const componentWidth = component.right - component.left
  const squareLikeSeed = seedWidth / Math.max(1, seedHeight) >= 0.65 && seedWidth / Math.max(1, seedHeight) <= 1.8
  const targetWidth = Math.max(
    16,
    Math.min(seedHeight * 2.2, squareLikeSeed ? seedWidth : Math.max(seedHeight, componentWidth + seedHeight * 0.4))
  )
  const targetHeight = Math.max(14, Math.min(110, seedHeight))
  const x = Math.max(0, Math.min(width - targetWidth, componentCenterX - targetWidth / 2)) / width
  const y = Math.max(0, Math.min(height - targetHeight, (seed.bounds.y + seed.bounds.height / 2) * height - targetHeight / 2)) / height
  return { x, y, width: targetWidth / width, height: targetHeight / height }
}

function looksLikeControlOutline(
  component: EdgeComponent,
  edges: Uint8Array,
  width: number,
  height: number
): boolean {
  const componentWidth = component.right - component.left
  const componentHeight = component.bottom - component.top
  if (
    componentWidth < 14 ||
    componentHeight < 10 ||
    componentWidth / componentHeight < 0.5 ||
    componentWidth / componentHeight > 8 ||
    component.right >= width ||
    component.bottom >= height
  ) return false
  const horizontalSamples = Math.max(1, componentWidth)
  const verticalSamples = Math.max(1, componentHeight)
  let top = 0
  let bottom = 0
  let left = 0
  let right = 0
  for (let x = component.left; x < component.right; x += 1) {
    if (edges[component.top * width + x]) top += 1
    if (edges[(component.bottom - 1) * width + x]) bottom += 1
  }
  for (let y = component.top; y < component.bottom; y += 1) {
    if (edges[y * width + component.left]) left += 1
    if (edges[y * width + component.right - 1]) right += 1
  }
  return top / horizontalSamples >= 0.35 &&
    bottom / horizontalSamples >= 0.35 &&
    left / verticalSamples >= 0.35 &&
    right / verticalSamples >= 0.35
}

function deduplicateVisualControls(features: CaptureFeature[]): CaptureFeature[] {
  const output: CaptureFeature[] = []
  for (const feature of [...features].sort((left, right) => (right.visibility ?? 0) - (left.visibility ?? 0))) {
    if (output.some((candidate) => intersectionOverUnion(feature.bounds, candidate.bounds) >= 0.42)) continue
    output.push(feature)
  }
  return output
}

async function loadScreenEvidence(image: Buffer): Promise<ScreenEvidence> {
  const { data, info } = await sharp(image)
    .resize({ width: ANALYSIS_WIDTH, height: ANALYSIS_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

type EvidenceRejectionReason = 'invalid-bounds' | 'no-samples' | 'insufficient-detail'

function validateFeatures(
  candidates: CaptureFeature[],
  evidence: ScreenEvidence
): { features: CaptureFeature[]; rejections: Map<EvidenceRejectionReason, number> } {
  const features: CaptureFeature[] = []
  const rejections = new Map<EvidenceRejectionReason, number>()
  for (const candidate of candidates) {
    const feature = validateFeature(candidate, evidence, (reason) => {
      rejections.set(reason, (rejections.get(reason) ?? 0) + 1)
    })
    if (feature) features.push(feature)
  }
  return { features, rejections }
}

function formatRejections(rejections: ReadonlyMap<EvidenceRejectionReason, number>): string {
  if (!rejections.size) return '0 evidence rejections'
  return [...rejections].map(([reason, count]) => `${count} ${reason}`).join(', ')
}

function validateFeature(
  feature: CaptureFeature,
  evidence: ScreenEvidence,
  reject: (reason: EvidenceRejectionReason) => void = () => undefined
): CaptureFeature | null {
  const left = Math.max(0, Math.floor(feature.bounds.x * evidence.width))
  const top = Math.max(0, Math.floor(feature.bounds.y * evidence.height))
  const right = Math.min(evidence.width, Math.ceil((feature.bounds.x + feature.bounds.width) * evidence.width))
  const bottom = Math.min(evidence.height, Math.ceil((feature.bounds.y + feature.bounds.height) * evidence.height))
  const width = right - left
  const height = bottom - top
  if (width < 2 || height < 2) {
    reject('invalid-bounds')
    return null
  }

  let minimum = 255
  let maximum = 0
  let total = 0
  let totalSquared = 0
  let samples = 0
  let edges = 0
  let edgeLeft = right
  let edgeTop = bottom
  let edgeRight = left
  let edgeBottom = top
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(width * height / MAX_VALIDATION_SAMPLES)))
  for (let y = top; y < bottom; y += sampleStep) {
    for (let x = left; x < right; x += sampleStep) {
      const index = y * evidence.width + x
      const value = evidence.data[index] ?? 0
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
      total += value
      totalSquared += value * value
      samples += 1
      const horizontal = x + sampleStep < right ? Math.abs(value - (evidence.data[index + sampleStep] ?? value)) : 0
      const vertical = y + sampleStep < bottom ? Math.abs(value - (evidence.data[index + evidence.width * sampleStep] ?? value)) : 0
      if (Math.max(horizontal, vertical) < 16) continue
      edges += 1
      edgeLeft = Math.min(edgeLeft, x)
      edgeTop = Math.min(edgeTop, y)
      edgeRight = Math.max(edgeRight, x + sampleStep)
      edgeBottom = Math.max(edgeBottom, y + sampleStep)
    }
  }
  if (!samples) {
    reject('no-samples')
    return null
  }
  const mean = total / samples
  const deviation = Math.sqrt(Math.max(0, totalSquared / samples - mean * mean))
  const edgeRatio = edges / samples
  const visual = feature.source === 'visual'
  const visualControl = visual && isActionableRole(feature.role)
  const semanticOnly = feature.source === 'uia'
  const hasVisibleContent = visualControl
    ? edges >= 4 && edgeRatio >= 0.002 && deviation >= 1.5 && maximum - minimum >= 10
    : visual
      ? edges >= 8 && edgeRatio >= 0.018 && deviation >= 5 && maximum - minimum >= 24
    : semanticOnly
      ? feature.visibilityVerified === true ||
        (edges >= 1 && edgeRatio >= 0.001 && deviation >= 0.75 && maximum - minimum >= 6)
    : edges >= 3 && edgeRatio >= 0.004 && (deviation >= 2.5 || maximum - minimum >= 18)
  if (!hasVisibleContent) {
    reject('insufficient-detail')
    return null
  }

  const evidenceScore = Math.min(1, edgeRatio * 12 + deviation / 48)
  const rank = Math.round(((feature.rank ?? 0) + evidenceScore * 5) * 10) / 10
  if (!visual || visualControl || edgeRight <= edgeLeft || edgeBottom <= edgeTop) return { ...feature, rank }
  const paddingX = 3 / evidence.width
  const paddingY = 3 / evidence.height
  const contentBounds = padBounds({
    x: edgeLeft / evidence.width,
    y: edgeTop / evidence.height,
    width: (edgeRight - edgeLeft) / evidence.width,
    height: (edgeBottom - edgeTop) / evidence.height
  }, paddingX, paddingY)
  return { ...feature, bounds: contentBounds, rank }
}

function rankAndResolveOverlaps(features: CaptureFeature[]): CaptureFeature[] {
  const output: CaptureFeature[] = []
  const ranked = [...features].sort((left, right) =>
    (right.rank ?? 0) - (left.rank ?? 0) ||
    boundsArea(left.bounds) - boundsArea(right.bounds) ||
    left.bounds.y - right.bounds.y ||
    left.bounds.x - right.bounds.x
  )
  for (const feature of ranked) {
    const duplicateIndexes = output
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => areDuplicateFeatures(feature, candidate))
      .map(({ index }) => index)
    if (duplicateIndexes.length) {
      const duplicates = duplicateIndexes.map((index) => output[index]!)
      const winner = [feature, ...duplicates].reduce(preferCompleteFeature)
      for (const index of duplicateIndexes.sort((left, right) => right - left)) output.splice(index, 1)
      output.push(winner)
      continue
    }
    output.push(feature)
  }
  return output
    .filter((feature) => {
      const containedTargets = output.filter((candidate) =>
        candidate !== feature &&
        boundsArea(candidate.bounds) < boundsArea(feature.bounds) &&
        overlapRatio(candidate.bounds, feature.bounds) >= 0.9
      )
      return containedTargets.length < 2 || boundsArea(feature.bounds) <= 0.035 || isActionableRole(feature.role)
    })
    .sort((left, right) =>
    (right.rank ?? 0) - (left.rank ?? 0) ||
    boundsArea(left.bounds) - boundsArea(right.bounds)
    )
}

function areDuplicateFeatures(left: CaptureFeature, right: CaptureFeature): boolean {
  const intersection = intersectionOverUnion(left.bounds, right.bounds)
  const containment = Math.max(overlapRatio(left.bounds, right.bounds), overlapRatio(right.bounds, left.bounds))
  if (labelsOverlap(left.label, right.label) && (intersection >= 0.7 || containment >= 0.8)) return true
  if (
    left.source === 'ocr-line' &&
    right.source === 'ocr-line' &&
    axisOverlapRatio(left.bounds.y, left.bounds.height, right.bounds.y, right.bounds.height) >= 0.55 &&
    axisOverlapRatio(left.bounds.x, left.bounds.width, right.bounds.x, right.bounds.width) >= 0.45 &&
    tokenContainment(left.label, right.label) >= 0.5
  ) return true
  return isStaticTextFeature(left) &&
    isStaticTextFeature(right) &&
    containment >= 0.68 &&
    tokenContainment(left.label, right.label) >= 0.6
}

function preferCompleteFeature(left: CaptureFeature, right: CaptureFeature): CaptureFeature {
  if (left.source === 'ocr-line' && right.source === 'ocr-line') {
    const leftLength = normalizedLabel(left.label).length
    const rightLength = normalizedLabel(right.label).length
    if (leftLength !== rightLength) return leftLength > rightLength ? left : right
  }
  const leftActionable = isActionableRole(left.role)
  const rightActionable = isActionableRole(right.role)
  if (leftActionable !== rightActionable) return leftActionable ? left : right
  if (isStaticTextFeature(left) && isStaticTextFeature(right)) {
    const leftLength = normalizedLabel(left.label).length
    const rightLength = normalizedLabel(right.label).length
    if (Math.abs(leftLength - rightLength) >= 4) return leftLength > rightLength ? left : right
  }
  return (left.rank ?? 0) >= (right.rank ?? 0) ? left : right
}

function isStaticTextFeature(feature: CaptureFeature): boolean {
  return feature.kind !== 'control' && feature.kind !== 'visual' && !isActionableRole(feature.role)
}

function tokenContainment(left: string, right: string): number {
  const leftTokens = new Set(normalizedLabel(left).split(' ').filter(Boolean))
  const rightTokens = new Set(normalizedLabel(right).split(' ').filter(Boolean))
  if (!leftTokens.size || !rightTokens.size) return 0
  let intersection = 0
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1
  return intersection / Math.min(leftTokens.size, rightTokens.size)
}

function featureRank(
  feature: Pick<CaptureFeature, 'kind' | 'bounds' | 'source' | 'role' | 'enabled'>,
  confidence = 1
): number {
  const sourceScore = feature.source === 'hybrid' ? 74 : feature.source === 'ocr-line' ? 68 : feature.source === 'uia' ? 52 : 28
  const kindScore = ({ error: 12, control: 10, link: 9, value: 6, text: 2, visual: 0 })[feature.kind]
  const roleScore = isActionableRole(feature.role) ? 7 : 0
  const confidenceScore = Math.max(0, Math.min(1, confidence)) * 8
  const areaPenalty = Math.min(24, boundsArea(feature.bounds) * 80)
  const disabledPenalty = feature.enabled === false ? 3 : 0
  return Math.round((sourceScore + kindScore + roleScore + confidenceScore - areaPenalty - disabledPenalty) * 10) / 10
}

function isActionableRole(role?: string): boolean {
  return Boolean(role && ACTIONABLE_ROLES.has(role.toLocaleLowerCase()))
}

function labelsOverlap(left: string, right: string): boolean {
  const leftLabel = normalizedLabel(left)
  const rightLabel = normalizedLabel(right)
  return Boolean(leftLabel && rightLabel && (leftLabel.includes(rightLabel) || rightLabel.includes(leftLabel)))
}

function normalizedLabel(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function padBounds(bounds: OcrBounds, horizontal: number, vertical: number): OcrBounds {
  const x = Math.max(0, bounds.x - horizontal)
  const y = Math.max(0, bounds.y - vertical)
  return {
    x,
    y,
    width: Math.min(1 - x, bounds.width + horizontal * 2),
    height: Math.min(1 - y, bounds.height + vertical * 2)
  }
}

function overlapRatio(left: OcrBounds, right: OcrBounds): number {
  const intersection = intersectionArea(left, right)
  return intersection / Math.max(0.000001, left.width * left.height)
}

function axisOverlapRatio(leftStart: number, leftSize: number, rightStart: number, rightSize: number): number {
  const overlap = Math.max(0, Math.min(leftStart + leftSize, rightStart + rightSize) - Math.max(leftStart, rightStart))
  return overlap / Math.max(0.000001, Math.min(leftSize, rightSize))
}

function intersectionOverUnion(left: OcrBounds, right: OcrBounds): number {
  const intersection = intersectionArea(left, right)
  const union = left.width * left.height + right.width * right.height - intersection
  return intersection / Math.max(0.000001, union)
}

function intersectionArea(left: OcrBounds, right: OcrBounds): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return width * height
}

function boundsArea(bounds: OcrBounds): number {
  return Math.max(0, bounds.width) * Math.max(0, bounds.height)
}

function centreWithin(bounds: OcrBounds, container: OcrBounds): boolean {
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  return x >= container.x &&
    x <= container.x + container.width &&
    y >= container.y &&
    y <= container.y + container.height
}

function unionBounds(bounds: OcrBounds[]): OcrBounds {
  const left = Math.min(...bounds.map(({ x }) => x))
  const top = Math.min(...bounds.map(({ y }) => y))
  const right = Math.max(...bounds.map(({ x, width }) => x + width))
  const bottom = Math.max(...bounds.map(({ y, height }) => y + height))
  return {
    x: Math.max(0, left),
    y: Math.max(0, top),
    width: Math.min(1, right) - Math.max(0, left),
    height: Math.min(1, bottom) - Math.max(0, top)
  }
}
