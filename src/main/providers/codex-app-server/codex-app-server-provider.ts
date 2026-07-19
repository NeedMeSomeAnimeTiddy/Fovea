import { EventEmitter } from 'node:events'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import type { ProviderEvent, ProviderStatus, VisionModel } from '@shared/types/provider'
import type { VisionProvider } from '../vision-provider'
import { AsyncQueue } from './async-queue'
import { JsonlRpcClient } from './jsonl-rpc-client'
import type {
  JsonRpcNotification,
  JsonRpcRequest
} from './protocol'
import type { GetAccountResponse } from '../../../../resources/codex-schema/v2/GetAccountResponse'
import type { ModelListResponse } from '../../../../resources/codex-schema/v2/ModelListResponse'
import type { ThreadStartParams } from '../../../../resources/codex-schema/v2/ThreadStartParams'
import type { ThreadStartResponse } from '../../../../resources/codex-schema/v2/ThreadStartResponse'
import type { TurnStartParams } from '../../../../resources/codex-schema/v2/TurnStartParams'
import type { TurnStartResponse } from '../../../../resources/codex-schema/v2/TurnStartResponse'
import type { UserInput } from '../../../../resources/codex-schema/v2/UserInput'
import type { CommandExecutionRequestApprovalResponse } from '../../../../resources/codex-schema/v2/CommandExecutionRequestApprovalResponse'
import type { FileChangeRequestApprovalResponse } from '../../../../resources/codex-schema/v2/FileChangeRequestApprovalResponse'
import type { PermissionsRequestApprovalResponse } from '../../../../resources/codex-schema/v2/PermissionsRequestApprovalResponse'

const PINNED_VERSION = '0.144.4'
const MODEL_CACHE_TTL_MS = 10 * 60 * 1_000
const MODEL_RETRY_COOLDOWN_MS = 60 * 1_000
const VISUAL_ASSISTANT_INSTRUCTION = `You are a general visual assistant, not a coding agent. Answer the user's question about the screenshot directly. Do not run commands, use tools, or modify files. Do not claim to see content that is not visible. Clearly state uncertainty. Keep answers concise and practical unless the user asks for detail.`

export interface CodexProviderOptions {
  binaryPath: string
  codexHome: string
  workingDirectory: string
  openExternal(url: string): Promise<void>
  getSelectedModel(): string | null
}

interface ActiveTurn {
  turnId: string
  queue: AsyncQueue<ProviderEvent>
  receivedDelta: boolean
}

export class CodexAppServerProvider extends EventEmitter implements VisionProvider {
  private child: ChildProcessWithoutNullStreams | null = null
  private rpc: JsonlRpcClient | null = null
  private ready = false
  private disposing = false
  private restartTimer: NodeJS.Timeout | null = null
  private restartAttempts = 0
  private status: ProviderStatus = { state: 'stopped', version: PINNED_VERSION, account: null }
  private modelCache: VisionModel[] | null = null
  private modelsFetchedAt = 0
  private modelRefreshBlockedUntil = 0
  private modelRequest: Promise<VisionModel[]> | null = null
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly conversationTurns = new Map<string, string>()

  constructor(private readonly options: CodexProviderOptions) {
    super()
  }

  async initialise(): Promise<void> {
    this.disposing = false
    await this.ensureRuntimeDirectories()
    await this.startSidecar()
  }

  async getStatus(): Promise<ProviderStatus> {
    return structuredClone(this.status)
  }

  async signInWithChatGPT(): Promise<void> {
    const rpc = await this.requireRpc()
    const result = await rpc.request<{ type: 'chatgpt'; loginId: string; authUrl: string }>('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt'
    })
    await this.options.openExternal(result.authUrl)
    await this.waitForLogin(result.loginId)
    this.invalidateModelCache()
    await this.refreshAccount()
  }

  async signInWithApiKey(apiKey: string): Promise<void> {
    if (!apiKey.trim()) throw new Error('Enter an OpenAI API key.')
    const rpc = await this.requireRpc()
    await rpc.request('account/login/start', { type: 'apiKey', apiKey: apiKey.trim() })
    this.invalidateModelCache()
    await this.refreshAccount()
  }

  async signOut(): Promise<void> {
    const rpc = await this.requireRpc()
    await rpc.request('account/logout')
    this.invalidateModelCache()
    await this.refreshAccount()
  }

  async listModels(): Promise<VisionModel[]> {
    const now = Date.now()
    if (this.modelCache && now - this.modelsFetchedAt < MODEL_CACHE_TTL_MS) {
      return structuredClone(this.modelCache)
    }
    if (this.modelRequest) return this.modelRequest
    if (now < this.modelRefreshBlockedUntil) {
      if (this.modelCache) return structuredClone(this.modelCache)
      throw new Error('Models are temporarily unavailable after a rate limit. Try again in a minute.')
    }

    this.modelRequest = this.fetchModels()
    try {
      return await this.modelRequest
    } finally {
      this.modelRequest = null
    }
  }

  async createConversation(): Promise<string> {
    const rpc = await this.requireRpc()
    const models = await this.listModels()
    const model = this.options.getSelectedModel() ?? models.find((entry) => entry.isDefault)?.id ?? models[0]?.id
    if (!model) throw new Error('No image-capable Codex model is available for this account.')
    const params: ThreadStartParams = {
      model,
      cwd: this.options.workingDirectory,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: VISUAL_ASSISTANT_INSTRUCTION,
      ephemeral: true,
      serviceName: 'snipchat'
    }
    const result = await rpc.request<ThreadStartResponse>('thread/start', params)
    return result.thread.id
  }

  async *sendMessage(
    conversationId: string,
    input: { text: string; imagePath?: string }
  ): AsyncIterable<ProviderEvent> {
    const rpc = await this.requireRpc()
    const queue = new AsyncQueue<ProviderEvent>()
    const items: UserInput[] = [{ type: 'text', text: input.text, text_elements: [] }]
    if (input.imagePath) items.push({ type: 'localImage', path: input.imagePath })

    const models = await this.listModels()
    const modelId = this.options.getSelectedModel() ?? models.find((model) => model.isDefault)?.id ?? models[0]?.id
    if (!modelId) throw new Error('No image-capable Codex model is available for this account.')
    const model = models.find((entry) => entry.id === modelId)
    const efforts = model?.supportedReasoningEfforts ?? []
    const effort: TurnStartParams['effort'] = efforts.includes('low')
      ? 'low'
      : efforts.includes('medium')
        ? 'medium'
        : (model?.defaultReasoningEffort as TurnStartParams['effort'])

    try {
      const params: TurnStartParams = {
        threadId: conversationId,
        input: items,
        cwd: this.options.workingDirectory,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        model: modelId,
        ...(effort ? { effort } : {})
      }
      const result = await rpc.request<TurnStartResponse>('turn/start', params)
      const active: ActiveTurn = { turnId: result.turn.id, queue, receivedDelta: false }
      this.activeTurns.set(conversationId, active)
      this.conversationTurns.set(conversationId, result.turn.id)
      queue.push({ type: 'started', turnId: result.turn.id })
    } catch (error) {
      queue.push({ type: 'error', message: this.errorMessage(error) })
      queue.close()
    }

    yield* queue
  }

  async cancel(conversationId: string): Promise<void> {
    const turnId = this.conversationTurns.get(conversationId)
    if (!turnId) return
    const rpc = await this.requireRpc()
    await rpc.request('turn/interrupt', { threadId: conversationId, turnId })
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const rpc = await this.requireRpc()
    await rpc.request('thread/delete', { threadId: conversationId }).catch(() => undefined)
    this.activeTurns.delete(conversationId)
    this.conversationTurns.delete(conversationId)
  }

  async dispose(): Promise<void> {
    this.disposing = true
    this.ready = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    for (const active of this.activeTurns.values()) {
      active.queue.push({ type: 'error', message: 'Codex app-server stopped.' })
      active.queue.close()
    }
    this.activeTurns.clear()
    this.rpc?.terminate(new Error('Codex app-server stopped'))
    this.rpc = null
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill()
    this.setStatus({ state: 'stopped', version: PINNED_VERSION, account: null })
  }

  private async startSidecar(): Promise<void> {
    if (this.child || this.ready) return
    this.setStatus({ ...this.status, state: 'starting', error: undefined })
    try {
      await stat(this.options.binaryPath)
    } catch {
      throw new Error(`Bundled Codex ${PINNED_VERSION} is missing. Run npm run sidecar:fetch.`)
    }

    const child = spawn(this.options.binaryPath, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: this.options.workingDirectory,
      env: { ...process.env, CODEX_HOME: this.options.codexHome }
    })
    this.child = child
    const rpc = new JsonlRpcClient((line) => {
      if (!child.stdin.writable) throw new Error('Codex app-server input is closed')
      child.stdin.write(`${line}\n`)
    })
    this.rpc = rpc

    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => rpc.acceptLine(line))
    rpc.on('notification', (notification: JsonRpcNotification) => this.handleNotification(notification))
    rpc.on('request', (request: JsonRpcRequest) => this.handleServerRequest(request))
    rpc.on('protocolError', (error: Error) => this.emit('warning', error.message))

    child.stderr.on('data', (data: Buffer) => {
      const safe = this.redact(String(data)).trim()
      if (safe) this.emit('diagnostic', safe.slice(0, 1_000))
    })
    child.once('error', (error) => this.handleTermination(error))
    child.once('exit', (code, signal) => {
      if (this.child === child) this.handleTermination(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'}).`))
    })

    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'snipchat', title: 'SnipChat', version: '0.1.0' }
      })
      rpc.notify('initialized')
      this.ready = true
      this.restartAttempts = 0
      await this.refreshAccount()
    } catch (error) {
      this.handleTermination(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private async refreshAccount(): Promise<void> {
    const rpc = this.rpc
    if (!rpc || !this.ready) return
    const result = await rpc.request<GetAccountResponse>('account/read', { refreshToken: false })
    const account = result.account?.type === 'chatgpt' || result.account?.type === 'apiKey' ? result.account : null
    this.setStatus({
      state: account ? 'ready' : 'signed-out',
      version: PINNED_VERSION,
      account
    })
  }

  private async fetchModels(): Promise<VisionModel[]> {
    try {
      const rpc = await this.requireRpc()
      const result = await rpc.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false })
      const models = result.data
        .filter((model) => (model.inputModalities ?? ['text', 'image']).includes('image'))
        .map((model) => ({
          id: model.id || model.model || '',
          displayName: model.displayName,
          isDefault: Boolean(model.isDefault),
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((entry) => entry.reasoningEffort),
          inputModalities: model.inputModalities ?? ['text', 'image']
        }))
        .filter((model) => model.id.length > 0)
      this.modelCache = models
      this.modelsFetchedAt = Date.now()
      this.modelRefreshBlockedUntil = 0
      return structuredClone(models)
    } catch (error) {
      if (this.isRateLimitError(error)) this.modelRefreshBlockedUntil = Date.now() + MODEL_RETRY_COOLDOWN_MS
      throw error
    }
  }

  private invalidateModelCache(): void {
    this.modelCache = null
    this.modelsFetchedAt = 0
    this.modelRefreshBlockedUntil = 0
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const params = notification.params ?? {}
    if (notification.method === 'account/updated') {
      void this.refreshAccount().catch((error) => this.setStatus({ ...this.status, error: this.errorMessage(error) }))
      this.emit('notification', notification)
      return
    }
    if (notification.method === 'account/login/completed') {
      this.emit('notification', notification)
      return
    }

    const threadId = params.threadId as string | undefined
    if (!threadId) return
    const active = this.activeTurns.get(threadId)
    if (!active) return
    const turnId = (params.turnId as string | undefined) ?? params.turn?.id
    if (turnId && turnId !== active.turnId) return

    if (
      notification.method === 'item/started' &&
      ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(String(params.item?.type))
    ) {
      active.queue.push({ type: 'error', message: 'SnipChat blocked an attempted tool action.' })
      void this.rpc?.request('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => undefined)
      return
    }

    if (notification.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      active.receivedDelta = true
      active.queue.push({ type: 'delta', text: params.delta })
      return
    }
    if (
      notification.method === 'item/completed' &&
      !active.receivedDelta &&
      params.item?.type === 'agentMessage' &&
      typeof params.item.text === 'string'
    ) {
      active.queue.push({ type: 'delta', text: params.item.text })
      return
    }
    if (notification.method === 'error') {
      active.queue.push({ type: 'error', message: String(params.error?.message ?? 'The model request failed.') })
      return
    }
    if (notification.method === 'turn/completed') {
      const status = params.turn?.status
      if (status === 'interrupted') active.queue.push({ type: 'cancelled' })
      else if (status === 'failed') {
        active.queue.push({ type: 'error', message: String(params.turn?.error?.message ?? 'The model request failed.') })
      } else active.queue.push({ type: 'completed' })
      active.queue.close()
      this.activeTurns.delete(threadId)
    }
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    const rpc = this.rpc
    if (!rpc) return
    if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
      const response: CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse = { decision: 'decline' }
      rpc.respond(request.id, response)
    } else if (request.method === 'item/permissions/requestApproval') {
      const response: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' }
      rpc.respond(request.id, response)
    } else if (request.method === 'item/tool/requestUserInput') {
      rpc.respondError(request.id, { code: -32601, message: 'SnipChat does not allow interactive tool requests.' })
    } else {
      rpc.respondError(request.id, { code: -32601, message: 'Unsupported server request.' })
    }
  }

  private handleTermination(error: Error): void {
    if (!this.child && !this.rpc) return
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && !child.killed) child.kill()
    this.ready = false
    this.rpc?.terminate(error)
    this.rpc = null
    for (const active of this.activeTurns.values()) {
      active.queue.push({ type: 'error', message: 'The local Codex service stopped unexpectedly.' })
      active.queue.close()
    }
    this.activeTurns.clear()
    this.setStatus({ ...this.status, state: 'error', error: error.message })

    if (!this.disposing && this.restartAttempts < 3) {
      const delay = 1_000 * 2 ** this.restartAttempts++
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        void this.startSidecar().catch(() => undefined)
      }, delay)
    }
  }

  private async requireRpc(): Promise<JsonlRpcClient> {
    if (this.disposing) throw new Error('Codex app-server is shutting down.')
    if (!this.ready || !this.rpc) await this.startSidecar()
    if (!this.rpc) throw new Error('Codex app-server is unavailable.')
    return this.rpc
  }

  private waitForLogin(loginId: string | null): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Sign-in timed out. Please try again.'))
      }, 10 * 60 * 1_000)
      const listener = (notification: JsonRpcNotification): void => {
        if (notification.method !== 'account/login/completed') return
        const params = notification.params ?? {}
        if ((params.loginId ?? null) !== loginId) return
        cleanup()
        if (params.success) resolve()
        else reject(new Error(String(params.error ?? 'Sign-in was not completed.')))
      }
      const cleanup = (): void => {
        clearTimeout(timeout)
        this.removeListener('notification', listener)
      }
      this.on('notification', listener)
    })
  }

  private async ensureRuntimeDirectories(): Promise<void> {
    await mkdir(this.options.codexHome, { recursive: true })
    await mkdir(this.options.workingDirectory, { recursive: true })
    const configPath = join(this.options.codexHome, 'config.toml')
    try {
      await stat(configPath)
    } catch {
      await writeFile(configPath, 'cli_auth_credentials_store = "keyring"\ndisable_response_storage = true\n', {
        encoding: 'utf8',
        mode: 0o600
      })
    }
  }

  private setStatus(status: ProviderStatus): void {
    if (JSON.stringify(this.status) === JSON.stringify(status)) return
    this.status = status
    this.emit('status', structuredClone(status))
  }

  private isRateLimitError(error: unknown): boolean {
    return /(?:\b429\b|rate limit|too many requests)/i.test(this.errorMessage(error))
  }

  private redact(value: string): string {
    return value
      .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
      .replace(/https?:\/\/\S*(?:oauth|authorize|callback)\S*/gi, '[REDACTED_AUTH_URL]')
      .replace(/(?:access|refresh)[_-]?token["'=:\s]+\S+/gi, 'token=[REDACTED]')
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

export { PINNED_VERSION }
