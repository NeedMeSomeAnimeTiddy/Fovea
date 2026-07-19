import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import readline from 'node:readline'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const binary = resolve(root, 'resources', 'sidecar', 'codex.exe')
const codexHome = resolve(root, '.sidecar-smoke')
await mkdir(codexHome, { recursive: true })

const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, CODEX_HOME: codexHome }
})
const lines = readline.createInterface({ input: child.stdout })
const timeout = setTimeout(() => finish(new Error('Timed out waiting for app-server handshake.')), 15_000)

child.once('error', finish)
child.once('exit', (code) => {
  if (code && code !== 0) void finish(new Error(`App-server exited with ${code}.`))
})
lines.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === 1 && message.result) {
    send({ method: 'initialized' })
    send({ method: 'account/read', id: 2, params: { refreshToken: false } })
  } else if (message.id === 2 && message.result) {
    const accountType = message.result.account?.type ?? 'signed-out'
    console.log(`Codex app-server handshake succeeded; account state: ${accountType}.`)
    void finish()
  } else if (message.error) {
    void finish(new Error(String(message.error.message ?? 'App-server returned an error.')))
  }
})

send({
  method: 'initialize',
  id: 1,
  params: { clientInfo: { name: 'snipchat_smoke', title: 'SnipChat smoke test', version: '0.1.0' } }
})

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

let finished = false
async function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  lines.close()
  const exited = child.exitCode === null ? new Promise((resolveExit) => child.once('exit', resolveExit)) : Promise.resolve()
  if (!child.killed) child.kill()
  await exited
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(codexHome, { recursive: true, force: true })
      break
    } catch (cleanupError) {
      if (attempt === 4) throw cleanupError
      await delay(100 * (attempt + 1))
    }
  }
  if (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
