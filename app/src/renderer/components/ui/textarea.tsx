import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border-0 bg-muted/70 px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:shadow-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:bg-destructive/10 aria-invalid:ring-0 aria-invalid:shadow-none md:text-sm dark:bg-muted/65 dark:focus-visible:shadow-none dark:disabled:bg-input/80 dark:aria-invalid:bg-destructive/15",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
