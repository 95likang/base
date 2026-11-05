import { Map as MapIcon, MessageCircle, User } from 'lucide-react'

/** 移动端底部导航与桌面端侧栏共用同一份导航定义 */
export const TABS = [
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
