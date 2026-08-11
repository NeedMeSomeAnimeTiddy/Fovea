const { extractFile } = require('@electron/asar')
const { join } = require('node:path')

const expectedPublisher = process.env.FOVEA_WINDOWS_PUBLISHER?.trim()
if (!expectedPublisher) throw new Error('FOVEA_WINDOWS_PUBLISHER is required.')

const asarPath = join(process.cwd(), 'dist', 'win-unpacked', 'resources', 'app.asar')
const packageMetadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'))
const marker = packageMetadata.foveaUpdateRelease

const expected = {
  schemaVersion: 1,
  enabled: true,
  provider: 'github',
  repository: 'NeedMeSomeAnimeTiddy/Fovea',
  channel: 'latest',
  architectures: ['x64'],
  publisherName: expectedPublisher,
  integrity: 'sha512-and-authenticode',
  installMode: 'user-confirmed'
}

if (JSON.stringify(marker) !== JSON.stringify(expected)) {
  throw new Error('The packaged application is missing the exact signed-release update marker.')
}

console.log('Verified the packaged signed-release update marker.')
