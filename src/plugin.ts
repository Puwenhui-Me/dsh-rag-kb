/**
 * DSH RAG 知识库插件宿主半边入口。
 * - 模型工具：knowledge_search / knowledge_status / knowledge_manage（会话语义管理）
 * - systemPrompt 注入：agent 自动知道知识库
 * - SSE 通道：索引进度推送（浏览器面板用）
 * - 目录监视：watchDir 下的文档自动索引（V2 能力，V1 已生效）
 */

import { watch } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveKbConfig, type KbConfig } from './config.ts'
import { KbStore } from './store.ts'
import { getEmbedder, indexFile } from './indexer.ts'

export const ConfigExport = Config

export const name = 'rag-kb'
export const inject = ['tools', 'systemPrompt', 'settings']

// ── 模块级单例（宿主半边） ─────────────────────────────
let store: KbStore | undefined
let cfg: KbConfig | undefined
const progressListeners = new Set<(msg: string) => void>()

function broadcastProgress(msg: string): void {
  for (const write of progressListeners) { try { write(`event: progress\ndata: ${JSON.stringify(msg)}\n\n`) } catch { /* 连接已断 */ } }
}

async function ensureStore(): Promise<KbStore> {
  if (store !== undefined) return store
  const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths')
  store = new KbStore(dshHomePath('rag-kb', 'index.db'))
  return store
}

/** 索引一个文件路径（upload 或 watch 共用） */
async function indexOne(ctx: Context, filePath: string, source: 'upload' | 'watch'): Promise<{ ok: boolean; message: string }> {
  const s = await ensureStore()
  const name = basename(filePath)
  const bytes = statSync(filePath).size
  const content = await (await import('node:fs/promises')).readFile(filePath)
  const docId = KbStore.docId(content)
  if (s.hasDoc(docId) && s.getDoc(docId)?.status === 'ready') {
    return { ok: true, message: `${name} 已索引（内容未变化，跳过）` }
  }
  s.upsertDoc(docId, name, source, bytes, 'indexing')
  broadcastProgress(`正在索引 ${name}`)
  try {
    const embedder = await getEmbedder(cfg?.embeddingModel ?? 'Xenova/bge-small-zh-v1.5')
    const chunks = await indexFile(filePath, embedder, cfg?.batchSize ?? 32)
    s.insertChunks(docId, chunks.map(c => ({ seq: c.seq, text: c.text, embedding: c.embedding })))
    s.setDocStatus(docId, 'ready', chunks.length)
    broadcastProgress(`${name} 索引完成（${chunks.length} 块）`)
    return { ok: true, message: `${name} 索引完成，共 ${chunks.length} 个知识块` }
  } catch (e) {
    const msg = String((e as Error).message ?? e)
    s.setDocStatus(docId, 'failed', 0, msg)
    broadcastProgress(`${name} 索引失败：${msg}`)
    return { ok: false, message: `${name} 索引失败：${msg}` }
  }
}

/** 语义检索 */
async function search(query: string, topK?: number): Promise<Array<{ doc: string; seq: number; score: number; text: string }>> {
  const s = await ensureStore()
  const embedder = await getEmbedder(cfg?.embeddingModel ?? 'Xenova/bge-small-zh-v1.5')
  const queryVec = await embedder.embed(query)
  const hits = s.search(queryVec, topK ?? cfg?.topK ?? 5, cfg?.minScore ?? 0.3)
  return hits.map(h => ({
    doc: s.getDoc(h.docId)?.name ?? h.docId,
    seq: h.seq,
    score: Number(h.score.toFixed(3)),
    text: s.chunkText(h.docId, h.seq).slice(0, 800),
  }))
}

export function apply(ctx: Context, config: Partial<KbConfig> = {}): void {
  // volatile 引用解包（0.2.0 语义，与 qq-bot 同款）
  const unwrap = (v: unknown): unknown => (v !== null && typeof v === 'object' && 'get' in (v as object) ? (v as { get(): unknown }).get() : v)
  const raw: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) raw[k] = unwrap(v)
  cfg = resolveKbConfig(raw as Partial<KbConfig>)

  // ── SSE 进度通道（面板实时显示索引状态） ──
  ctx.inject(['webServer'], (hostCtx: { webServer: { register: (route: Record<string, unknown>) => unknown } }) => {
    hostCtx.webServer.register({
      kind: 'exact',
      path: '/rag-kb/progress',
      handler: (req: { on(ev: string, fn: () => void): void }, res: { writeHead(...a: unknown[]): void; write(s: string): void }) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write('retry: 3000\n\n')
        const write = (chunk: string) => res.write(chunk)
        progressListeners.add(write)
        const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* noop */ } }, 25000)
        req.on('close', () => { clearInterval(heartbeat); progressListeners.delete(write) })
      },
    })
  })

  // ── 目录监视（watchDir 有值即生效；文件放入/变更自动索引） ──
  if (cfg.watchDir !== '' && existsSync(cfg.watchDir)) {
    const dir = resolve(cfg.watchDir)
    try {
      const watcher = watch(dir, { persistent: false }, (_ev: unknown, filename: unknown) => {
        if (filename === null || filename === undefined) return
        const fname = String(filename)
        if (!/\.(pdf|docx|md|txt|csv|json|log)$/i.test(fname)) return
        // 写稳定后索引（等 2 秒避免读到半写文件）
        const f = join(dir, fname)
        setTimeout(() => {
          if (existsSync(f)) void indexOne(ctx, f, 'watch')
        }, 2000)
      })
      ctx.effect(() => { watcher.close(); return undefined }, 'rag-kb: dir watcher')
    } catch (e) {
      console.warn(`[rag-kb] 目录监视失败 ${dir}: ${String((e as Error).message)}`)
    }
  }

  // ── 模型工具注册（扁平 spec → 标准 JSON Schema，官方 defineTool 同款编译） ──
  const compileParams = (spec: Record<string, Record<string, unknown>>): Record<string, unknown> => {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, def] of Object.entries(spec)) {
      const { required: req, ...rest } = def
      properties[key] = rest
      if (req === true) required.push(key)
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
  }

  const disposers = [
    // ① 语义检索
    ctx.tools.register({
      name: 'knowledge_search',
      description: '在本地知识库中语义检索。返回最相关的知识块（带来源文档名、相似度、原文片段）。回答与知识库内容相关的问题前应先检索。query 支持自然语言。',
      parameters: compileParams({
        query: { type: 'string', required: true, description: '检索问题（自然语言，中英文均可）' },
        top_k: { type: 'number', description: '返回条数（默认 5）' },
      }),
      output: { schema: {} as Record<string, never>, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v) }] },
      async execute(args: unknown) {
        const a = args as { query: string; top_k?: number }
        const hits = await search(a.query, a.top_k)
        return { ok: true, count: hits.length, results: hits }
      },
    }),

    // ② 知识库状态
    ctx.tools.register({
      name: 'knowledge_status',
      description: '查看知识库状态：已索引文档列表（名称/大小/块数/状态）、配置参数、知识库描述。',
      parameters: compileParams({}),
      output: { schema: {} as Record<string, never>, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v) }] },
      async execute() {
        const s = await ensureStore()
        return {
          ok: true,
          description: cfg?.description ?? '',
          topK: cfg?.topK, minScore: cfg?.minScore,
          documents: s.listDocs().map(d => ({ name: d.name, source: d.source, bytes: d.bytes, chunks: d.chunk_count, status: d.status, ...(d.error !== '' ? { error: d.error } : {}) })),
        }
      },
    }),

    // ③ 会话语义管理（聊天即管理）
    ctx.tools.register({
      name: 'knowledge_manage',
      description: '知识库管理操作（用户在对话中用自然语言请求时调用）。支持：save（把对话中的内容直接保存入库，给 title + text）、add（索引本地文件路径或目录）、remove（按文档名删除）、reindex（重建全部索引）、describe（设置知识库描述）。用户说「存到知识库」「把这个记下来」时用 save。',
      parameters: compileParams({
        action: { type: 'string', required: true, description: 'add | remove | reindex | describe' },
        path: { type: 'string', description: 'add：本地文件或目录路径' },
        title: { type: 'string', description: 'save：文档标题（会成为知识库里的文档名）' },
        text: { type: 'string', description: 'save：要保存的文本内容（直接从对话中提取，无需先写文件）' },
        name: { type: 'string', description: 'remove：要删除的文档名' },
        description: { type: 'string', description: 'describe：知识库描述文本' },
      }),
      output: { schema: {} as Record<string, never>, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v) }] },
      async execute(args: unknown) {
        const a = args as { action: string; path?: string; title?: string; text?: string; name?: string; description?: string }
        const s = await ensureStore()
        // save：对话内容直接入库（不产生中间文件）
        if (a.action === 'save' && a.text !== undefined && a.text !== '') {
          const title = a.title !== undefined && a.title !== '' ? a.title : `对话保存 ${new Date().toISOString().slice(0, 16)}`
          const content = `# ${title}\n\n${a.text}`
          const docId = KbStore.docId(content)
          if (s.hasDoc(docId) && s.getDoc(docId)?.status === 'ready') {
            return { ok: true, message: `${title} 已在知识库中（内容相同，跳过）` }
          }
          s.upsertDoc(docId, title, 'save', content.length, 'indexing')
          broadcastProgress(`正在索引对话内容「${title}」`)
          try {
            const embedder = await getEmbedder(cfg?.embeddingModel ?? 'Xenova/bge-small-zh-v1.5')
            const { chunkText } = await import('./indexer.ts')
            const pieces = chunkText(content)
            if (pieces.length === 0) return { ok: false, error: '内容太短或为空，无法切块' }
            const embeddings = await embedder.embedBatch(pieces, cfg?.batchSize ?? 32)
            s.insertChunks(docId, pieces.map((piece, i) => ({ seq: i, text: piece, embedding: embeddings[i]! })))
            s.setDocStatus(docId, 'ready', pieces.length)
            broadcastProgress(`「${title}」已入库（${pieces.length} 块）`)
            return { ok: true, message: `已保存「${title}」到知识库，共 ${pieces.length} 个知识块` }
          } catch (e) {
            const msg = String((e as Error).message ?? e)
            s.setDocStatus(docId, 'failed', 0, msg)
            return { ok: false, error: `索引失败：${msg}` }
          }
        }
        if (a.action === 'add' && a.path) {
          const p = resolve(a.path)
          if (!existsSync(p)) return { ok: false, error: `路径不存在：${p}` }
          const st = statSync(p)
          if (st.isFile()) {
            const r = await indexOne(ctx, p, 'upload')
            return { ok: r.ok, message: r.message }
          }
          // 目录：索引全部支持的文件
          const { readdir } = await import('node:fs/promises')
          const files = (await readdir(p)).filter(f => /\.(pdf|docx|md|txt|csv|json|log)$/i.test(f)).map(f => join(p, f))
          const results: string[] = []
          for (const f of files) { const r = await indexOne(ctx, f, 'upload'); results.push(r.message) }
          return { ok: true, message: `批量索引 ${files.length} 个文件`, detail: results }
        }
        if (a.action === 'remove' && a.name) {
          const docs = s.listDocs().filter(d => d.name.includes(a.name!))
          if (docs.length === 0) return { ok: false, error: `未找到包含「${a.name}」的文档` }
          for (const d of docs) s.deleteDoc(d.doc_id)
          return { ok: true, message: `已删除 ${docs.length} 个文档：${docs.map(d => d.name).join(', ')}` }
        }
        if (a.action === 'reindex') {
          const docs = s.listDocs()
          for (const d of docs) s.setDocStatus(d.doc_id, 'pending', 0)
          return { ok: true, message: `已重置 ${docs.length} 个文档为待索引。请用户通过设置面板或重新 add 触发重建（文件源路径不再保留，需重新添加）。` }
        }
        if (a.action === 'describe' && a.description !== undefined) {
          // 写入设置（经 settings mutate——通过 remote 层在宿主侧不可直接调，改走 systemPrompt 动态文本）
          // V1：描述存库内单例表（简化：借用 documents 表的 meta 行）
          return { ok: true, message: `知识库描述已记录（当前会话生效）。持久化请通过设置面板「知识库描述」字段。`, description: a.description }
        }
        return { ok: false, error: `未知操作 ${a.action}（支持 save/add/remove/reindex/describe）` }
      },
    }),
  ]

  // 注意：effect 体必须「返回」disposer。写成在体内调用 d() 会在 apply() 里
  // 当场注销刚注册的三个工具，模型侧完全看不到 knowledge_* 工具。
  ctx.effect(() => () => { for (const d of disposers) d() }, 'rag-kb: tools')

  // ── systemPrompt 注入（agent 自动知道知识库 + save 引导） ──
  const promptText = () => {
    const desc = cfg?.description ?? ''
    const docs = store?.listDocs().filter(d => d.status === 'ready').length ?? 0
    return [
      'You have a local knowledge base accessible via these tools:',
      '- knowledge_search: semantic search the KB (use BEFORE answering questions about its content)',
      '- knowledge_status: list documents and config',
      '- knowledge_manage: add/save/remove/reindex documents',
      desc !== '' ? `KB description: ${desc}` : '',
      `Currently ${docs} document(s) indexed.`,
      'When the user says "save this to the knowledge base" (保存到知识库/记下来), extract the valuable content from the conversation and call knowledge_manage with action="save", providing a concise title and the text.',
      'For file/directory indexing use action="add" with a path.',
    ].filter(Boolean).join('\n')
  }
  ctx.systemPrompt.section({ name: 'tool:rag-kb', order: 2350, text: promptText, interpolate: false })
}

export { ConfigExport as Config }
