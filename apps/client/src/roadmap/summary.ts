import type { RoadmapContent } from 'api/roadmap/spec'

/** 计划元信息行：日期区间、总周期、频率、单次时长；缺失项自动跳过 */
export function roadmapMetaLines(content: RoadmapContent): string[] {
  return [
    content.startDate && content.endDate ? `${content.startDate} 至 ${content.endDate}` : null,
    content.overallDuration ? `总周期 ${content.overallDuration}` : null,
    content.sessionsPerWeek ? `每周 ${content.sessionsPerWeek} 次` : null,
    content.sessionMinutes ? `每次 ${content.sessionMinutes} 分钟` : null,
  ].filter((text): text is string => Boolean(text))
}
