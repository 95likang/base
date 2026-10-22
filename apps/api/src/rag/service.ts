import { createEmbedderFromEnv } from './embedder'
import { VectorStore } from './store'

// 本模块在导入期读取 DASHSCOPE_API_KEY，显式加载 .env，不依赖其他模块的副作用顺序
process.loadEnvFile?.()

/**
 * 知识库单例：agent 工具与 /api/rag 管理路由共用同一份内存索引，
 * 否则管理页上传的文档在对话里搜不到（直到进程重启重新从 DB 加载）。
 */
export const ragEmbedder = createEmbedderFromEnv()
export const ragStore = new VectorStore(ragEmbedder.name)
