/**
 * 浏览器半边：设置 → 插件 →「知识库」标签页。
 * V1 面板精简为配置项 + 文档只读列表 + SSE 进度横幅——
 * 复杂操作（增删文档/重建索引）按设计走「会话语义」（对话里用自然语言让 agent 调 knowledge_manage）。
 */
import { createElement as h, useEffect, useState } from 'react'
import { KbSettingsTab } from './settings-tab.tsx'

export const name = 'dsh-rag-kb'
export const inject = ['slots', 'locale', 'remote', 'remote.settings']

const NS = 'dsh-rag-kb'
const zh = { tab: '知识库' }
const en = { tab: 'Knowledge' }

export interface SettingsFace {
  describe(): Promise<{ namespaces: unknown[] } | { error: string }>
  mutate(ns: string, ops: ReadonlyArray<{ op: 'set' | 'unset'; path: readonly string[]; value?: unknown }>, revision?: number): Promise<{ ok: boolean; error?: string }>
}

export function apply(ctx: {
  slots: {
    inject: (slot: string, register: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: (props?: unknown) => unknown) => () => void
  }
  locale: { register(ns: string, dict: Record<string, Record<string, string>>): unknown }
  remote: { settings: SettingsFace }
  effect: (fn: () => unknown, label?: string) => () => void
}): void {
  ctx.effect(() => {
    try { ctx.locale.register(NS, { zh, en }) } catch { /* 已注册 */ }
    const t = (key: keyof typeof zh) => zh[key] ?? String(key)
    const face: SettingsFace = {
      describe: async () => {
        const response = await ctx.remote.settings.describe()
        return response.ok && response.value !== undefined
          ? { namespaces: response.value.namespaces }
          : { error: response.error?.message ?? 'settings.describe failed' }
      },
      mutate: async (ns, ops, revision) => {
        const response = await ctx.remote.settings.mutate(ns, ops, revision)
        return response.ok ? { ok: true } : { ok: false, error: response.error?.message ?? 'settings.mutate failed' }
      },
    }
    const offTab = ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'rag-kb',
      order: 50,
      label: () => t('tab'),
      locale: NS,
      inject: () => ({ face }),
    }, KbSettingsTab))
    return () => { offTab() }
  }, 'dsh-rag-kb: settings tab')
}
