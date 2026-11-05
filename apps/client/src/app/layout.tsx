import type { Metadata, Viewport } from 'next'
import { Noto_Sans_SC, Outfit, Plus_Jakarta_Sans } from 'next/font/google'
import type { ReactNode } from 'react'
import { BottomTabs } from '@/components/layout/bottom-tabs'
import { SideNav } from '@/components/layout/side-nav'
import './globals.css'

const outfit = Outfit({
  subsets: ['latin'],
  weight: ['700', '800'],
  variable: '--font-outfit',
})

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jakarta',
})

/** 中文标题字体：按 unicode-range 分片，浏览器只取用到的字块 */
const notoSC = Noto_Sans_SC({
  weight: 'variable',
  subsets: ['latin'],
  variable: '--font-noto-sc',
  preload: false,
})

export const metadata: Metadata = {
  title: 'Practice Coach',
  description: '训练计划与 AI 对话',
}

export const viewport: Viewport = {
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className={`${outfit.variable} ${jakarta.variable} ${notoSC.variable}`}>
      <body>
        {/* 移动端是手机满宽；桌面端换成左侧导航 + 居中内容列 */}
        <div className="mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden md:border-x-2 lg:max-w-5xl lg:flex-row lg:gap-8 lg:border-x-0 lg:px-6 lg:py-8">
          <SideNav />
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-auto lg:max-w-2xl">
            {children}
          </div>
          <BottomTabs />
        </div>
      </body>
    </html>
  )
}
