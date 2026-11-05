import type { Metadata, Viewport } from 'next'
import { Outfit, Plus_Jakarta_Sans } from 'next/font/google'
import type { ReactNode } from 'react'
import { BottomTabs } from '@/components/layout/bottom-tabs'
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

export const metadata: Metadata = {
  title: 'Practice Coach',
  description: '移动端训练计划与 AI 对话',
}

export const viewport: Viewport = {
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className={`${outfit.variable} ${jakarta.variable}`}>
      <body>
        {/* H5 壳层：手机满宽，桌面居中显示为手机尺寸 */}
        <div className="mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden md:border-x-2">
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          <BottomTabs />
        </div>
      </body>
    </html>
  )
}
