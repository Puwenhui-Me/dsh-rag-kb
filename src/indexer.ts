/**
 * 文档管线：解析（pdf/docx/md/txt）→ 切块（标题感知 + 固定长度 fallback）→ 批量向量化。
 * Embedding: transformers.js（GPU 加速优先，ONNX Runtime 自动检测 CUDA/WebGPU/CPU）。
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

export interface Chunk {
  seq: number
  text: string
  embedding: Float32Array
}

/** 中文友好的切块参数 */
const CHUNK_TOKENS = 400   // 约 400 token（≈600 汉字）/块
const OVERLAP_RATIO = 0.1  // 块间 10% 重叠

// ── 文档解析 ──────────────────────────────────────────────

export async function extractText(filePath: string): Promise<{ text: string; pages?: number }> {
  const ext = extname(filePath).toLowerCase()
  const buf = await readFile(filePath)
  if (ext === '.pdf') {
    const { extractText: pdfExtract, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    const { text, totalPages } = await pdfExtract(pdf, { mergePages: true })
    return { text, pages: totalPages }
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth')
    const { value: html } = await mammoth.extractRawText({ buffer: buf })
    return { text: html }
  }
  if (ext === '.md' || ext === '.txt' || ext === '.log' || ext === '.csv' || ext === '.json') {
    return { text: buf.toString('utf8') }
  }
  throw new Error(`不支持的文件类型 ${ext}（支持 pdf/docx/md/txt/csv/json）`)
}

// ── 切块 ──────────────────────────────────────────────

/** 标题感知切块：按标题/空行分段，过长段再固定长度切 */
export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (normalized === '') return []
  // 按标题（# 开头行）和空行分段
  const paragraphs = normalized.split(/\n(?=#{1,4} )|\n\n+/).map(p => p.trim()).filter(p => p !== '')
  const chunks: string[] = []
  let current = ''
  const maxChars = CHUNK_TOKENS * 1.5  // 中文 token≈1.5 字符
  const overlap = Math.floor(maxChars * OVERLAP_RATIO)
  for (const para of paragraphs) {
    if (current !== '' && (current + '\n' + para).length > maxChars) {
      chunks.push(current)
      current = overlap > 0 && current.length > overlap ? current.slice(-overlap) : ''
    }
    if (para.length > maxChars * 2) {
      // 超长段（如整篇无结构的 txt）：滑窗切
      if (current !== '') { chunks.push(current); current = '' }
      for (let i = 0; i < para.length; i += maxChars - overlap) {
        chunks.push(para.slice(i, i + maxChars))
      }
      continue
    }
    current = current === '' ? para : current + '\n' + para
  }
  if (current !== '') chunks.push(current)
  return chunks.filter(c => c.trim().length >= 10)  // 过滤过短碎片
}

// ── 向量化（GPU 索引 + CPU 查询双模式） ──
// DML(DirectML) GPU 批量索引快 4 倍；单条查询 GPU 有调度开销反而慢，
// 所以索引用 DML、检索用 CPU——两条 pipeline 按需惰性加载。

let gpuPipeline: Awaited<ReturnType<typeof loadPipeline>> | undefined
let cpuPipeline: Awaited<ReturnType<typeof loadPipeline>> | undefined

async function loadPipeline(modelName: string, device: 'cpu' | 'dml') {
  const { pipeline, env } = await import('@huggingface/transformers')
  const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths')
  env.cacheDir = dshHomePath('rag-kb', 'hf-cache')
  try {
    return await pipeline('feature-extraction', modelName, { device })
  } catch (e) {
    // DML 不可用（无 GPU/驱动不兼容）→ 回退 CPU
    if (device === 'dml') {
      console.log('[rag-kb] DML GPU 不可用，回退 CPU')
      return await pipeline('feature-extraction', modelName, { device: 'cpu' })
    }
    throw e
  }
}

export async function getEmbedder(modelName: string) {
  return {
    /** 单条向量化（检索查询用，CPU 单条比 GPU 快） */
    async embed(text: string): Promise<Float32Array> {
      cpuPipeline ??= await loadPipeline(modelName, 'cpu')
      const out = await cpuPipeline(text, { pooling: 'cls', normalize: true })
      return new Float32Array(out.data)
    },
    /** 批量向量化（索引用，GPU/DML 批量快 4 倍，不可用自动回退 CPU） */
    async embedBatch(texts: string[], batchSize: number): Promise<Float32Array[]> {
      gpuPipeline ??= await loadPipeline(modelName, 'dml')
      const results: Float32Array[] = []
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize)
        const out = await gpuPipeline(batch, { pooling: 'cls', normalize: true })
        const dim = out.data.length / batch.length
        for (let j = 0; j < batch.length; j++) {
          results.push(new Float32Array(out.data.slice(j * dim, (j + 1) * dim)))
        }
      }
      return results
    },
  }
}

// ── Reranker（bge-reranker-base，本地 CPU，惰性加载） ──

let rerankerPipeline: Awaited<ReturnType<typeof loadReranker>> | undefined

async function loadReranker() {
  const { pipeline, env } = await import('@huggingface/transformers')
  const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths')
  env.cacheDir = dshHomePath('rag-kb', 'hf-cache')
  return pipeline('text-classification', 'Xenova/bge-reranker-base')
}

/**
 * 对混合检索结果做 cross-encoder 精排。
 * 输入：query + 候选列表（含原文），输出按相关性重排序。
 */
export async function rerank(
  query: string,
  candidates: Array<{ text: string; [key: string]: unknown }>,
): Promise<Array<{ text: string; rerankScore: number; [key: string]: unknown }>> {
  rerankerPipeline ??= await loadReranker()
  const pairs = candidates.map(c => ({ text: query, text_pair: c.text }))
  const scores = await rerankerPipeline(pairs)
  const scored = candidates.map((c, i) => ({
    ...c,
    rerankScore: scores[i].score as number,
  }))
  scored.sort((a, b) => b.rerankScore - a.rerankScore)
  return scored
}

/** 完整索引管线：文件路径 → 切块+向量数组 */
export async function indexFile(
  filePath: string,
  embedder: Awaited<ReturnType<typeof getEmbedder>>,
  batchSize: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Chunk[]> {
  const { text } = await extractText(filePath)
  const pieces = chunkText(text)
  if (pieces.length === 0) return []
  const embeddings = await embedder.embedBatch(pieces, batchSize)
  if (onProgress) onProgress(pieces.length, pieces.length)
  return pieces.map((piece, i) => ({ seq: i, text: piece, embedding: embeddings[i]! }))
}
