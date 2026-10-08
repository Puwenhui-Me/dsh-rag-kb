/**
 * 宿主半边打包入口（tsdown 编译为 lib/plugin.mjs）。
 */

export { name, inject, apply } from './plugin.ts'
export { Config } from './config.ts'
export { KbStore } from './store.ts'
export { chunkText, extractText, getEmbedder, indexFile, rerank } from './indexer.ts'
export { resolveKbConfig } from './config.ts'
export type { KbConfig } from './config.ts'
