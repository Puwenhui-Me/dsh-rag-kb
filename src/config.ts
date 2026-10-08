/**
 * RAG 知识库插件配置：schemastery schema，全字段 volatile（0.2.0 设置体系要求）。
 * 由 build 脚本编译打包为 lib/plugin.mjs。
 */

import z from '@deepseek-ai/schemastery'

export interface KbConfig {
  /** 本地目录路径——放入的文档自动监视索引（V2 目录模式的锚点，V1 也生效） */
  watchDir: string
  /** 检索返回 top-K */
  topK: number
  /** 相似度阈值（0~1，低于此值的 chunk 不返回） */
  minScore: number
  /** 知识库描述——agent 检索前阅读，知道库里有什么类型内容 */
  description: string
  /** embedding 模型（transformers.js 模型名） */
  embeddingModel: string
  /** 批量推理大小 */
  batchSize: number
}

/** 用户可见配置（设置面板「知识库」标签页） */
export const PublicConfig = z.object({
  watchDir: z.string().default('').description('本地文档目录（放入即自动索引）'),
  topK: z.number().default(5).description('检索返回条数（默认 5）'),
  minScore: z.number().default(0.3).description('相似度阈值（0~1，默认 0.3）'),
  description: z.string().default('').description('知识库描述（agent 检索前会阅读）'),
})

/** 完整配置（含高级项） */
export const Config = z.object({
  watchDir: z.string().default('').description('本地文档目录'),
  topK: z.number().default(5).description('检索返回条数'),
  minScore: z.number().default(0.3).description('相似度阈值'),
  description: z.string().default('').description('知识库描述'),
  embeddingModel: z.string().default('Xenova/bge-small-zh-v1.5').description('embedding 模型'),
  batchSize: z.number().default(32).description('批量推理大小'),
})

/** 全字段 volatile 注入（npm 版 schemastery 无 .volatile()，0.2.0 设置面板只收录 volatile 字段） */
for (const schema of [PublicConfig, Config]) {
  for (const child of Object.values(schema.dict ?? {})) {
    ;(child.meta as Record<string, unknown>).volatile = true
  }
}

/** 解析后的配置快照 */
export function resolveKbConfig(c: Partial<KbConfig> = {}): KbConfig {
  return {
    watchDir: c.watchDir ?? '',
    topK: Math.max(1, Math.min(50, c.topK ?? 5)),
    minScore: Math.max(0, Math.min(1, c.minScore ?? 0.3)),
    description: c.description ?? '',
    embeddingModel: c.embeddingModel ?? 'Xenova/bge-small-zh-v1.5',
    batchSize: Math.max(1, Math.min(128, c.batchSize ?? 32)),
  }
}
