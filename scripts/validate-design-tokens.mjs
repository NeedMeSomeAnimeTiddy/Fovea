import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const RENDERER_ROOT = path.join(PROJECT_ROOT, 'src', 'renderer')
const SOURCE_EXTENSIONS = new Set(['.css', '.ts', '.tsx'])
const CSS_WIDE_VALUES = new Set(['inherit', 'initial', 'revert', 'revert-layer', 'unset'])
const SYSTEM_COLOURS = new Set([
  'accentcolor',
  'accentcolortext',
  'activetext',
  'buttonborder',
  'buttonface',
  'buttontext',
  'canvas',
  'canvastext',
  'field',
  'fieldtext',
  'graytext',
  'highlight',
  'highlighttext',
  'linktext',
  'mark',
  'marktext',
  'selecteditem',
  'selecteditemtext',
  'visitedtext'
])
const NAMED_COLOURS = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond
  blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan
  darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange
  darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
  deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
  gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush
  lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink
  lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
  magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
  mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab
  orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver
  skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
  whitesmoke yellow yellowgreen`.split(/\s+/))
const INLINE_VISUAL_PROPERTIES = new Set([
  'animation',
  'animationDelay',
  'animationDuration',
  'background',
  'backgroundColor',
  'borderColor',
  'borderRadius',
  'boxShadow',
  'color',
  'textShadow',
  'transition',
  'transitionDelay',
  'transitionDuration'
])
const DURATION_PROPERTIES = new Set([
  'animation',
  'animation-delay',
  'animation-duration',
  'transition',
  'transition-delay',
  'transition-duration'
])

const HEX_COLOUR_PATTERN = /#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{4}\b|#[\da-f]{3}\b/i
const COLOUR_FUNCTION_PATTERN = /\b(?:color|hsla?|lab|lch|oklab|oklch|rgba?)\s*\(/i
const TIME_PATTERN = /(?:^|[^\w.-])(\d*\.?\d+)(ms|s)\b/gi
const DECLARATION_PATTERN = /(^|[;{}\r\n])\s*([-\w]+)\s*:\s*([^;{}]+)(?=;|\s*})/gm
const INLINE_STYLE_PATTERN = /style\s*=\s*\{\{([\s\S]*?)\}\}/g
const INLINE_PROPERTY_PATTERN = /([A-Za-z][\w]*)\s*:\s*([^,\n}]+)/g
const STRING_LITERAL_PATTERN = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g

const REMEDIES = {
  colour: 'Replace the literal with an existing semantic --fovea-* colour, surface, border, or status token.',
  radius: 'Replace the numeric radius with the appropriate semantic --fovea-radius-* token.',
  shadow: 'Replace the literal recipe with a semantic --fovea-shadow-*, --fovea-elevation-*, or --fovea-glow-* token.',
  duration: 'Replace the literal timing with a semantic --fovea-motion-* token.',
  inline: 'Move the visual decision to CSS and consume an existing semantic --fovea-* token.',
  reference: 'Renderer and component consumers must use a public semantic --fovea-* token instead of --fovea-ref-*.',
  undefined: 'Declare this --fovea-* token in the shared token or theme contract, or replace it with an existing declared token.'
}

export function validateSource({ filePath, source, rootDir = PROJECT_ROOT }) {
  const result = { violations: [], exceptions: [] }
  const extension = path.extname(filePath).toLowerCase()
  const displayFile = toDisplayPath(filePath, rootDir)

  if (extension === '.css') {
    validateCss({ displayFile, filePath, result, source })
  } else if (extension === '.ts' || extension === '.tsx') {
    validateTypeScript({ displayFile, result, source })
  }

  return result
}

export async function validateRendererTree({ rootDir = PROJECT_ROOT, rendererRoot = RENDERER_ROOT } = {}) {
  const files = await collectSourceFiles(rendererRoot)
  const combined = { violations: [], exceptions: [] }
  const sources = []

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8')
    sources.push({ filePath, source })
    const result = validateSource({ filePath, source, rootDir })
    combined.violations.push(...result.violations)
    combined.exceptions.push(...result.exceptions)
  }

  combined.violations.push(...validateTokenReferences(sources, rootDir))

  return combined
}

export function validateTokenReferences(sources, rootDir = PROJECT_ROOT) {
  const declared = new Set()
  const findings = []
  for (const { filePath, source } of sources) {
    if (path.extname(filePath).toLowerCase() !== '.css') continue
    for (const match of source.matchAll(/(--fovea-[a-z0-9-]+)\s*:/gi)) declared.add(match[1])
  }
  for (const { filePath, source } of sources) {
    if (path.extname(filePath).toLowerCase() !== '.css') continue
    for (const match of source.matchAll(/var\(\s*(--fovea-[a-z0-9-]+)/gi)) {
      if (declared.has(match[1])) continue
      findings.push({
        file: toDisplayPath(filePath, rootDir),
        line: lineNumberAt(source, match.index),
        property: 'var()',
        remedy: REMEDIES.undefined,
        rule: 'undefined',
        value: match[1]
      })
    }
  }
  return findings
}

export function formatReport({ violations, exceptions }) {
  const lines = []

  if (exceptions.length > 0) {
    lines.push(`Accepted design-token exceptions (${exceptions.length}):`)
    for (const finding of exceptions) {
      lines.push(`  ALLOW ${finding.file}:${finding.line} [${finding.property}] ${finding.value}`)
      lines.push(`    Reason: ${finding.reason}`)
    }
  }

  if (violations.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`Design-token violations (${violations.length}):`)
    for (const finding of violations) {
      lines.push(`  ${finding.file}:${finding.line} [${finding.property}] ${finding.value}`)
      lines.push(`    ${finding.remedy}`)
    }
    lines.push('')
    lines.push('Design-token validation failed.')
  } else {
    if (lines.length > 0) lines.push('')
    lines.push(`Design-token validation passed with ${exceptions.length} accepted exception(s).`)
  }

  return lines.join('\n')
}

export function toDisplayPath(filePath, rootDir = PROJECT_ROOT) {
  const pathApi = /^[A-Za-z]:[\\/]/.test(filePath) ? path.win32 : path
  const relativePath = pathApi.relative(rootDir, filePath)
  return relativePath.split(/[\\/]+/).join('/')
}

function validateCss({ displayFile, filePath, result, source }) {
  const controlledFile = isControlledVisualSource(filePath)
  const maskedSource = maskCssComments(source)
  const reducedMotionRanges = findBlockRanges(maskedSource, /@media\s*\(prefers-reduced-motion\s*:\s*reduce\)/gi)
  let match

  DECLARATION_PATTERN.lastIndex = 0
  while ((match = DECLARATION_PATTERN.exec(maskedSource)) !== null) {
    const property = match[2].toLowerCase()
    const value = match[3].trim().replace(/\s+/g, ' ')
    const propertyIndex = match.index + match[0].indexOf(match[2])
    const line = lineNumberAt(source, propertyIndex)

    if (!controlledFile) {
      const colourLiteral = findColourLiteral(value, true)
      if (colourLiteral) addFinding(result, source, displayFile, line, 'colour', property, colourLiteral, REMEDIES.colour)

      if (property === 'border-radius' && /(?:^|[^\w.-])-?\d*\.?\d+(?:[a-z%]+)?\b/i.test(value)) {
        addFinding(result, source, displayFile, line, 'radius', property, value, REMEDIES.radius)
      }

      if ((property === 'box-shadow' || property === 'text-shadow') && !isAllowedShadow(value)) {
        addFinding(result, source, displayFile, line, 'shadow', property, value, REMEDIES.shadow)
      }

      if (DURATION_PROPERTIES.has(property)) {
        const durations = extractDurations(value)
        const inReducedMotion = reducedMotionRanges.some(([start, end]) => propertyIndex >= start && propertyIndex <= end)
        const allowedNearZero = inReducedMotion && durations.length > 0 && durations.every((duration) => duration <= 1)
        if (durations.length > 0 && !allowedNearZero) {
          addFinding(result, source, displayFile, line, 'duration', property, value, REMEDIES.duration)
        }
      }

      if (/var\(\s*--fovea-ref-/.test(value)) {
        addFinding(result, source, displayFile, line, 'reference', property, value, REMEDIES.reference)
      }
    }
  }
}

function validateTypeScript({ displayFile, result, source }) {
  const inlineRanges = []
  let styleMatch

  INLINE_STYLE_PATTERN.lastIndex = 0
  while ((styleMatch = INLINE_STYLE_PATTERN.exec(source)) !== null) {
    const body = styleMatch[1]
    const bodyStart = styleMatch.index + styleMatch[0].indexOf(body)
    inlineRanges.push([styleMatch.index, INLINE_STYLE_PATTERN.lastIndex])
    let propertyMatch

    INLINE_PROPERTY_PATTERN.lastIndex = 0
    while ((propertyMatch = INLINE_PROPERTY_PATTERN.exec(body)) !== null) {
      const property = propertyMatch[1]
      if (!INLINE_VISUAL_PROPERTIES.has(property)) continue

      const rawValue = propertyMatch[2].trim()
      const literal = literalValue(rawValue)
      if (literal === undefined || isAllowedInlineValue(literal)) continue

      const propertyIndex = bodyStart + propertyMatch.index
      const line = lineNumberAt(source, propertyIndex)
      addFinding(result, source, displayFile, line, 'inline', property, rawValue, REMEDIES.inline)
    }
  }

  STRING_LITERAL_PATTERN.lastIndex = 0
  let stringMatch
  while ((stringMatch = STRING_LITERAL_PATTERN.exec(source)) !== null) {
    if (inlineRanges.some(([start, end]) => stringMatch.index >= start && stringMatch.index <= end)) continue
    const colourLiteral = findColourLiteral(stringMatch[2], false)
    if (!colourLiteral) continue

    const line = lineNumberAt(source, stringMatch.index)
    addFinding(result, source, displayFile, line, 'colour', 'string literal', colourLiteral, REMEDIES.colour)
  }
}

function addFinding(result, source, file, line, rule, property, value, remedy) {
  const reason = exceptionReason(source, line)
  const finding = { file, line, property, remedy, rule, value }

  if (reason) {
    result.exceptions.push({ ...finding, reason })
  } else {
    result.violations.push(finding)
  }
}

function exceptionReason(source, line) {
  if (line <= 1) return undefined
  const previousLine = source.split(/\r?\n/)[line - 2]
  const match = previousLine?.match(
    /^\s*(?:\{?\/\*|\/\/)\s*fovea-design-allow:\s*(.+?)(?:\s*\*\/\}?)?\s*$/
  )
  const reason = match?.[1]?.trim()
  return reason || undefined
}

function findColourLiteral(value, includeNamedColours) {
  const hex = value.match(HEX_COLOUR_PATTERN)?.[0]
  if (hex) return hex

  const colourFunction = value.match(COLOUR_FUNCTION_PATTERN)?.[0]
  if (colourFunction) return colourFunction

  if (includeNamedColours) {
    for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
      if (NAMED_COLOURS.has(word)) return word
    }
  }

  return undefined
}

function isAllowedShadow(value) {
  const normalized = value.trim().toLowerCase()
  return normalized === 'none' || CSS_WIDE_VALUES.has(normalized) || /^var\(\s*--(?:fovea|_)/.test(normalized)
}

function isAllowedInlineValue(value) {
  const normalized = String(value).trim()
  const lower = normalized.toLowerCase()
  return lower === 'none' || lower === 'transparent' || lower === 'currentcolor' || CSS_WIDE_VALUES.has(lower) ||
    SYSTEM_COLOURS.has(lower) || /^var\(\s*--fovea-/.test(normalized)
}

function literalValue(rawValue) {
  const stringMatch = rawValue.match(/^(['"`])([\s\S]*)\1$/)
  if (stringMatch && !stringMatch[2].includes('${')) return stringMatch[2]
  if (/^-?\d*\.?\d+(?:[a-z%]+)?$/i.test(rawValue)) return rawValue
  return undefined
}

function extractDurations(value) {
  const durations = []
  TIME_PATTERN.lastIndex = 0
  let match
  while ((match = TIME_PATTERN.exec(value)) !== null) {
    const amount = Number(match[1])
    durations.push(match[2].toLowerCase() === 's' ? amount * 1000 : amount)
  }
  return durations
}

function isControlledVisualSource(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.endsWith('/src/renderer/design-system/styles/tokens.css') ||
    /\/src\/renderer\/design-system\/styles\/theme-[^/]+\.css$/.test(normalized)
}

function maskCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, ' '))
}

function findBlockRanges(source, pattern) {
  const ranges = []
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(source)) !== null) {
    const openingBrace = source.indexOf('{', match.index + match[0].length)
    if (openingBrace === -1) continue
    let depth = 1
    let cursor = openingBrace + 1
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1
      if (source[cursor] === '}') depth -= 1
      cursor += 1
    }
    ranges.push([openingBrace, cursor - 1])
  }
  return ranges
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(entryPath))
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath)
    }
  }

  return files
}

const isDirectRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isDirectRun) {
  const result = await validateRendererTree()
  console.log(formatReport(result))
  if (result.violations.length > 0) process.exitCode = 1
}
