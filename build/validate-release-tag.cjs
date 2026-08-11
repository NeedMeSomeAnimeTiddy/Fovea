const { version } = require('../package.json')

const tag = process.argv[2] || process.env.GITHUB_REF_NAME
if (!tag) throw new Error('Pass the release tag, for example v0.2.0.')
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`Stable releases require a vMAJOR.MINOR.PATCH tag; received ${tag}.`)
}
if (tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match package version ${version}.`)
}

console.log(`Validated Fovea ${tag} as a stable release.`)
