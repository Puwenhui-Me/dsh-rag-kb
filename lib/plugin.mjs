import { createRequire } from "node:module";
import { existsSync, mkdirSync, statSync, watch } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region src/config.ts
/**
* RAG 知识库插件配置：schemastery schema，全字段 volatile（0.2.0 设置体系要求）。
* 由 build 脚本编译打包为 lib/plugin.mjs。
*/
/** 用户可见配置（设置面板「知识库」标签页） */
const PublicConfig = z.object({
	watchDir: z.string().default("").description("本地文档目录（放入即自动索引）"),
	topK: z.number().default(5).description("混合检索召回条数（默认 5）"),
	minScore: z.number().default(.3).description("相似度阈值（0~1，默认 0.3）"),
	description: z.string().default("").description("知识库描述（agent 检索前会阅读）"),
	enableReranker: z.boolean().default(false).description("启用 reranker 重排序（首次下载约 500MB 模型）"),
	rerankTopN: z.number().default(3).description("重排后返回条数（默认 3）")
});
/** 完整配置（含高级项） */
const Config = z.object({
	watchDir: z.string().default("").description("本地文档目录"),
	topK: z.number().default(5).description("混合检索召回条数"),
	minScore: z.number().default(.3).description("相似度阈值"),
	description: z.string().default("").description("知识库描述"),
	embeddingModel: z.string().default("Xenova/bge-small-zh-v1.5").description("embedding 模型"),
	batchSize: z.number().default(32).description("批量推理大小"),
	enableReranker: z.boolean().default(false).description("启用 reranker 重排序"),
	rerankTopN: z.number().default(3).description("重排后返回条数")
});
/** 全字段 volatile 注入（npm 版 schemastery 无 .volatile()，0.2.0 设置面板只收录 volatile 字段） */
for (const schema of [PublicConfig, Config]) for (const child of Object.values(schema.dict ?? {})) child.meta.volatile = true;
/** 解析后的配置快照 */
function resolveKbConfig(c = {}) {
	return {
		watchDir: c.watchDir ?? "",
		topK: Math.max(1, Math.min(50, c.topK ?? 5)),
		minScore: Math.max(0, Math.min(1, c.minScore ?? .3)),
		description: c.description ?? "",
		embeddingModel: c.embeddingModel ?? "Xenova/bge-small-zh-v1.5",
		batchSize: Math.max(1, Math.min(128, c.batchSize ?? 32)),
		enableReranker: c.enableReranker === true,
		rerankTopN: Math.max(1, Math.min(20, c.rerankTopN ?? 3))
	};
}
//#endregion
//#region src/store.ts
/**
* 向量索引库：node:sqlite（DSH 宿主先例模式）。
* 表结构：documents（文档元数据）+ chunks（切块 + 向量 blob）。
* 检索：向量全量载入内存 → 余弦相似 top-K（万级 chunk 毫秒级）。
*/
/** 库归属标识（PRAGMA application_id，抄宿主 session-query-sqlite 惯例） */
const APP_ID = 1380009794;
const SCHEMA_VERSION = 1;
var KbStore = class {
	db;
	vectors = [];
	vectorRows = [];
	loaded = false;
	constructor(dbPath) {
		const { DatabaseSync } = __require("node:sqlite");
		mkdirSync(join(dbPath, ".."), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode=WAL;");
		const appId = this.db.prepare("PRAGMA application_id").get().application_id;
		if (appId !== 0 && appId !== APP_ID) throw new Error(`rag-kb: ${dbPath} belongs to another application`);
		this.db.exec(`PRAGMA application_id = ${APP_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`);
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
    `);
	}
	/** 文档内容 hash 作 doc_id（同名不同内容=不同文档） */
	static docId(content) {
		return createHash("sha256").update(content).digest("hex").slice(0, 16);
	}
	hasDoc(docId) {
		return this.db.prepare("SELECT 1 FROM documents WHERE doc_id=?").get(docId) !== void 0;
	}
	upsertDoc(docId, name, source, bytes, status, error = "") {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		this.db.prepare(`
      INSERT INTO documents(doc_id, name, source, bytes, chunk_count, status, error, created_at, updated_at)
      VALUES(?,?,?,?,0,?,?,?,?)
      ON CONFLICT(doc_id) DO UPDATE SET name=excluded.name, bytes=excluded.bytes, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at
    `).run(docId, name, source, bytes, status, error, now, now);
		this.loaded = false;
	}
	setDocStatus(docId, status, chunkCount, error = "") {
		this.db.prepare("UPDATE documents SET status=?, chunk_count=?, error=?, updated_at=? WHERE doc_id=?").run(status, chunkCount, error, (/* @__PURE__ */ new Date()).toISOString(), docId);
		this.loaded = false;
	}
	deleteDoc(docId) {
		const ids = this.db.prepare("SELECT id FROM chunks WHERE doc_id=?").all(docId);
		const ftsDel = this.db.prepare("DELETE FROM chunk_fts WHERE rowid=?");
		for (const { id } of ids) ftsDel.run(id);
		this.db.prepare("DELETE FROM chunks WHERE doc_id=?").run(docId);
		this.db.prepare("DELETE FROM documents WHERE doc_id=?").run(docId);
		this.loaded = false;
	}
	listDocs() {
		return this.db.prepare("SELECT * FROM documents ORDER BY updated_at DESC").all();
	}
	getDoc(docId) {
		return this.db.prepare("SELECT * FROM documents WHERE doc_id=?").get(docId);
	}
	/** 批量写入切块+向量+FTS 索引（一个事务，失败回滚） */
	insertChunks(docId, chunks) {
		this.db.exec("BEGIN");
		try {
			this.db.prepare("DELETE FROM chunks WHERE doc_id=?").run(docId);
			const oldIds = this.db.prepare("SELECT id FROM chunks WHERE doc_id=?").all(docId);
			const ftsDel = this.db.prepare("DELETE FROM chunk_fts WHERE rowid=?");
			for (const { id } of oldIds) ftsDel.run(id);
			const stmt = this.db.prepare("INSERT INTO chunks(doc_id, seq, text, embedding) VALUES(?,?,?,?)");
			const ftsIns = this.db.prepare("INSERT INTO chunk_fts(rowid, text) VALUES(?,?)");
			for (const c of chunks) {
				const buf = Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength);
				const info = stmt.run(docId, c.seq, c.text, buf);
				const rowid = Number(info.lastInsertRowid);
				ftsIns.run(rowid, c.text);
			}
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
		this.loaded = false;
	}
	/** 惰性加载全部向量到内存（首次或写后失效） */
	ensureLoaded() {
		if (this.loaded) return;
		this.vectors = [];
		this.vectorRows = [];
		const rows = this.db.prepare("SELECT c.doc_id, c.seq, c.embedding FROM chunks c JOIN documents d ON d.doc_id=c.doc_id WHERE d.status='ready'").all();
		for (const row of rows) {
			this.vectors.push(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
			this.vectorRows.push({
				docId: row.doc_id,
				seq: row.seq
			});
		}
		this.loaded = true;
	}
	/** 混合检索：向量余弦 + FTS5 关键词双路合并（加权排序） */
	hybridSearch(queryVec, queryText, topK, minScore) {
		this.ensureLoaded();
		const vectorScores = /* @__PURE__ */ new Map();
		for (let i = 0; i < this.vectors.length; i++) {
			const v = this.vectors[i];
			let dot = 0;
			for (let j = 0; j < queryVec.length; j++) dot += queryVec[j] * v[j];
			if (dot >= minScore) {
				const key = `${this.vectorRows[i].docId}:${this.vectorRows[i].seq}`;
				vectorScores.set(key, {
					docId: this.vectorRows[i].docId,
					seq: this.vectorRows[i].seq,
					score: dot
				});
			}
		}
		const keywordScores = /* @__PURE__ */ new Map();
		if (queryText.trim().length >= 3) try {
			const safe = queryText.replace(/["'*()\-:]/g, " ").trim().slice(0, 50);
			if (safe.length >= 3) {
				const rows = this.db.prepare(`
            SELECT c.doc_id, c.seq, bm25(chunk_fts) AS rank
            FROM chunk_fts f
            JOIN chunks c ON c.id = f.rowid
            WHERE chunk_fts MATCH ?
            ORDER BY rank
            LIMIT ?
          `).all(`"${safe}"`, topK * 2);
				for (const row of rows) {
					const key = `${row.doc_id}:${row.seq}`;
					const kwScore = 1 / (1 + Math.abs(row.rank));
					keywordScores.set(key, {
						docId: row.doc_id,
						seq: row.seq,
						score: kwScore
					});
				}
			}
		} catch {}
		const merged = /* @__PURE__ */ new Map();
		for (const [key, v] of vectorScores) merged.set(key, {
			...v,
			score: v.score,
			via: keywordScores.has(key) ? "both" : "vector"
		});
		for (const [key, k] of keywordScores) if (merged.has(key)) {
			const existing = merged.get(key);
			existing.score = existing.score + k.score * .3;
			existing.via = "both";
		} else merged.set(key, {
			...k,
			via: "keyword"
		});
		return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK);
	}
	/** 向后兼容：纯向量检索（内部调 hybridSearch 空 queryText） */
	search(queryVec, topK, minScore) {
		return this.hybridSearch(queryVec, "", topK, minScore).map((r) => ({
			docId: r.docId,
			seq: r.seq,
			score: r.score
		}));
	}
	/** 按 doc_id + seq 取 chunk 原文 */
	chunkText(docId, seq) {
		return this.db.prepare("SELECT text FROM chunks WHERE doc_id=? AND seq=?").get(docId, seq)?.text ?? "";
	}
	close() {
		this.db.close();
	}
};
//#endregion
//#region src/indexer.ts
/**
* 文档管线：解析（pdf/docx/md/txt）→ 切块（标题感知 + 固定长度 fallback）→ 批量向量化。
* Embedding: transformers.js（GPU 加速优先，ONNX Runtime 自动检测 CUDA/WebGPU/CPU）。
*/
var indexer_exports = /* @__PURE__ */ __exportAll({
	chunkText: () => chunkText,
	extractText: () => extractText,
	getEmbedder: () => getEmbedder,
	indexFile: () => indexFile,
	rerank: () => rerank
});
/** 中文友好的切块参数 */
const CHUNK_TOKENS = 400;
const OVERLAP_RATIO = .1;
async function extractText(filePath) {
	const ext = extname(filePath).toLowerCase();
	const buf = await readFile(filePath);
	if (ext === ".pdf") {
		const { extractText: pdfExtract, getDocumentProxy } = await import("unpdf");
		const { text, totalPages } = await pdfExtract(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true });
		return {
			text,
			pages: totalPages
		};
	}
	if (ext === ".docx") {
		const { value: html } = await (await import("mammoth")).extractRawText({ buffer: buf });
		return { text: html };
	}
	if (ext === ".md" || ext === ".txt" || ext === ".log" || ext === ".csv" || ext === ".json") return { text: buf.toString("utf8") };
	throw new Error(`不支持的文件类型 ${ext}（支持 pdf/docx/md/txt/csv/json）`);
}
/** 标题感知切块：按标题/空行分段，过长段再固定长度切 */
function chunkText(text) {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	if (normalized === "") return [];
	const paragraphs = normalized.split(/\n(?=#{1,4} )|\n\n+/).map((p) => p.trim()).filter((p) => p !== "");
	const chunks = [];
	let current = "";
	const maxChars = CHUNK_TOKENS * 1.5;
	const overlap = Math.floor(maxChars * OVERLAP_RATIO);
	for (const para of paragraphs) {
		if (current !== "" && (current + "\n" + para).length > maxChars) {
			chunks.push(current);
			current = current.length > overlap ? current.slice(-60) : "";
		}
		if (para.length > maxChars * 2) {
			if (current !== "") {
				chunks.push(current);
				current = "";
			}
			for (let i = 0; i < para.length; i += 540) chunks.push(para.slice(i, i + maxChars));
			continue;
		}
		current = current === "" ? para : current + "\n" + para;
	}
	if (current !== "") chunks.push(current);
	return chunks.filter((c) => c.trim().length >= 10);
}
let gpuPipeline;
let cpuPipeline;
async function loadPipeline(modelName, device) {
	const { pipeline, env } = await import("@huggingface/transformers");
	const { dshHomePath } = await import("@deepseek-ai/dsh-home-paths");
	env.cacheDir = dshHomePath("rag-kb", "hf-cache");
	try {
		return await pipeline("feature-extraction", modelName, { device });
	} catch (e) {
		if (device === "dml") {
			console.log("[rag-kb] DML GPU 不可用，回退 CPU");
			return await pipeline("feature-extraction", modelName, { device: "cpu" });
		}
		throw e;
	}
}
async function getEmbedder(modelName) {
	return {
		/** 单条向量化（检索查询用，CPU 单条比 GPU 快） */
		async embed(text) {
			cpuPipeline ??= await loadPipeline(modelName, "cpu");
			const out = await cpuPipeline(text, {
				pooling: "cls",
				normalize: true
			});
			return new Float32Array(out.data);
		},
		/** 批量向量化（索引用，GPU/DML 批量快 4 倍，不可用自动回退 CPU） */
		async embedBatch(texts, batchSize) {
			gpuPipeline ??= await loadPipeline(modelName, "dml");
			const results = [];
			for (let i = 0; i < texts.length; i += batchSize) {
				const batch = texts.slice(i, i + batchSize);
				const out = await gpuPipeline(batch, {
					pooling: "cls",
					normalize: true
				});
				const dim = out.data.length / batch.length;
				for (let j = 0; j < batch.length; j++) results.push(new Float32Array(out.data.slice(j * dim, (j + 1) * dim)));
			}
			return results;
		}
	};
}
let rerankerPipeline;
async function loadReranker() {
	const { pipeline, env } = await import("@huggingface/transformers");
	const { dshHomePath } = await import("@deepseek-ai/dsh-home-paths");
	env.cacheDir = dshHomePath("rag-kb", "hf-cache");
	return pipeline("text-classification", "Xenova/bge-reranker-base");
}
/**
* 对混合检索结果做 cross-encoder 精排。
* 输入：query + 候选列表（含原文），输出按相关性重排序。
*/
async function rerank(query, candidates) {
	rerankerPipeline ??= await loadReranker();
	const pairs = candidates.map((c) => ({
		text: query,
		text_pair: c.text
	}));
	const scores = await rerankerPipeline(pairs);
	const scored = candidates.map((c, i) => ({
		...c,
		rerankScore: scores[i].score
	}));
	scored.sort((a, b) => b.rerankScore - a.rerankScore);
	return scored;
}
/** 完整索引管线：文件路径 → 切块+向量数组 */
async function indexFile(filePath, embedder, batchSize, onProgress) {
	const { text } = await extractText(filePath);
	const pieces = chunkText(text);
	if (pieces.length === 0) return [];
	const embeddings = await embedder.embedBatch(pieces, batchSize);
	if (onProgress) onProgress(pieces.length, pieces.length);
	return pieces.map((piece, i) => ({
		seq: i,
		text: piece,
		embedding: embeddings[i]
	}));
}
//#endregion
//#region src/plugin.ts
/**
* DSH RAG 知识库插件宿主半边入口。
* - 模型工具：knowledge_search / knowledge_status / knowledge_manage（会话语义管理）
* - systemPrompt 注入：agent 自动知道知识库
* - SSE 通道：索引进度推送（浏览器面板用）
* - 目录监视：watchDir 下的文档自动索引（V2 能力，V1 已生效）
*/
const name = "rag-kb";
const inject = [
	"tools",
	"systemPrompt",
	"settings"
];
let store;
let cfg;
const progressListeners = /* @__PURE__ */ new Set();
function broadcastProgress(msg) {
	for (const write of progressListeners) try {
		write(`event: progress\ndata: ${JSON.stringify(msg)}\n\n`);
	} catch {}
}
async function ensureStore() {
	if (store !== void 0) return store;
	const { dshHomePath } = await import("@deepseek-ai/dsh-home-paths");
	store = new KbStore(dshHomePath("rag-kb", "index.db"));
	return store;
}
/** 索引一个文件路径（upload 或 watch 共用） */
async function indexOne(ctx, filePath, source) {
	const s = await ensureStore();
	const name = basename(filePath);
	const bytes = statSync(filePath).size;
	const content = await (await import("node:fs/promises")).readFile(filePath);
	const docId = KbStore.docId(content);
	if (s.hasDoc(docId) && s.getDoc(docId)?.status === "ready") return {
		ok: true,
		message: `${name} 已索引（内容未变化，跳过）`
	};
	s.upsertDoc(docId, name, source, bytes, "indexing");
	broadcastProgress(`正在索引 ${name}`);
	try {
		const chunks = await indexFile(filePath, await getEmbedder(cfg?.embeddingModel ?? "Xenova/bge-small-zh-v1.5"), cfg?.batchSize ?? 32);
		s.insertChunks(docId, chunks.map((c) => ({
			seq: c.seq,
			text: c.text,
			embedding: c.embedding
		})));
		s.setDocStatus(docId, "ready", chunks.length);
		broadcastProgress(`${name} 索引完成（${chunks.length} 块）`);
		return {
			ok: true,
			message: `${name} 索引完成，共 ${chunks.length} 个知识块`
		};
	} catch (e) {
		const msg = String(e.message ?? e);
		s.setDocStatus(docId, "failed", 0, msg);
		broadcastProgress(`${name} 索引失败：${msg}`);
		return {
			ok: false,
			message: `${name} 索引失败：${msg}`
		};
	}
}
/** 混合语义检索（向量+关键词）+ 可选 reranker 精排 + 引用元数据 */
async function search(query, topK) {
	const s = await ensureStore();
	const queryVec = await (await getEmbedder(cfg?.embeddingModel ?? "Xenova/bge-small-zh-v1.5")).embed(query);
	const effectiveTopK = topK ?? cfg?.topK ?? 5;
	const recallK = cfg?.enableReranker === true ? effectiveTopK * 3 : effectiveTopK;
	let results = s.hybridSearch(queryVec, query, recallK, cfg?.minScore ?? .3).map((h) => {
		const docName = s.getDoc(h.docId)?.name ?? h.docId;
		const fullText = s.chunkText(h.docId, h.seq);
		return {
			docId: h.docId,
			doc: docName,
			seq: h.seq,
			score: Number(h.score.toFixed(3)),
			via: h.via,
			text: fullText,
			citation: `${docName} 第${h.seq + 1}段`,
			position: `文档「${docName}」第 ${h.seq + 1} 段`
		};
	});
	if (cfg?.enableReranker === true && results.length > 0) try {
		const reranked = await rerank(query, results);
		const topN = cfg?.rerankTopN ?? 3;
		results = reranked.slice(0, topN).map((r) => ({
			...r,
			text: r.text.slice(0, 800),
			rerankScore: Number(r.rerankScore.toFixed(4))
		}));
	} catch (e) {
		console.warn("[rag-kb] reranker 失败，使用混合检索结果:", String(e.message ?? e));
		results = results.slice(0, effectiveTopK).map((r) => ({
			...r,
			text: r.text.slice(0, 800)
		}));
	}
	else results = results.slice(0, effectiveTopK).map((r) => ({
		...r,
		text: r.text.slice(0, 800)
	}));
	return results;
}
function apply(ctx, config = {}) {
	const unwrap = (v) => v !== null && typeof v === "object" && "get" in v ? v.get() : v;
	const raw = {};
	for (const [k, v] of Object.entries(config)) raw[k] = unwrap(v);
	cfg = resolveKbConfig(raw);
	ctx.inject(["webServer"], (hostCtx) => {
		hostCtx.webServer.register({
			kind: "exact",
			path: "/rag-kb/progress",
			handler: (req, res) => {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-store",
					connection: "keep-alive"
				});
				res.write("retry: 3000\n\n");
				const write = (chunk) => res.write(chunk);
				progressListeners.add(write);
				const heartbeat = setInterval(() => {
					try {
						res.write(": ping\n\n");
					} catch {}
				}, 25e3);
				req.on("close", () => {
					clearInterval(heartbeat);
					progressListeners.delete(write);
				});
			}
		});
	});
	if (cfg.watchDir !== "" && existsSync(cfg.watchDir)) {
		const dir = resolve(cfg.watchDir);
		try {
			const watcher = watch(dir, { persistent: false }, (_ev, filename) => {
				if (filename === null || filename === void 0) return;
				const fname = String(filename);
				if (!/\.(pdf|docx|md|txt|csv|json|log)$/i.test(fname)) return;
				const f = join(dir, fname);
				setTimeout(() => {
					if (existsSync(f)) indexOne(ctx, f, "watch");
				}, 2e3);
			});
			ctx.effect(() => {
				watcher.close();
			}, "rag-kb: dir watcher");
		} catch (e) {
			console.warn(`[rag-kb] 目录监视失败 ${dir}: ${String(e.message)}`);
		}
	}
	const compileParams = (spec) => {
		const properties = {};
		const required = [];
		for (const [key, def] of Object.entries(spec)) {
			const { required: req, ...rest } = def;
			properties[key] = rest;
			if (req === true) required.push(key);
		}
		return {
			type: "object",
			properties,
			...required.length > 0 ? { required } : {}
		};
	};
	const disposers = [
		ctx.tools.register({
			name: "knowledge_search",
			description: "在本地知识库中混合检索（语义向量 + 关键词）。返回最相关的知识块，每条带 citation 引用标注。回答知识库相关问题时：先检索 → 组织回答 → 在答案中标注来源 citation。query 支持自然语言和精确关键词（错误码/型号/人名等）。",
			parameters: compileParams({
				query: {
					type: "string",
					required: true,
					description: "检索问题（自然语言或精确关键词）"
				},
				top_k: {
					type: "number",
					description: "返回条数（默认 5）"
				}
			}),
			output: {
				schema: {},
				render: (_a, v) => [{
					type: "text",
					text: JSON.stringify(v)
				}]
			},
			async execute(args) {
				const a = args;
				const hits = await search(a.query, a.top_k);
				return {
					ok: true,
					count: hits.length,
					results: hits
				};
			}
		}),
		ctx.tools.register({
			name: "knowledge_status",
			description: "查看知识库状态：已索引文档列表（名称/大小/块数/状态）、配置参数、知识库描述。",
			parameters: compileParams({}),
			output: {
				schema: {},
				render: (_a, v) => [{
					type: "text",
					text: JSON.stringify(v)
				}]
			},
			async execute() {
				const s = await ensureStore();
				return {
					ok: true,
					description: cfg?.description ?? "",
					topK: cfg?.topK,
					minScore: cfg?.minScore,
					documents: s.listDocs().map((d) => ({
						name: d.name,
						source: d.source,
						bytes: d.bytes,
						chunks: d.chunk_count,
						status: d.status,
						...d.error !== "" ? { error: d.error } : {}
					}))
				};
			}
		}),
		ctx.tools.register({
			name: "knowledge_manage",
			description: "知识库管理操作（用户在对话中用自然语言请求时调用）。支持：save（把对话中的内容直接保存入库，给 title + text）、add（索引本地文件路径或目录）、remove（按文档名删除）、reindex（重建全部索引）、describe（设置知识库描述）。用户说「存到知识库」「把这个记下来」时用 save。",
			parameters: compileParams({
				action: {
					type: "string",
					required: true,
					description: "add | remove | reindex | describe"
				},
				path: {
					type: "string",
					description: "add：本地文件或目录路径"
				},
				title: {
					type: "string",
					description: "save：文档标题（会成为知识库里的文档名）"
				},
				text: {
					type: "string",
					description: "save：要保存的文本内容（直接从对话中提取，无需先写文件）"
				},
				name: {
					type: "string",
					description: "remove：要删除的文档名"
				},
				description: {
					type: "string",
					description: "describe：知识库描述文本"
				}
			}),
			output: {
				schema: {},
				render: (_a, v) => [{
					type: "text",
					text: JSON.stringify(v)
				}]
			},
			async execute(args) {
				const a = args;
				const s = await ensureStore();
				if (a.action === "save" && a.text !== void 0 && a.text !== "") {
					const title = a.title !== void 0 && a.title !== "" ? a.title : `对话保存 ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 16)}`;
					const content = `# ${title}\n\n${a.text}`;
					const docId = KbStore.docId(content);
					if (s.hasDoc(docId) && s.getDoc(docId)?.status === "ready") return {
						ok: true,
						message: `${title} 已在知识库中（内容相同，跳过）`
					};
					s.upsertDoc(docId, title, "save", content.length, "indexing");
					broadcastProgress(`正在索引对话内容「${title}」`);
					try {
						const embedder = await getEmbedder(cfg?.embeddingModel ?? "Xenova/bge-small-zh-v1.5");
						const { chunkText } = await Promise.resolve().then(() => indexer_exports);
						const pieces = chunkText(content);
						if (pieces.length === 0) return {
							ok: false,
							error: "内容太短或为空，无法切块"
						};
						const embeddings = await embedder.embedBatch(pieces, cfg?.batchSize ?? 32);
						s.insertChunks(docId, pieces.map((piece, i) => ({
							seq: i,
							text: piece,
							embedding: embeddings[i]
						})));
						s.setDocStatus(docId, "ready", pieces.length);
						broadcastProgress(`「${title}」已入库（${pieces.length} 块）`);
						return {
							ok: true,
							message: `已保存「${title}」到知识库，共 ${pieces.length} 个知识块`
						};
					} catch (e) {
						const msg = String(e.message ?? e);
						s.setDocStatus(docId, "failed", 0, msg);
						return {
							ok: false,
							error: `索引失败：${msg}`
						};
					}
				}
				if (a.action === "add" && a.path) {
					const p = resolve(a.path);
					if (!existsSync(p)) return {
						ok: false,
						error: `路径不存在：${p}`
					};
					if (statSync(p).isFile()) {
						const r = await indexOne(ctx, p, "upload");
						return {
							ok: r.ok,
							message: r.message
						};
					}
					const { readdir } = await import("node:fs/promises");
					const files = (await readdir(p)).filter((f) => /\.(pdf|docx|md|txt|csv|json|log)$/i.test(f)).map((f) => join(p, f));
					const results = [];
					for (const f of files) {
						const r = await indexOne(ctx, f, "upload");
						results.push(r.message);
					}
					return {
						ok: true,
						message: `批量索引 ${files.length} 个文件`,
						detail: results
					};
				}
				if (a.action === "remove" && a.name) {
					const docs = s.listDocs().filter((d) => d.name.includes(a.name));
					if (docs.length === 0) return {
						ok: false,
						error: `未找到包含「${a.name}」的文档`
					};
					for (const d of docs) s.deleteDoc(d.doc_id);
					return {
						ok: true,
						message: `已删除 ${docs.length} 个文档：${docs.map((d) => d.name).join(", ")}`
					};
				}
				if (a.action === "reindex") {
					const docs = s.listDocs();
					for (const d of docs) s.setDocStatus(d.doc_id, "pending", 0);
					return {
						ok: true,
						message: `已重置 ${docs.length} 个文档为待索引。请用户通过设置面板或重新 add 触发重建（文件源路径不再保留，需重新添加）。`
					};
				}
				if (a.action === "describe" && a.description !== void 0) return {
					ok: true,
					message: `知识库描述已记录（当前会话生效）。持久化请通过设置面板「知识库描述」字段。`,
					description: a.description
				};
				return {
					ok: false,
					error: `未知操作 ${a.action}（支持 save/add/remove/reindex/describe）`
				};
			}
		})
	];
	ctx.effect(() => () => {
		for (const d of disposers) d();
	}, "rag-kb: tools");
	const promptText = () => {
		const desc = cfg?.description ?? "";
		const docs = store?.listDocs().filter((d) => d.status === "ready").length ?? 0;
		return [
			"You have a local knowledge base accessible via these tools:",
			"- knowledge_search: hybrid search (semantic + keyword). Use BEFORE answering questions about KB content.",
			"- knowledge_status: list documents and config",
			"- knowledge_manage: add/save/remove/reindex documents",
			"IMPORTANT: When the user says 搜一下/查一下/搜索, FIRST try knowledge_search on the local KB. Only do a web search if KB has no relevant results AND the topic is clearly not about local documents. Do NOT search both simultaneously — this confuses the answer.",
			desc !== "" ? `KB description: ${desc}` : "",
			`Currently ${docs} document(s) indexed.`,
			"CITATION STYLE (footnote format): In the body of your answer, mark sources with superscript numbers like ¹ ² ³ (Unicode superscripts). At the END, add a \"参考来源\" section. IMPORTANT: MERGE citations from the same document into ONE entry — e.g. if citing 文档A 第1段/第2段/第3段, list as \"1. 文档A 第1-3段\" (not 3 separate lines). Only list each document once with all its paragraph numbers combined. Keep the answer body clean.",
			"When the user says \"save this to the knowledge base\" (保存到知识库/记下来), extract the valuable content from the conversation and call knowledge_manage with action=\"save\", providing a concise title and the text.",
			"For file/directory indexing use action=\"add\" with a path."
		].filter(Boolean).join("\n");
	};
	ctx.systemPrompt.section({
		name: "tool:rag-kb",
		order: 2350,
		text: promptText,
		interpolate: false
	});
}
//#endregion
export { Config, KbStore, apply, chunkText, extractText, getEmbedder, indexFile, inject, name, rerank, resolveKbConfig };

//# sourceMappingURL=plugin.mjs.map