import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import sharp from 'sharp'

const outputDirectory = path.resolve(process.argv[2] || '.paddle-ocr-cache', 'fixtures')
const imagePath = path.join(outputDirectory, 'screen-text.png')
const truthPath = path.join(outputDirectory, 'screen-text.txt')
const denseImagePath = path.join(outputDirectory, 'screen-dense.png')
const denseTruthPath = path.join(outputDirectory, 'screen-dense.txt')
const retryImagePath = path.join(outputDirectory, 'screen-retry.png')
const retryTruthPath = path.join(outputDirectory, 'screen-retry.txt')
const lines = [
  'Fovea Analyze Mode',
  'Identify visible controls and complete sentences on the frozen screen.',
  'The quick brown fox jumps over 13 lazy dogs.',
  'Capture screen',
  'Open settings',
  'OCR',
  'Status: Ready — local processing only',
  'FOVEA_PADDLE_OCR_PROFILE=medium',
  'Docs: https://example.com/help',
  'Email: hello@example.com'
]
const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
    <rect width="1920" height="1080" fill="#101419"/>
    <rect x="0" y="0" width="1920" height="72" fill="#202832"/>
    <text x="42" y="47" fill="#f6f8fa" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="600">${lines[0]}</text>
    <text x="76" y="160" fill="#f6f8fa" font-family="Segoe UI, Arial, sans-serif" font-size="24">${lines[1]}</text>
    <text x="76" y="204" fill="#c9d1d9" font-family="Segoe UI, Arial, sans-serif" font-size="19">${lines[2]}</text>
    <rect x="76" y="264" width="220" height="58" rx="10" fill="#2f81f7"/>
    <text x="112" y="301" fill="#ffffff" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="600">${lines[3]}</text>
    <rect x="320" y="264" width="214" height="58" rx="10" fill="#30363d" stroke="#8b949e"/>
    <text x="354" y="301" fill="#f0f3f6" font-family="Segoe UI, Arial, sans-serif" font-size="20">${lines[4]}</text>
    <rect x="558" y="264" width="86" height="58" rx="10" fill="#30363d" stroke="#8b949e"/>
    <text x="580" y="301" fill="#f0f3f6" font-family="Segoe UI, Arial, sans-serif" font-size="20">${lines[5]}</text>
    <text x="76" y="390" fill="#7ee787" font-family="Segoe UI, Arial, sans-serif" font-size="16">${lines[6]}</text>
    <rect x="76" y="430" width="760" height="70" rx="8" fill="#0d1117" stroke="#30363d"/>
    <text x="100" y="473" fill="#d2a8ff" font-family="Cascadia Mono, Consolas, monospace" font-size="18">${lines[7]}</text>
    <text x="76" y="570" fill="#a5d6ff" font-family="Segoe UI, Arial, sans-serif" font-size="15">${lines[8]}</text>
    <text x="76" y="608" fill="#a5d6ff" font-family="Segoe UI, Arial, sans-serif" font-size="15">${lines[9]}</text>
  </svg>
`
const denseLines = [
  'Analyze the current frozen screen',
  'Every visible sentence should be selectable.',
  'Account settings',
  'Privacy and security',
  'Notifications',
  'Appearance',
  'Keyboard shortcuts',
  'Language and region',
  'Downloads',
  'Accessibility',
  'Advanced options',
  'Open documentation',
  'Report an issue',
  'Version 0.1.0',
  'Status: Ready',
  'Local OCR processing enabled'
]
const denseSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
    <rect width="640" height="360" fill="#f6f8fa"/>
    <rect x="0" y="0" width="640" height="24" fill="#24292f"/>
    <text x="12" y="16" fill="#ffffff" font-family="Segoe UI, Arial, sans-serif" font-size="7" font-weight="600">${denseLines[0]}</text>
    ${denseLines.slice(1).map((line, index) => `
      <text x="${index % 2 === 0 ? 24 : 340}" y="${42 + Math.floor(index / 2) * 38}"
        fill="${index % 3 === 0 ? '#57606a' : '#24292f'}"
        font-family="Segoe UI, Arial, sans-serif" font-size="${index % 4 === 0 ? 5 : 6}">${line}</text>
    `).join('')}
  </svg>
`
const retryLines = [
  'Tiny toolbar label',
  'Secondary navigation',
  'Low contrast caption',
  'Visible status message'
]
const retrySvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
    <rect width="960" height="540" fill="#f6f8fa"/>
    ${retryLines.map((line, index) => `
      <text x="${48 + index * 180}" y="${55 + index * 105}"
        fill="${index === 2 ? '#8c959f' : '#24292f'}"
        font-family="Segoe UI, Arial, sans-serif" font-size="${index === 2 ? 6 : 7}">${line}</text>
    `).join('')}
  </svg>
`

await mkdir(outputDirectory, { recursive: true })
await sharp(Buffer.from(svg)).png().toFile(imagePath)
await writeFile(truthPath, `${lines.join('\n')}\n`, 'utf8')
await sharp(Buffer.from(denseSvg)).png().toFile(denseImagePath)
await writeFile(denseTruthPath, `${denseLines.join('\n')}\n`, 'utf8')
await sharp(Buffer.from(retrySvg)).png().toFile(retryImagePath)
await writeFile(retryTruthPath, `${retryLines.join('\n')}\n`, 'utf8')
console.log(imagePath)
console.log(denseImagePath)
console.log(retryImagePath)
