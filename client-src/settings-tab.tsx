/**
 * 设置 → 插件 →「知识库」标签页：配置项 + 使用指引。
 * 复杂操作按设计走会话语义（对话里说「把 D:\docs 加入知识库」即可），
 * 面板只承载：检索参数、知识库描述、监视目录 + 操作提示。
 */
import { useCallback, useEffect, useState } from 'react'
import type { SettingsFace } from './index.tsx'

interface NamespaceView {
  ns: string
  value?: Record<string, unknown>
  user?: Record<string, unknown>
  revision?: number
}

interface FieldDef {
  key: string
  label: string
  type: 'string' | 'number'
  placeholder?: string
  hint?: string
}

const FIELDS: FieldDef[] = [
  { key: 'description', label: '知识库描述', type: 'string', placeholder: '如：公司产品手册、技术规范、常见问题解答', hint: 'agent 检索前会阅读这段描述，知道库里有什么' },
  { key: 'watchDir', label: '自动索引目录', type: 'string', placeholder: 'D:\\docs', hint: '放入此目录的文档自动监视索引（可选）' },
  { key: 'topK', label: '检索返回条数', type: 'number', hint: '默认 5' },
  { key: 'minScore', label: '相似度阈值', type: 'number', hint: '0~1，默认 0.3，过低噪音多' },
]

export function KbSettingsTab(props: { face: SettingsFace }): JSX.Element {
  const face = props.face
  const [ns, setNs] = useState<string | null>(null)
  const [view, setView] = useState<NamespaceView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const reload = useCallback(async () => {
    setError(null)
    if (face === undefined || typeof face.describe !== 'function') {
      setError('组件未收到设置读写面')
      return
    }
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('settings.describe 8 秒未响应')), 8000))
    let result: Awaited<ReturnType<typeof face.describe>>
    try { result = await Promise.race([face.describe(), timeout]) } catch (e) {
      setError(`读取设置失败：${String((e as Error).message)}`); return
    }
    if ('error' in result) { setError(result.error); return }
    const rows = (result.namespaces ?? []) as NamespaceView[]
    const hit = rows.find(row => row.ns === 'rag-kb')
    if (hit === undefined) { setError(`设置视图中未找到 rag-kb 命名空间（共 ${String(rows.length)} 个）`); return }
    setNs(hit.ns); setView(hit); setDraft(null)
  }, [face])

  useEffect(() => { void reload() }, [reload])

  const current = (view?.value ?? {}) as Record<string, unknown>
  const userLayer = (view?.user ?? {}) as Record<string, unknown>
  const shown = draft ?? current

  const edit = (key: string, value: unknown): void => {
    setMessage(null); setFailed(false)
    setDraft(prev => ({ ...(prev ?? { ...current }), [key]: value }))
  }

  const save = async (): Promise<void> => {
    if (draft === null || ns === null || view === undefined) return
    setSaving(true)
    try {
      const ops: Array<{ op: 'set'; path: readonly string[]; value: unknown }> = []
      for (const f of FIELDS) {
        const after = draft[f.key]
        if (after === undefined || after === '') continue
        // number 类型在保存时才转数字（编辑期间保留字符串避免小数点被吃）
        const value = f.type === 'number' ? Number(after) : after
        if (Number.isNaN(value as number)) continue
        if (JSON.stringify(value) === JSON.stringify(current[f.key])) continue
        ops.push({ op: 'set', path: [f.key], value })
      }
      if (ops.length > 0) {
        const result = await face.mutate(ns, ops, view.revision)
        if (!result.ok) throw new Error(result.error ?? '写入失败')
      }
      setDraft(null); setFailed(false)
      setMessage(ops.length > 0 ? '已保存，插件已按新配置自动重载' : '无更改')
      await reload()
    } catch (e) {
      setFailed(true); setMessage(`保存失败：${String((e as Error).message)}`)
    } finally { setSaving(false) }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 10px', font: 'inherit', boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px',
    background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
  }

  if (error !== null) {
    return (
      <div style={{ ...cardStyle, color: 'var(--dsw-alias-label-tertiary)' }}>
        知识库配置加载失败：{error}
        <button type="button" onClick={() => { void reload() }} style={{ ...btnStyle, marginLeft: '10px' }}>重试</button>
      </div>
    )
  }
  if (view === null) {
    return <div style={{ ...cardStyle, color: 'var(--dsw-alias-label-tertiary)' }}>知识库配置加载中…</div>
  }

  return (
    <div>
      <div style={cardStyle}>
        <strong style={{ fontSize: '14px' }}>知识库</strong>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '10px', marginTop: '12px' }}>
          {FIELDS.map((f) => {
            const overridden = Object.hasOwn(userLayer, f.key)
            return (
              <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>
                  {f.label}
                  {overridden && <span style={{ marginLeft: '6px', color: 'var(--dsw-alias-brand-primary)' }}>·已覆盖</span>}
                </span>
                <input
                  value={draft !== null && draft[f.key] !== undefined ? String(draft[f.key]) : String(shown[f.key] ?? '')}
                  placeholder={f.placeholder ?? ''}
                  onChange={(e) => {
                    // 编辑期间保留原始字符串（含 "0." 等中间态），保存时才转数字
                    edit(f.key, e.target.value)
                  }}
                  style={inputStyle}
                />
                {f.hint !== undefined && <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>{f.hint}</span>}
              </label>
            )
          })}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
            <button type="button" disabled={saving || draft === null} onClick={() => { void save() }}
              style={{
                padding: '6px 16px', borderRadius: '6px', font: 'inherit',
                border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)',
                color: 'var(--dsw-alias-label-primary-foreground)', cursor: draft === null ? 'default' : 'pointer',
                opacity: draft === null ? 0.6 : 1,
              }}>{saving ? '保存中…' : '保存'}</button>
            {draft !== null && (
              <button type="button" disabled={saving} onClick={() => { setDraft(null); setMessage(null); setFailed(false) }}
                style={{ padding: '6px 16px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', background: 'transparent', font: 'inherit', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' }}>放弃更改</button>
            )}
            {message !== null && <span style={{ fontSize: '12px', color: failed ? 'var(--dsw-alias-label-error)' : 'var(--dsw-alias-label-secondary)' }}>{message}</span>}
          </div>
        </div>
      </div>

      <div style={{ ...cardStyle, marginTop: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
        <strong style={{ fontSize: '13px' }}>💡 知识库管理：直接在对话里说</strong>
        <div style={{ marginTop: '8px', lineHeight: 1.8, fontSize: '13px' }}>
          <div>💬 「把 <code style={{ background: 'var(--dsw-alias-bg-layer-2)', padding: '1px 4px', borderRadius: '3px' }}>D:\docs</code> 目录加入知识库」</div>
          <div>💬 「知识库里有哪些文档？」</div>
          <div>💬 「删掉知识库里的旧版手册」</div>
          <div>💬 「根据知识库回答：报销流程是什么？」</div>
        </div>
        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>
          支持 pdf / docx / md / txt / csv / json；文件内容变化自动重新索引。
          首次使用会自动下载中文向量化模型（约 100MB，下载后完全离线）。
        </div>
      </div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '10px',
  padding: '14px 16px',
  background: 'var(--dsw-alias-bg-layer-3)',
  font: '13px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
  color: 'var(--dsw-alias-label-primary)',
}

const btnStyle: React.CSSProperties = {
  padding: '6px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px',
  background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
}
