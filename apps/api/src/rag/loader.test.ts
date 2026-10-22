import { describe, expect, it } from 'vitest'
import { loadDocument } from './loader'

const encode = (text: string) => new TextEncoder().encode(text)

describe('loadDocument', () => {
  it('读取 markdown 内容', async () => {
    await expect(loadDocument('a.md', encode('# 标题\n\n正文'))).resolves.toBe('# 标题\n\n正文')
  })

  it('读取纯文本内容', async () => {
    await expect(loadDocument('a.txt', encode('hello world'))).resolves.toBe('hello world')
  })

  it('空文件报错', async () => {
    await expect(loadDocument('a.md', encode('   '))).rejects.toThrow('文件内容为空')
  })

  it('不支持的扩展名报错', async () => {
    await expect(loadDocument('a.docx', encode('x'))).rejects.toThrow('不支持的文件类型')
  })
})
