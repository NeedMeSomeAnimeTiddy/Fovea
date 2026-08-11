const packageMetadata = require('../package.json')

const REQUIRED_ENVIRONMENT = [
  'FOVEA_WINDOWS_PUBLISHER',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD'
]

const missing = REQUIRED_ENVIRONMENT.filter((name) => !process.env[name]?.trim())
if (missing.length > 0) {
  throw new Error(
    `Signed Fovea releases require these environment values: ${missing.join(', ')}. ` +
    'Use the normal package configuration for local unsigned builds.'
  )
}

const publisherName = process.env.FOVEA_WINDOWS_PUBLISHER.trim()
if (publisherName.length > 200 || publisherName !== process.env.FOVEA_WINDOWS_PUBLISHER) {
  throw new Error('FOVEA_WINDOWS_PUBLISHER must be the exact certificate common name without surrounding whitespace.')
}

const base = packageMetadata.build

module.exports = {
  ...base,
  forceCodeSigning: true,
  extraMetadata: {
    ...(base.extraMetadata ?? {}),
    foveaUpdateRelease: {
      schemaVersion: 1,
      enabled: true,
      provider: 'github',
      repository: 'NeedMeSomeAnimeTiddy/Fovea',
      channel: 'latest',
      architectures: ['x64'],
      publisherName,
      integrity: 'sha512-and-authenticode',
      installMode: 'user-confirmed'
    }
  },
  publish: {
    provider: 'github',
    owner: 'NeedMeSomeAnimeTiddy',
    repo: 'Fovea',
    channel: 'latest',
    releaseType: 'draft',
    publishAutoUpdate: true
  },
  win: {
    ...base.win,
    target: ['nsis'],
    signExecutable: true,
    verifyUpdateCodeSignature: true,
    artifactName: 'Fovea-${version}-${arch}-Setup.${ext}',
    signtoolOptions: {
      ...(base.win?.signtoolOptions ?? {}),
      publisherName: [publisherName]
    }
  }
}
