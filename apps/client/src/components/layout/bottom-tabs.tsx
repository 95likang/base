'use client'

import { Map as MapIcon, MessageCircle, User } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  {
    href: '/plans',
    label: '计划',
    icon: MapIcon,
    isActive: (path: string) => path.startsWith('/plans'),
  },
  {
    href: '/chat',
    label: '对话',
    icon: MessageCircle,
    isActive: (path: string) => path.startsWith('/chat'),
  },
  { href: '/me', label: '我的', icon: User, isActive: (path: string) => path === '/me' },
]

/** H5 底部主导航：计划 / 对话 / 我的，登录页不展示。 */
export function BottomTabs() {
  const pathname = usePathname()
  if (pathname === '/login') return null

  return (
    <nav
      aria-label="主导航"
      className="shrink-0 border-t-2 border-foreground bg-card pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="grid grid-cols-3 px-2 py-1.5">
        {TABS.map(({ href, label, icon: Icon, isActive }) => {
          const active = isActive(pathname)
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-2xl py-1 text-[11px] font-bold transition-colors',
                  active ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex size-9 items-center justify-center rounded-full border-2 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
                    active
                      ? 'border-foreground bg-accent text-accent-foreground shadow-pop-sm'
                      : 'border-transparent',
                  )}
                >
                  <Icon className="size-5" strokeWidth={2.5} />
                </span>
                {label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
