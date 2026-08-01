import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

const DATASET = 'bevaya/ScreenSpot'
const DATASET_URL = 'https://huggingface.co/datasets/bevaya/ScreenSpot'
const DATASET_API = 'https://datasets-server.huggingface.co/first-rows?dataset=bevaya%2FScreenSpot&config=default&split=test'
const APACHE_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0.txt'
const SELECTED_ROWS = [2, 4, 5, 6, 8, 9, 14, 18, 22, 29, 31, 33, 35, 39, 40, 42, 43, 49, 50, 90]
const EXPECTED_IMAGE_SHA256 = new Map([
  [2, '4915e070e5112ac965663f6e2db858705a57ccf8344bde573d040686b6cb91fa'],
  [4, '16c2dd5af0d7a74eeb91f3e8b908f3ed263e3d2ad3b7b46a7cd8fe6c329d989c'],
  [5, '16d846f982a807002e742f1db69b4918b1003b20c9af1009822a8839701c59d9'],
  [6, '1cf294589858b52d92bf620e150f164b0b3da0f84b1c320a692c49061445802b'],
  [8, '4f159e8ff410ccec74d025783cd8a580727e6ea176cae953211e0972bf8cd576'],
  [9, 'f7315fd0315ebb1e88c58e1eee84a5982be0d0bf2d7dd4a0ab0af949062da4cd'],
  [14, '7fba730b395787fe93f96d2a12285a3529d41c25e3f05e52d0e2e489dffa389c'],
  [18, '74b8db0e7df4ea68c8e2495e62d690e72822038e3951a8f79ee26021fc1c4941'],
  [22, 'ee611afef62f987b7a4fbb6e9e2df05f55979ee3f57cb1cf66f8a7cddca31bdf'],
  [29, '9c2d101e05f2dd3f736281a2b403aa94ec5c27519b3176440af0f48b44d3a52a'],
  [31, '841a2f39e01fd1ad119f7a101714af09d00ba076620f0e8b866e9401cc90482b'],
  [33, '62f26ef9bbd92ed1b10c54ecd08711c0b2b7c40ee09e3e74c05cd5a8902f8982'],
  [35, '5b9e17ba299127e16e1929908eab50755997ae1f8491982ba740647d2047c1f4'],
  [39, '4538836f9f060d530d51c57d69bf1e6eb1d6e18c0b4e8e8cd23f2cb116605bae'],
  [40, '1f84bb90ddb4542f5688830614a7e8685f4f12f109cc7c3fa0be58520f5cf108'],
  [42, 'a4875ab4e7f9b05c149752288bfbfdbb780bb2f0a1efd64b4ff0b0f598ef82c9'],
  [43, '49d6f59cdf10c6f3956a6ca4298974d47e6967941595bfb3751a6fbdb0c0c503'],
  [49, 'c2f2fb2b3891153b3a0e1139195e655a7e707afef4a68b12c01bed4c7e8f4869'],
  [50, '0e597a24255a07b3990ee5a70610e08bb42738e448890dc402931af0ae873713'],
  [90, '5fd12111163fb91fa6f7993cb7834ff87bff801fcb05f759662ac7b2a1255c6c']
])
const corpusDirectory = resolve(process.argv[2] ?? join('tests', 'fixtures', 'analyze-corpus'))
const imagesDirectory = join(corpusDirectory, 'images')

await mkdir(imagesDirectory, { recursive: true })
const response = await fetch(DATASET_API)
if (!response.ok) throw new Error(`ScreenSpot API returned ${response.status} ${response.statusText}`)
const payload = await response.json()
const rows = new Map(payload.rows.map((entry) => [entry.row_idx, entry.row]))
const manifestEntries = []

for (const rowIndex of SELECTED_ROWS) {
  const row = rows.get(rowIndex)
  if (!row) throw new Error(`ScreenSpot row ${rowIndex} was not returned by the dataset API`)
  const id = `screenspot-${String(rowIndex).padStart(3, '0')}`
  const imageResponse = await fetch(row.image.src)
  if (!imageResponse.ok) throw new Error(`ScreenSpot image ${rowIndex} returned ${imageResponse.status}`)
  const image = Buffer.from(await imageResponse.arrayBuffer())
  if (image.length < 8 || image.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new Error(`ScreenSpot row ${rowIndex} did not return a PNG image`)
  }
  const sha256 = createHash('sha256').update(image).digest('hex')
  if (sha256 !== EXPECTED_IMAGE_SHA256.get(rowIndex)) {
    throw new Error(`ScreenSpot row ${rowIndex} has changed (received SHA-256 ${sha256})`)
  }
  const imageFile = join('images', `${id}.png`).replaceAll('\\', '/')
  await writeFile(join(corpusDirectory, imageFile), image)
  const [left, top, right, bottom] = row.bbox
  const expected = {
    partialAnnotations: true,
    matchMode: 'target-center',
    source: {
      dataset: DATASET,
      datasetUrl: DATASET_URL,
      split: 'test',
      rowIndex,
      sourceFileName: row.file_name,
      instruction: row.instruction,
      dataType: row.data_type,
      dataSource: row.data_source,
      license: 'Apache-2.0'
    },
    image: imageFile,
    features: [{
      id: `${id}-target`,
      kind: 'any',
      label: String(row.instruction).trim(),
      bounds: {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top
      }
    }],
    forbiddenRegions: []
  }
  await writeFile(join(corpusDirectory, `${id}.expected.json`), `${JSON.stringify(expected, null, 2)}\n`)
  manifestEntries.push({
    id,
    rowIndex,
    image: imageFile,
    sourceFileName: row.file_name,
    width: row.image.width,
    height: row.image.height,
    sha256,
    instruction: String(row.instruction).trim(),
    dataType: row.data_type,
    dataSource: row.data_source,
    bbox: row.bbox
  })
  console.log(`[analyze-corpus] downloaded ${id}: ${row.instruction}`)
}

const licenseResponse = await fetch(APACHE_LICENSE_URL)
if (!licenseResponse.ok) throw new Error(`Apache license download returned ${licenseResponse.status}`)
await writeFile(join(corpusDirectory, 'LICENSE.apache-2.0.txt'), await licenseResponse.text())
await writeFile(join(corpusDirectory, 'manifest.json'), `${JSON.stringify({
  dataset: DATASET,
  datasetUrl: DATASET_URL,
  license: 'Apache-2.0',
  split: 'test',
  selectedRows: SELECTED_ROWS,
  entries: manifestEntries
}, null, 2)}\n`)
console.log(`[analyze-corpus] wrote ${manifestEntries.length} reproducible fixtures to ${corpusDirectory}`)
