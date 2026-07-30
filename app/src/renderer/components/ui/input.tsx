import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border-0 bg-muted/70 px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:shadow-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:bg-destructive/10 aria-invalid:ring-0 aria-invalid:shadow-none md:text-sm dark:bg-muted/65 dark:focus-visible:shadow-none dark:disabled:bg-input/80 dark:aria-invalid:bg-destructive/15",
        className
      )}
      {...props}
    />
  )
}

export { Input }
