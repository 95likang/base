import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { client, readError } from './lib/api'

const SKILLS_KEY = ['skills']
const API_BASE = import.meta.env.VITE_API_URL ?? ''

/**
 * Skills 管理页：上传 SKILL.md、启用/停用、删除。
 * 文件落在后端 .skills 目录；停用只加标记文件，不改写正文。
 */
export function SkillsPage() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const skillsQuery = useQuery({
    queryKey: SKILLS_KEY,
    queryFn: async () => {
      const res = await client.api.skills.$get()
      if (!res.ok) throw new Error(await readError(res))
      const data = await res.json()
      return data.skills
    },
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: SKILLS_KEY })

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('请选择 SKILL.md 文件')
      const form = new FormData()
      form.append('file', file)
      if (name.trim()) form.append('name', name.trim())
      const res = await fetch(`${API_BASE}/api/skills`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(await readError(res))
    },
    onSuccess: () => {
      setName('')
      setFile(null)
      refresh()
    },
  })

  const toggle = useMutation({
    mutationFn: async (skill: { name: string; enabled: boolean }) => {
      const res = await client.api.skills[':name'].$patch({
        param: { name: skill.name },
        json: { enabled: !skill.enabled },
      })
      if (!res.ok) throw new Error(await readError(res))
    },
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: async (skillName: string) => {
      const res = await client.api.skills[':name'].$delete({ param: { name: skillName } })
      if (!res.ok) throw new Error(await readError(res))
    },
    onSuccess: refresh,
  })

  const onUpload = (e: FormEvent) => {
    e.preventDefault()
    upload.mutate()
  }

  const skills = skillsQuery.data ?? []

  return (
    <main className="mx-auto max-w-4xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Skills</h1>
        <span className="text-sm text-gray-500">
          共 {skills.length} 个 · 启用 {skills.filter((s) => s.enabled).length} 个
        </span>
      </div>

      <section className="mb-8 rounded border border-gray-200 p-4">
        <h2 className="mb-3 font-semibold">上传技能</h2>
        <form onSubmit={onUpload} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-gray-600">
              SKILL.md（≤256KB；名称留空时取 frontmatter 的 name 或文件名）
            </span>
            <input
              type="file"
              accept=".md,text/markdown"
              disabled={upload.isPending}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
              placeholder="技能名称，如 code-review（同名会覆盖）"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
              disabled={upload.isPending || !file}
            >
              {upload.isPending ? '上传中…' : '上传'}
            </button>
          </div>
          {upload.isError && <p className="text-sm text-red-600">{upload.error.message}</p>}
        </form>
      </section>

      <section>
        <h2 className="mb-3 font-semibold">技能列表</h2>
        {skillsQuery.isPending && <p className="text-gray-500">加载中…</p>}
        {skillsQuery.isError && <p className="text-red-600">加载失败。</p>}
        {!skillsQuery.isPending && skills.length === 0 && (
          <p className="text-gray-500">还没有任何技能，先上传一份 SKILL.md。</p>
        )}
        {skills.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-600">
                <th className="py-2 pr-3">名称</th>
                <th className="py-2 pr-3">描述</th>
                <th className="py-2 pr-3">适用场景</th>
                <th className="py-2 pr-3">状态</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr key={skill.name} className="border-b border-gray-100">
                  <td className="py-2 pr-3 font-medium">{skill.name}</td>
                  <td className="py-2 pr-3 text-gray-600">{skill.description || '-'}</td>
                  <td className="py-2 pr-3 text-gray-600">{skill.whenToUse || '-'}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        skill.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {skill.enabled ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      className="mr-3 text-gray-700 underline disabled:opacity-50"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate(skill)}
                    >
                      {skill.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="text-red-600 underline disabled:opacity-50"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`删除技能 ${skill.name}？该操作不可恢复。`)) {
                          remove.mutate(skill.name)
                        }
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {toggle.isError && <p className="mt-2 text-sm text-red-600">{toggle.error.message}</p>}
        {remove.isError && <p className="mt-2 text-sm text-red-600">{remove.error.message}</p>}
      </section>
    </main>
  )
}
