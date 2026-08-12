import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/*
 * The shared focus ring is declared once, through `:where(...):focus-visible`. `:where()`
 * contributes no specificity, so that rule is only as strong as a single pseudo-class and any
 * component rule that styles `box-shadow` on a focusable element silently replaces it. Nothing
 * fails when that happens: the element still matches `:focus-visible`, so assertions counting
 * focus keep passing while the indicator is invisible. Four controls reached main this way.
 *
 * The invariant enforced here is narrow and local: a rule that sets `box-shadow` on something
 * focusable must be accompanied, in the same stylesheet, by a `:focus-visible` rule that restates
 * the ring and actually outranks it.
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const FOCUSABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'summary', 'textarea'])
const FOCUSABLE_ATTRIBUTES = /\[(tabindex|contenteditable)|\[role=['"]?(button|link|tab|menuitem|switch|checkbox|radio|option)/i
/** Disabled controls take no focus, so their own shadow cannot hide a ring. */
const NON_FOCUSABLE_STATES = /:disabled|\[disabled\]|:not\(:enabled\)/i
/** A rule that already styles focus is the indicator, whichever focus pseudo-class it uses. */
const FOCUS_PSEUDO = /:focus(-visible|-within)?\b/
/*
 * Rules gated on the pointer are deliberately out of scope. They outrank the ring only while the
 * element is hovered or pressed *and* focused, which is a narrow overlap, and requiring every
 * hover rule to restate the ring would bury the resting-state overrides this exists to catch.
 */
const POINTER_STATES = /:hover|:active/

/*
 * A class handed to a shared component lands on markup this checker never sees, so the rule that
 * restores the ring can live in a stylesheet with no textual link to the selector here. Each entry
 * has to name the rule that actually wins.
 */
export const ACCEPTED_EXCEPTIONS = [
  {
    file: 'src/renderer/question-window/question.css',
    selector: '.ask-trigger',
    reason: 'Applied to the shared Button, which renders `fui-button ask-trigger`; '
      + '`.fui-button:focus-visible` (0,2,0) in the design system outranks this rule (0,1,0).'
  }
]

export function validateSource({
  filePath,
  rootDir = PROJECT_ROOT,
  source,
  focusableClasses = new Set(),
  exceptions = ACCEPTED_EXCEPTIONS
}) {
  const rules = parseRules(source)
  const violations = []
  const accepted = []

  for (const rule of rules) {
    if (!setsBoxShadow(rule.declarations)) continue
    for (const selector of splitSelectorList(rule.selector)) {
      if (FOCUS_PSEUDO.test(selector)) continue
      if (POINTER_STATES.test(selector)) continue
      if (NON_FOCUSABLE_STATES.test(selector)) continue
      if (!targetsFocusable(selector, focusableClasses)) continue
      if (hasCoveringFocusRule(rules, rule, selector)) continue
      const displayPath = toDisplayPath(filePath, rootDir)
      const trimmed = selector.trim()
      const finding = {
        file: displayPath,
        line: lineNumberAt(source, rule.index),
        selector: trimmed,
        specificity: formatSpecificity(specificityOf(selector)),
        remedy: `Add \`${trimmed}:focus-visible { box-shadow: var(--fovea-focus-ring); }\` after this rule, `
          + 'or compose the ring with the existing shadow. Never compose a token that can resolve to '
          + '`none`; a shadow list containing `none` is invalid and drops the ring entirely.'
      }
      const exception = exceptions.find((entry) => entry.file === displayPath && entry.selector === trimmed)
      if (exception) accepted.push({ ...finding, reason: exception.reason })
      else violations.push(finding)
    }
  }

  return { exceptions: accepted, violations }
}

/** A rule covers another when it restates the ring on focus and wins the cascade. */
function hasCoveringFocusRule(rules, rule, selector) {
  const base = selector.trim()
  const target = specificityOf(selector)
  return rules.some((candidate) => {
    if (!FOCUS_PSEUDO.test(candidate.selector)) return false
    if (!setsBoxShadow(candidate.declarations)) return false
    return splitSelectorList(candidate.selector).some((candidateSelector) => {
      if (!FOCUS_PSEUDO.test(candidateSelector)) return false
      if (!coversSameSubject(candidateSelector, base)) return false
      const order = compareSpecificity(specificityOf(candidateSelector), target)
      return order > 0 || (order === 0 && candidate.index > rule.index)
    })
  })
}

/**
 * The covering rule has to name the same thing, not merely mention focus somewhere. Compare the
 * subjects as sets of parts so `.x:focus-visible` covers both `.x` and `.x.active`, while an
 * unrelated `.y:focus-visible` covers neither. Ordering the parts as text would not work: a
 * covering rule is usually the shorter selector, and sorting moves its parts around.
 */
function coversSameSubject(candidateSelector, baseSelector) {
  const candidate = normaliseSubject(candidateSelector)
  const base = normaliseSubject(baseSelector)
  if (candidate.size === 0 || base.size === 0) return false
  const [smaller, larger] = candidate.size <= base.size ? [candidate, base] : [base, candidate]
  return [...smaller].every((part) => larger.has(part))
}

function normaliseSubject(selector) {
  const compounds = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean)
  const subject = compounds.at(-1) ?? ''
  const withoutFocus = subject.replace(/:focus-visible|:focus/g, '')
  return new Set(withoutFocus.match(/[.#]?[\w-]+|\[[^\]]*\]/g) ?? [])
}

function targetsFocusable(selector, focusableClasses) {
  if (FOCUSABLE_ATTRIBUTES.test(selector)) return true
  const compounds = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean)
  const subject = compounds.at(-1) ?? ''
  const type = subject.match(/^[a-zA-Z][\w-]*/)?.[0]?.toLowerCase()
  if (type && FOCUSABLE_TAGS.has(type)) return true
  return (subject.match(/\.([\w-]+)/g) ?? []).some((className) => focusableClasses.has(className.slice(1)))
}

/** `transition: box-shadow ...` names the property without setting it. */
function setsBoxShadow(declarations) {
  return declarations.some(({ property }) => property === 'box-shadow')
}

function parseRules(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  const rules = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = pattern.exec(withoutComments)) !== null) {
    const selector = match[1].trim()
    if (!selector || selector.startsWith('@')) continue
    rules.push({
      selector,
      declarations: parseDeclarations(match[2]),
      index: match.index
    })
  }
  return rules
}

function parseDeclarations(block) {
  return block.split(';').flatMap((entry) => {
    const separator = entry.indexOf(':')
    if (separator === -1) return []
    return [{ property: entry.slice(0, separator).trim().toLowerCase(), value: entry.slice(separator + 1).trim() }]
  })
}

function splitSelectorList(selector) {
  const parts = []
  let depth = 0
  let current = ''
  for (const character of selector) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current.trim()) parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** Enough of the cascade to compare siblings; `:where()` contributing nothing is the point. */
export function specificityOf(selector) {
  let working = selector.replace(/:where\([^)]*\)/g, ' ')
  const ids = (working.match(/#[\w-]+/g) ?? []).length
  const classes = (working.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(\([^)]*\))?/g) ?? [])
    .filter((token) => !/^::/.test(token))
    .length
  const types = (working.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length
  return { ids, classes, types }
}

function compareSpecificity(left, right) {
  if (left.ids !== right.ids) return left.ids - right.ids
  if (left.classes !== right.classes) return left.classes - right.classes
  return left.types - right.types
}

function formatSpecificity({ ids, classes, types }) {
  return `(${ids},${classes},${types})`
}

/** Class names alone cannot say whether an element takes focus; the JSX can. */
export function collectFocusableClasses(sources) {
  const classes = new Set()
  for (const { source } of sources) {
    const pattern = /<([a-zA-Z][\w.]*)([^>]*?)>/g
    let match
    while ((match = pattern.exec(source)) !== null) {
      const tag = match[1].toLowerCase()
      if (!FOCUSABLE_TAGS.has(tag)) continue
      const attributes = match[2]
      const className = attributes.match(/className=(\{[\s\S]*?\}|"[^"]*")/)?.[1]
      if (!className) continue
      for (const literal of className.match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? []) {
        for (const name of literal.slice(1, -1).split(/\s+/)) {
          if (/^[\w-]+$/.test(name)) classes.add(name)
        }
      }
    }
  }
  return classes
}

export function formatReport({ exceptions = [], violations }) {
  const lines = []
  if (violations.length > 0) {
    lines.push(`Focus-ring validation failed with ${violations.length} violation(s):`, '')
    for (const violation of violations) {
      lines.push(`  ${violation.file}:${violation.line} ${violation.selector} ${violation.specificity}`)
      lines.push(`    ${violation.remedy}`)
      lines.push('')
    }
  }
  if (exceptions.length > 0) {
    lines.push(`Accepted focus-ring exceptions (${exceptions.length}):`)
    for (const exception of exceptions) {
      lines.push(`  ALLOW ${exception.file}:${exception.line} ${exception.selector}`)
      lines.push(`    Reason: ${exception.reason}`)
    }
    lines.push('')
  }
  if (violations.length === 0) {
    lines.push('Focus-ring validation passed: every focusable box-shadow restates the ring on focus.')
  }
  return lines.join('\n')
}

export function toDisplayPath(filePath, rootDir = PROJECT_ROOT) {
  return path.relative(rootDir, filePath).split(path.sep).join('/')
}

export async function validateRendererTree(rootDir = PROJECT_ROOT) {
  const files = await collectFiles(path.join(rootDir, 'src', 'renderer'))
  const markup = await Promise.all(
    files.filter((file) => file.endsWith('.tsx')).map(async (file) => ({ filePath: file, source: await readFile(file, 'utf8') }))
  )
  const focusableClasses = collectFocusableClasses(markup)
  const violations = []
  const exceptions = []
  for (const file of files.filter((entry) => entry.endsWith('.css'))) {
    const source = await readFile(file, 'utf8')
    const result = validateSource({ filePath: file, rootDir, source, focusableClasses })
    violations.push(...result.violations)
    exceptions.push(...result.exceptions)
  }
  return { exceptions, violations }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath))
    else if (entry.isFile() && /\.(css|tsx)$/.test(entry.name)) files.push(entryPath)
  }
  return files
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length
}

const isDirectRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isDirectRun) {
  const result = await validateRendererTree(PROJECT_ROOT)
  console.log(formatReport(result))
  if (result.violations.length > 0) process.exitCode = 1
}
