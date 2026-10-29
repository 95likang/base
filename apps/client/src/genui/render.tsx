'use client'

import { isGenUIToolName, RENDERABLE_PART_STATES, validateRenderInput } from 'api/genui/spec'
import { GenUIErrorBoundary } from './error-boundary'
import { registry } from './registry'

/** UI 消息里 tool part 的最小形状（AI SDK 的联合类型在这里不需要细分） */
export interface RenderablePart {
  type: string
  toolCallId?: string
  state?: string
  input?: unknown
}

/** 生成式 UI 候选：只认 tool-render 前缀，其余工具 part 交给原有展示逻辑 */
export function isGenUIPart(part: { type: string }): part is RenderablePart {
  return part.type.startsWith('tool-render')
}

function GenUISkeleton() {
  return (
    <div
      role="status"
      className="h-24 w-full animate-pulse rounded-lg border border-dashed bg-gray-50"
      aria-label="正在生成图表"
    />
  )
}

function GenUIFailure({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      {name}：{detail}
    </div>
  )
}

/**
 * 一个 part 走完「校验 → 重建 → 渲染」。
 * 降级分四类：未注册（静默跳过）、形状/语义/状态异常（显式标注）、渲染异常（ErrorBoundary）。
 */
export function GenUIPart({ part }: { part: RenderablePart }) {
  const toolName = part.type.slice('tool-'.length)

  // 未注册 name：不做模糊匹配，屏幕上不显示（文档 8.3）
  if (!isGenUIToolName(toolName)) {
    console.warn('[genui] 未注册的组件，已跳过:', toolName)
    return null
  }

  if (part.state === 'output-error') {
    return <GenUIFailure name={toolName} detail="生成失败，请重试。" />
  }

  // 参数还在生成：骨架只用于「外框已建、零字段闭合」的阶段，不遮半截数字
  if (part.state === 'input-streaming') {
    return <GenUISkeleton />
  }

  // 既没有完整输入也不是错误状态（如历史数据缺 state）：不能永久转圈，按块降级
  if (!RENDERABLE_PART_STATES.has(part.state ?? '')) {
    return <GenUIFailure name={toolName} detail="数据状态异常，这张图未能显示。" />
  }

  const result = validateRenderInput(toolName, part.input)
  if (!result.ok) {
    // 认得出组件却画不出来 → 画出来可能被当成真实结果，必须显式标注
    return (
      <GenUIFailure
        name={toolName}
        detail={
          result.reason === 'semantic'
            ? '数据不完整，这张图容易引起误读，已停止渲染。'
            : '数据格式不合法，这张图未能显示。'
        }
      />
    )
  }

  const Component = registry[result.name]

  return (
    <div data-card-id={part.toolCallId}>
      <GenUIErrorBoundary cardId={part.toolCallId}>
        <Component {...result.data} />
      </GenUIErrorBoundary>
    </div>
  )
}
