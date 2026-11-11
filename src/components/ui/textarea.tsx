import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-28 w-full rounded-none border border-rule bg-sheet px-3 py-2 text-sm text-ink outline-none placeholder:text-[#8a7f72] focus-visible:border-oxide focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxide disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
