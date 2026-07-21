import { mkdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'resources/assets/fovea-aperture.svg')
const output = resolve(root, 'resources/assets/generated')
const sizes = [16, 20, 24, 32, 48, 64, 128, 256, 512]
const icoSizes = [16, 20, 24, 32, 48, 64, 128, 256]
const check = process.argv.includes('--check')

await mkdir(output, { recursive: true })
const svg = await readFile(source)
const pngPaths = []
for (const size of sizes) {
  const path = resolve(output, `fovea-${size}.png`)
  if (!check) await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toFile(path)
  const metadata = await sharp(path).metadata()
  if (metadata.width !== size || metadata.height !== size || metadata.hasAlpha !== true) {
    throw new Error(`Invalid ${size}px application asset.`)
  }
  if (icoSizes.includes(size)) pngPaths.push(path)
}
const icoPath = resolve(output, 'fovea.ico')
if (!check) await import('node:fs/promises').then(({ writeFile }) => pngToIco(pngPaths).then((ico) => writeFile(icoPath, ico)))
if ((await stat(icoPath)).size < 1024) throw new Error('Generated ICO is unexpectedly small.')

const trayStates = {
  idle: '',
  busy: '<circle cx="18" cy="6" r="3" fill="#fff"/>',
  disconnected: '<path d="M3 3 21 21" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  paused: '<path d="M8 6v12M16 6v12" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>'
}
for (const [state, marker] of Object.entries(trayStates)) {
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#fff" fill-rule="evenodd" d="M12 2.3a9.7 9.7 0 0 1 7.9 4.1l-5.1 1.5-3.5-4.1-1.2 5.2-5.2 1.2A9.7 9.7 0 0 1 12 2.3Zm8.2 5.9a9.7 9.7 0 0 1-.3 9l-3.9-3.6 1.5-5.2 2.7-.2Zm-1.4 10.6a9.7 9.7 0 0 1-7.8 2.9l1.2-5.2 5.2-1.2 1.4 3.5ZM9.2 21.3a9.7 9.7 0 0 1-6-6l5.1-1.5 3.5 4.1-2.6 3.4ZM3.8 13.6a9.7 9.7 0 0 1 .3-9L8 8.2l-1.5 5.2-2.7.2ZM5.2 5.2A9.7 9.7 0 0 1 13 2.3l-1.2 5.2-5.2 1.2-1.4-3.5ZM12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z"/>${marker}</svg>`
  for (const size of [16, 20, 24, 32]) {
    const path = resolve(output, `tray-${state}-${size}.png`)
    if (!check) await sharp(Buffer.from(traySvg)).resize(size, size).png({ compressionLevel: 9 }).toFile(path)
    const metadata = await sharp(path).metadata()
    if (metadata.width !== size || metadata.height !== size || !metadata.hasAlpha) throw new Error(`Invalid ${state} tray asset.`)
  }
}
