'use client'

import { Component, type ReactNode } from 'react'

interface Props {
  cardId?: string
  children: ReactNode
}

interface State {
  hasError: boolean
}

/**
 * 会话级兜底：单个渲染器抛未捕获异常时只坏这一张卡，
 * 不能因为一张卡把整条消息甚至整页打白。
 */
export class GenUIErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[genui] 渲染异常，已降级为占位卡:', this.props.cardId, error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-500">
          这张卡片渲染失败，其余内容不受影响。
        </div>
      )
    }
    return this.props.children
  }
}
