import type { Components } from 'react-markdown'

/** 模型输出是 Markdown；只按需映射排版元素，不引入 @tailwindcss/typography */
export const markdownComponents: Components = {
  p: ({ children }) => <p className="mt-1.5 leading-relaxed first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-1.5 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1.5 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h2 className="mt-2.5 font-heading text-base font-extrabold">{children}</h2>
  ),
  h2: ({ children }) => <h3 className="mt-2.5 font-heading text-sm font-extrabold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-2.5 font-heading text-sm font-extrabold">{children}</h4>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-bold text-accent underline underline-offset-2"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="mt-2 overflow-x-auto rounded-xl border-2 border-border bg-muted p-3 text-xs leading-relaxed">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mt-1.5 border-l-4 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }) => (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-2 border-border px-2 py-1 text-left font-bold">{children}</th>
  ),
  td: ({ children }) => <td className="border-2 border-border px-2 py-1 text-left">{children}</td>,
}
