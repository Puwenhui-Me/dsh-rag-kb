/**
 * 向量索引库：node:sqlite（DSH 宿主先例模式）。
 * 表结构：documents（文档元数据）+ chunks（切块 + 向量 blob）。
 * 检索：向量全量载入内存 → 余弦相似 top-K（万级 chunk 毫秒级）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

/** 库归属标识（PRAGMA application_id，抄宿主 session-query-sqlite 惯例） */
const APP_ID = 0x52414742 // 'RAGB'
const SCHEMA_VERSION = 1

export interface DocumentRow {
  doc_id: string
  name: string
  source: 'upload' | 'watch'
  bytes: number
  chunk_count: number
  status: 'pending' | 'indexing' | 'ready' | 'failed'
  error: string
  created_at: string
  updated_at: string
}

export interface SearchResult {
  doc_name: string
  chunk_seq: number
  text: string
  score: number
}

export class KbStore {
  private db: DatabaseSyncType
  private vectors: Float32Array[] = []
  private vectorRows: Array<{ docId: string; seq: number }> = []
  private loaded = false

  constructor(dbPath: string) {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    mkdirSync(join(dbPath, '..'), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL;')
    const appId = (this.db.prepare('PRAGMA application_id').get() as { application_id?: number }).application_id
    if (appId !== 0 && appId !== APP_ID) throw new Error(`rag-kb: ${dbPath} belongs to another application`)
    this.db.exec(`PRAGMA application_id = ${APP_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents(
        doc_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'upload',
        bytes INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS chunks(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        text,
        tokenize='trigram'
      );
    `)
  }

  /** 文档内容 hash 作 doc_id（同名不同内容=不同文档） */
  static docId(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  hasDoc(docId: string): boolean {
    return this.db.prepare('SELECT 1 FROM documents WHERE doc_id=?').get(docId) !== undefined
  }

  upsertDoc(docId: string, name: string, source: 'upload' | 'watch', bytes: number, status: DocumentRow['status'], error = ''): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO documents(doc_id, name, source, bytes, chunk_count, status, error, created_at, updated_at)
      VALUES(?,?,?,?,0,?,?,?,?)
      ON CONFLICT(doc_id) DO UPDATE SET name=excluded.name, bytes=excluded.bytes, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at
    `).run(docId, name, source, bytes, status, error, now, now)
    this.loaded = false
  }

  setDocStatus(docId: string, status: DocumentRow['status'], chunkCount: number, error = ''): void {
    this.db.prepare('UPDATE documents SET status=?, chunk_count=?, error=?, updated_at=? WHERE doc_id=?')
      .run(status, chunkCount, error, new Date().toISOString(), docId)
    this.loaded = false
  }

  deleteDoc(docId: string): void {
    // 先删 FTS 行（需要 chunks.id 对齐的 rowid）
    const ids = this.db.prepare('SELECT id FROM chunks WHERE doc_id=?').all(docId) as Array<{ id: number }>
    const ftsDel = this.db.prepare('DELETE FROM chunk_fts WHERE rowid=?')
    for (const { id } of ids) ftsDel.run(id)
    this.db.prepare('DELETE FROM chunks WHERE doc_id=?').run(docId)
    this.db.prepare('DELETE FROM documents WHERE doc_id=?').run(docId)
    this.loaded = false
  }

  listDocs(): DocumentRow[] {
    return this.db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all() as DocumentRow[]
  }

  getDoc(docId: string): DocumentRow | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE doc_id=?').get(docId) as DocumentRow | undefined
  }

  /** 批量写入切块+向量+FTS 索引（一个事务，失败回滚） */
  insertChunks(docId: string, chunks: Array<{ seq: number; text: string; embedding: Float32Array }>): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM chunks WHERE doc_id=?').run(docId)
      // FTS 行以 chunks.id 的 rowid 对齐——先删旧 FTS 行再插新的
      const oldIds = this.db.prepare('SELECT id FROM chunks WHERE doc_id=?').all(docId) as Array<{ id: number }>
      const ftsDel = this.db.prepare('DELETE FROM chunk_fts WHERE rowid=?')
      for (const { id } of oldIds) ftsDel.run(id)
      const stmt = this.db.prepare('INSERT INTO chunks(doc_id, seq, text, embedding) VALUES(?,?,?,?)')
      const ftsIns = this.db.prepare('INSERT INTO chunk_fts(rowid, text) VALUES(?,?)')
      for (const c of chunks) {
        const buf = Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength)
        const info = stmt.run(docId, c.seq, c.text, buf) as { lastInsertRowid: number | bigint }
        const rowid = Number(info.lastInsertRowid)
        ftsIns.run(rowid, c.text)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    this.loaded = false
  }

  /** 惰性加载全部向量到内存（首次或写后失效） */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.vectors = []
    this.vectorRows = []
    const rows = this.db.prepare('SELECT c.doc_id, c.seq, c.embedding FROM chunks c JOIN documents d ON d.doc_id=c.doc_id WHERE d.status=\'ready\'').all() as Array<{ doc_id: string; seq: number; embedding: Buffer }>
    for (const row of rows) {
      this.vectors.push(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4))
      this.vectorRows.push({ docId: row.doc_id, seq: row.seq })
    }
    this.loaded = true
  }

  /** 混合检索：向量余弦 + FTS5 关键词双路合并（加权排序） */
  hybridSearch(
    queryVec: Float32Array,
    queryText: string,
    topK: number,
    minScore: number,
  ): Array<{ docId: string; seq: number; score: number; via: 'vector' | 'keyword' | 'both' }> {
    this.ensureLoaded()
    // 路1：向量余弦
    const vectorScores = new Map<string, { docId: string; seq: number; score: number }>()
    for (let i = 0; i < this.vectors.length; i++) {
      const v = this.vectors[i]!
      let dot = 0
      for (let j = 0; j < queryVec.length; j++) dot += queryVec[j]! * v[j]!
      if (dot >= minScore) {
        const key = `${this.vectorRows[i]!.docId}:${this.vectorRows[i]!.seq}`
        vectorScores.set(key, { docId: this.vectorRows[i]!.docId, seq: this.vectorRows[i]!.seq, score: dot })
      }
    }
    // 路2：FTS5 trigram 关键词
    const keywordScores = new Map<string, { docId: string; seq: number; score: number }>()
    if (queryText.trim().length >= 3) {
      try {
        // trigram 要求连续 3+ 字符——把 query 清理后整段做 phrase 搜索
        // 中英混合 query 截取前 50 字符（避免过长 FTS 查询慢）
        const safe = queryText.replace(/["'*()\-:]/g, ' ').trim().slice(0, 50)
        if (safe.length >= 3) {
          const rows = this.db.prepare(`
            SELECT c.doc_id, c.seq, bm25(chunk_fts) AS rank
            FROM chunk_fts f
            JOIN chunks c ON c.id = f.rowid
            WHERE chunk_fts MATCH ?
            ORDER BY rank
            LIMIT ?
          `).all(`"${safe}"`, topK * 2) as Array<{ doc_id: string; seq: number; rank: number }>
          for (const row of rows) {
            const key = `${row.doc_id}:${row.seq}`
            const kwScore = 1 / (1 + Math.abs(row.rank))
            keywordScores.set(key, { docId: row.doc_id, seq: row.seq, score: kwScore })
          }
        }
      } catch { /* FTS 查询出错不影响向量路 */ }
    }
    // 合并双路：同一 chunk 两路都命中 = 强信号，加权提分
    const merged = new Map<string, { docId: string; seq: number; score: number; via: 'vector' | 'keyword' | 'both' }>()
    for (const [key, v] of vectorScores) {
      merged.set(key, { ...v, score: v.score, via: keywordScores.has(key) ? 'both' : 'vector' })
    }
    for (const [key, k] of keywordScores) {
      if (merged.has(key)) {
        // 双路命中：向量分 + 关键词分 × 0.3 加成（关键词是辅助信号）
        const existing = merged.get(key)!
        existing.score = existing.score + k.score * 0.3
        existing.via = 'both'
      } else {
        merged.set(key, { ...k, via: 'keyword' })
      }
    }
    const results = [...merged.values()].sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  /** 向后兼容：纯向量检索（内部调 hybridSearch 空 queryText） */
  search(queryVec: Float32Array, topK: number, minScore: number): Array<{ docId: string; seq: number; score: number }> {
    const results = this.hybridSearch(queryVec, '', topK, minScore)
    return results.map(r => ({ docId: r.docId, seq: r.seq, score: r.score }))
  }

  /** 按 doc_id + seq 取 chunk 原文 */
  chunkText(docId: string, seq: number): string {
    const row = this.db.prepare('SELECT text FROM chunks WHERE doc_id=? AND seq=?').get(docId, seq) as { text: string } | undefined
    return row?.text ?? ''
  }

  close(): void {
    this.db.close()
  }
}
