import { generateText } from 'ai'
import { defaultModel } from '../agent/model'
import { ApiError } from '../lib/api-error'
import { parseRoadmapContent, type RoadmapContent, recomputeCurrentPhaseIndex } from './spec'
import { getRoadmap, updateRoadmapContent } from './store'

/** 建议的边界：先肯定具体做到的部分，再指一个改点，最后给下一次的动作 */
const FEEDBACK_PROMPT = [
  '你是一名练习教练。用户刚完成一次训练，请根据训练任务、判据和他的自述给出建议。',
  '要求：',
  '1. 先指出他这次确实做到了什么，引用他的自述，不要空泛。',
  '2. 指出一个最值得改的点。',
  '3. 给出下一次训练可以直接执行的一个动作。',
  '总共 2–4 句，不要重述整份计划，不要用「继续加油」这类空泛鼓励。',
].join('\n')

/**
 * 读取并校验一次训练；计划不存在 / 内容损坏 / 下标越界分别抛对应错误。
 */
function loadSession(
  row: Awaited<ReturnType<typeof getRoadmap>>,
  phaseIndex: number,
  sessionIndex: number,
): { content: RoadmapContent; session: RoadmapContent['phases'][number]['sessions'][number] } {
  if (!row) throw new ApiError('ROADMAP_NOT_FOUND', 'Roadmap not found.', 404)
  const content = parseRoadmapContent(row.content)
  if (!content) throw new ApiError('ROADMAP_CORRUPTED', 'Roadmap content is invalid.', 500)
  const session = content.phases[phaseIndex]?.sessions[sessionIndex]
  if (!session) throw new ApiError('SESSION_NOT_FOUND', 'Session not found.', 404)
  return { content, session }
}

/**
 * 完成某次训练：生成建议后把状态写回计划。
 *
 * AI 生成失败时不落库（用户可保留输入重试），避免出现「已完成但没有建议」的半成品。
 */
export async function completeSession(input: {
  roadmapId: string
  userId: string
  phaseIndex: number
  sessionIndex: number
  note: string
  signal?: AbortSignal
}): Promise<RoadmapContent> {
  const row = await getRoadmap(input.roadmapId, input.userId)
  const { content, session } = loadSession(row, input.phaseIndex, input.sessionIndex)
  if (session.status === 'done') {
    throw new ApiError('SESSION_ALREADY_DONE', 'Session already completed.', 409)
  }

  let feedback: string
  try {
    const result = await generateText({
      model: defaultModel,
      system: FEEDBACK_PROMPT,
      prompt: [
        `技能：${session.subskill}`,
        `本次任务：${session.task}`,
        `判据：${session.criteria}`,
        `产物：${session.product}`,
        `用户完成说明：${input.note}`,
      ].join('\n'),
      // 当前网关会返回不带 signature 的 thinking 块，Anthropic SDK 解析非流式响应时直接报错；
      // 这里显式关闭 thinking，官方 API 同样接受该选项
      providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
      abortSignal: input.signal,
    })
    feedback = result.text.trim()
    if (!feedback) throw new Error('empty feedback')
  } catch (err) {
    console.error('[roadmap] 建议生成失败:', err)
    throw new ApiError('FEEDBACK_FAILED', 'Failed to generate feedback.', 502)
  }

  session.status = 'done'
  session.completionNote = input.note
  session.feedback = feedback
  session.completedAt = new Date().toISOString()
  content.currentPhaseIndex = recomputeCurrentPhaseIndex(content)
  await updateRoadmapContent(input.roadmapId, content)
  return content
}

/**
 * 撤销一次完成记录：清掉完成状态与反馈，并把当前阶段退回第一个未完成的阶段。
 * 用于误点「完成这次」后无需重建整份计划。
 */
export async function uncompleteSession(input: {
  roadmapId: string
  userId: string
  phaseIndex: number
  sessionIndex: number
}): Promise<RoadmapContent> {
  const row = await getRoadmap(input.roadmapId, input.userId)
  const { content, session } = loadSession(row, input.phaseIndex, input.sessionIndex)
  if (session.status !== 'done') {
    throw new ApiError('SESSION_NOT_DONE', 'Session is not completed.', 409)
  }

  session.status = undefined
  session.completionNote = undefined
  session.feedback = undefined
  session.completedAt = undefined
  content.currentPhaseIndex = recomputeCurrentPhaseIndex(content)
  await updateRoadmapContent(input.roadmapId, content)
  return content
}
