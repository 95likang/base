'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { TABS } from './nav-items'

/** 桌面端左侧导航；移动端隐藏，由底部 Tab 承担同一职责。 */
export function SideNav() {
  const pathname = usePathname()
  if (pathname === '/login') return null

  return (
    <nav aria-label="主导航" className="hidden w-52 shrink-0 flex-col gap-2 lg:flex">
      <p className="mb-4 px-4 font-heading text-lg font-extrabold">Practice Coach</p>
      {TABS.map(({ href, label, icon: Icon, isActive }) => {
        const active = isActive(pathname)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-full border-2 px-4 py-3 text-sm font-bold transition-all duration-300',
              active
                ? 'border-foreground bg-accent text-accent-foreground shadow-pop-sm'
                : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-5" strokeWidth={2.5} />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
