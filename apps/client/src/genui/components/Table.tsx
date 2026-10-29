import type { TableData } from 'api/genui/spec'
import { useState } from 'react'

/** 明细列表：本地分页，pageSize 只控制每页行数，不改变数据事实 */
export function Table({ columns, rows, pageSize }: TableData) {
  const size = pageSize ?? 20
  const [page, setPage] = useState(0)
  const totalPages = Math.max(1, Math.ceil(rows.length / size))
  // 数据变短后旧页码可能越界，钳制后再切片，避免出现空白表格
  const currentPage = Math.min(page, totalPages - 1)
  const visible = rows.slice(currentPage * size, (currentPage + 1) * size)

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-white p-4 text-center text-xs text-gray-400">
        暂无数据
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs tabular-nums">
          <thead>
            <tr className="border-b text-gray-500">
              {columns.map((column) => (
                <th key={column} className="whitespace-nowrap px-2 py-1 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行没有稳定 id，同值行需索引区分
              <tr key={`${currentPage}:${i}`} className="border-b last:border-0">
                {row.map((cell, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 单元格按列顺序渲染
                  <td key={`${i}:${j}`} className="whitespace-nowrap px-2 py-1">
                    {String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 ? (
        <div className="mt-2 flex items-center justify-end gap-2 text-xs text-gray-500">
          <button
            type="button"
            onClick={() => setPage(Math.max(0, currentPage - 1))}
            disabled={currentPage === 0}
            className="rounded border px-2 py-0.5 disabled:opacity-40"
          >
            上一页
          </button>
          <span>
            {currentPage + 1} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage(Math.min(totalPages - 1, currentPage + 1))}
            disabled={currentPage >= totalPages - 1}
            className="rounded border px-2 py-0.5 disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      ) : null}
    </div>
  )
}
