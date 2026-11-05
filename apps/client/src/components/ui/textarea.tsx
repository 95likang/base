import { cn } from 'cn'
import type * as React from 'react'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-24 w-full rounded-md border-2 border-input bg-card px-4 py-3 text-base transition-all duration-300 outline-none placeholder:text-muted-foreground focus-visible:border-accent focus-visible:shadow-pop-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:shadow-pop-destructive md:text-sm',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
