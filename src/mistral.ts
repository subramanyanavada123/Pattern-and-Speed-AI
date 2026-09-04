import { keyStore } from './store'

const ENDPOINT = 'https://api.mistral.ai/v1'

export class MistralError extends Error {
  status?: number
  retryAfterSeconds?: number
  constructor(message: string, status?: number, retryAfterSeconds?: number) {
    super(message)
    this.name = 'MistralError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

type GenOpts = {
  system?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  json?: boolean
}

type ChatMessage = { role: 'system' | 'user'; content: string }

function headers(key: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
}

function messages(prompt: string, system?: string): ChatMessage[] {
  return system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }]
}

function retrySeconds(detail: string, retryAfter?: string | null): number | undefined {
  const headerSeconds = retryAfter ? Number(retryAfter) : NaN
  if (Number.isFinite(headerSeconds)) return Math.ceil(headerSeconds)
  const bodySeconds = detail.match(/retry(?: in| after)?\s*([\d.]+)s/i)?.[1]
  return bodySeconds ? Math.ceil(Number(bodySeconds)) : undefined
}

function quotaMessage(model: string, detail: string, retryAfter?: string | null): string {
  const daily = /per.?day|daily|free.?tier|quota.*exceeded/i.test(detail)
  if (daily) return `Mistral daily quota is exhausted for ${model}. Use scripted mode or another Mistral key/project until the quota resets.`
  const seconds = retrySeconds(detail, retryAfter)
  return `Mistral rate limit hit for ${model}. Wait ${seconds ? `${seconds}s` : 'a moment'} before retrying.`
}

function responseText(json: any): string {
  const content = json?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) return content.map((part: any) => typeof part === 'string' ? part : part?.text ?? '').join('').trim()
  return ''
}

async function detailOf(res: Response): Promise<string> {
  try {
    const json = await res.json()
    return json?.message || json?.error?.message || json?.error || ''
  } catch {
    return ''
  }
}

function buildBody(prompt: string, opts: GenOpts, stream = false): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: keyStore.model(),
    messages: messages(prompt, opts.system),
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 700,
    stream,
  }
  if (opts.json) body.response_format = { type: 'json_object' }
  return body
}

async function requestChat(key: string, prompt: string, opts: GenOpts, stream = false): Promise<Response> {
  const request = (json: boolean) => fetch(`${ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify(buildBody(prompt, { ...opts, json }, stream)),
    signal: opts.signal,
  })
  let res = await request(!!opts.json)
  // Mistral JSON mode is supported by the API, but an occasional 500 from the
  // service should not take down the live experience. The app already parses
  // JSON locally, so retry once as ordinary text.
  if (res.status >= 500 && opts.json) res = await request(false)
  return res
}

export async function generate(prompt: string, opts: GenOpts = {}): Promise<string> {
  const key = keyStore.get()
  if (!key) throw new MistralError('No Mistral API key set', 0)
  const model = keyStore.model()
  let res: Response
  try {
    res = await requestChat(key, prompt, opts)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new MistralError('Network error reaching Mistral', 0)
  }
  if (!res.ok) {
    const detail = await detailOf(res)
    if (res.status === 401) throw new MistralError('That Mistral API key was rejected. Check it in Settings.', 401)
    if (res.status === 429) throw new MistralError(quotaMessage(model, detail, res.headers.get('retry-after')), 429, retrySeconds(detail, res.headers.get('retry-after')))
    if (res.status === 404) throw new MistralError(`Mistral model "${model}" is not available to this key. Refresh models in Settings.`, 404)
    throw new MistralError(detail || `Mistral returned ${res.status}. Try another available model.`, res.status)
  }
  const text = responseText(await res.json())
  if (!text) throw new MistralError('Mistral returned no text')
  return text
}

export async function* stream(prompt: string, opts: GenOpts = {}): AsyncGenerator<string> {
  const key = keyStore.get()
  if (!key) throw new MistralError('No Mistral API key set', 0)
  const model = keyStore.model()
  let res: Response
  try {
    res = await requestChat(key, prompt, opts, true)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new MistralError('Network error reaching Mistral', 0)
  }
  if (!res.ok || !res.body) {
    const detail = await detailOf(res)
    if (res.status === 401) throw new MistralError('That Mistral API key was rejected. Check it in Settings.', 401)
    if (res.status === 429) throw new MistralError(quotaMessage(model, detail, res.headers.get('retry-after')), 429, retrySeconds(detail, res.headers.get('retry-after')))
    if (res.status === 404) throw new MistralError(`Mistral model "${model}" is not available to this key. Refresh models in Settings.`, 404)
    throw new MistralError(detail || `Mistral returned ${res.status}. Try another available model.`, res.status)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawText = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const chunk = JSON.parse(payload)?.choices?.[0]?.delta?.content
        if (chunk) { sawText = true; yield chunk }
      } catch { /* wait for the next complete SSE line */ }
    }
  }
  if (!sawText) throw new MistralError('Mistral returned no streamed text')
}

export type ModelInfo = { name: string; displayName: string; supportsGenerate: boolean }

export async function listModels(): Promise<ModelInfo[]> {
  const key = keyStore.get()
  if (!key) throw new MistralError('No Mistral API key set', 0)
  let res: Response
  try { res = await fetch(`${ENDPOINT}/models`, { headers: headers(key) }) } catch { throw new MistralError('Network error reaching Mistral') }
  if (!res.ok) {
    const detail = await detailOf(res)
    if (res.status === 401) throw new MistralError('That Mistral API key was rejected. Check it in Settings.', 401)
    if (res.status === 429) throw new MistralError(quotaMessage('model discovery', detail, res.headers.get('retry-after')), 429)
    throw new MistralError(detail || `Mistral returned ${res.status}`, res.status)
  }
  const json = await res.json()
  const models: { id?: string; name?: string; capabilities?: { completion_chat?: boolean } }[] = json?.data ?? []
  return models.filter((m) => (m.id || m.name) && m.capabilities?.completion_chat === true).map((m) => ({
    name: m.id || m.name as string,
    displayName: m.name || m.id as string,
    supportsGenerate: m.capabilities?.completion_chat !== false,
  }))
}

export async function testKey(): Promise<{ ok: true } | { ok: false; error: string }> {
  try { await generate('Reply with the single word: ready', { maxTokens: 10, temperature: 0 }); return { ok: true } }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
}

export function extractJson<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fence ? fence[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) as T } catch { return null }
}
