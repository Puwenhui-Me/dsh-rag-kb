/**
 * 宿主半边构建：src/main.ts → lib/plugin.mjs（ESM 单文件）。
 * 外部依赖不打包（@deepseek-ai/* 走 peer、transformers/unpdf/mammoth 走 dependencies）。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { plugin: 'src/main.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-home-paths',
    '@huggingface/transformers',
    'unpdf',
    'mammoth',
    'node:sqlite',
  ],
  outputOptions: { entryFileNames: 'plugin.mjs' },
})
