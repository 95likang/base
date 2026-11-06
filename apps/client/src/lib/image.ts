import type { FileUIPart } from 'ai'

/** 图片长边降采样上限（Anthropic 推荐值），控制 data URL / DB / 每轮重放历史的体积 */
const MAX_IMAGE_EDGE = 1568

/** 单条消息图片数上限：data URL 随全量历史每轮重放并落库，需控制体积 */
export const MAX_IMAGES = 8

/** 解码前的体积上限：超大图解码成位图容易把手机端内存打满 */
export const MAX_IMAGE_FILE_SIZE = 15 * 1024 * 1024

/** File → FileUIPart：canvas 降采样 + 转 JPEG data URL（透明区垫白，GIF 取首帧） */
export async function fileToImagePart(file: File): Promise<FileUIPart> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return {
      type: 'file',
      mediaType: 'image/jpeg',
      filename: file.name,
      url: canvas.toDataURL('image/jpeg', 0.85),
    }
  } finally {
    bitmap.close()
  }
}
