import { describe, expect, it } from 'vitest'
import { MAX_ANALYSE_FILES, parseAnalyseArguments } from '../src/main/shell/analyse-arguments'

const EXE = 'C:\\dev\\node_modules\\electron\\dist\\electron.exe'
const APP = 'C:\\dev\\fovea'

describe('Explorer analyse arguments', () => {
  it('ignores an ordinary launch', () => {
    expect(parseAnalyseArguments([EXE, APP], { appPath: APP })).toBeNull()
    expect(parseAnalyseArguments([EXE, APP, '--disable-transparent-windows'], { appPath: APP })).toBeNull()
  })

  it('reads a development cold start, where the app directory precedes the flag', () => {
    expect(parseAnalyseArguments([EXE, APP, '--analyse', 'C:\\shot.png'], { appPath: APP }))
      .toEqual({ paths: ['C:\\shot.png'], dropped: 0, action: 'analyse' })
  })

  it('reads a packaged cold start', () => {
    expect(parseAnalyseArguments(['C:\\Fovea\\Fovea.exe', '--analyse', 'C:\\shot.png']))
      .toEqual({ paths: ['C:\\shot.png'], dropped: 0, action: 'analyse' })
  })

  /**
   * The exact argv Electron forwards for an already-running app: switches hoisted to the front,
   * one of Chromium's own added, and the app directory left as a bare positional argument.
   */
  it('reads a second-instance launch after Chromium has reordered the command line', () => {
    expect(parseAnalyseArguments([
      EXE,
      '--analyse',
      '--allow-file-access-from-files',
      APP,
      'C:\\shot.png'
    ], { appPath: APP })).toEqual({ paths: ['C:\\shot.png'], dropped: 0, action: 'analyse' })
  })

  it('keeps a whole multi-file selection through the same reordering', () => {
    expect(parseAnalyseArguments([
      EXE,
      '--analyse',
      '--allow-file-access-from-files',
      APP,
      'C:\\a.png',
      'C:\\b.pdf',
      'C:\\c.jpg'
    ], { appPath: APP })).toEqual({ paths: ['C:\\a.png', 'C:\\b.pdf', 'C:\\c.jpg'], dropped: 0, action: 'analyse' })
  })

  it('never mistakes the app directory for a selected file', () => {
    expect(parseAnalyseArguments([EXE, '--analyse', APP], { appPath: APP })).toBeNull()
    expect(parseAnalyseArguments([EXE, '--analyse', `${APP}\\`, 'C:\\shot.png'], { appPath: APP }))
      .toEqual({ paths: ['C:\\shot.png'], dropped: 0, action: 'analyse' })
  })

  it('accepts the inline form', () => {
    expect(parseAnalyseArguments([EXE, '--analyse=C:\\a.png'])).toEqual({ paths: ['C:\\a.png'], dropped: 0, action: 'analyse' })
  })

  it('treats the same file selected twice as one attachment', () => {
    expect(parseAnalyseArguments([EXE, '--analyse', 'C:\\A.png', 'c:\\a.png']))
      .toEqual({ paths: ['C:\\A.png'], dropped: 0, action: 'analyse' })
  })

  it('caps the selection and reports what was dropped', () => {
    const paths = Array.from({ length: MAX_ANALYSE_FILES + 3 }, (_value, index) => `C:\\file-${index}.png`)
    const request = parseAnalyseArguments([EXE, '--analyse', ...paths])
    expect(request?.paths).toHaveLength(MAX_ANALYSE_FILES)
    expect(request?.dropped).toBe(3)
  })

  it('returns null when the flag carries no usable path', () => {
    expect(parseAnalyseArguments([EXE, '--analyse'])).toBeNull()
    expect(parseAnalyseArguments([EXE, '--analyse', '   '])).toBeNull()
    expect(parseAnalyseArguments([EXE, '--analyse', '--allow-file-access-from-files'], { appPath: APP })).toBeNull()
  })
})
