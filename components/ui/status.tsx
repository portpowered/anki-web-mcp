import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type StatusTone = "info" | "success" | "warning" | "error";

export type StatusProps = HTMLAttributes<HTMLParagraphElement> & {
  tone?: StatusTone;
};

const toneClasses: Record<StatusTone, string> = {
  info: "border-border bg-surface-muted text-navy",
  success: "border-success-border bg-success-background text-success-foreground",
  warning: "border-warning-border bg-warning-background text-warning-foreground",
  error: "border-error-border bg-error-background text-error-foreground",
};

export const Status = forwardRef<HTMLParagraphElement, StatusProps>(
  function Status({ className, role, tone = "info", ...props }, ref) {
    return (
      <p
        ref={ref}
        role={role ?? (tone === "error" ? "alert" : "status")}
        className={cn(
          "rounded-lg border px-4 py-3 text-sm leading-6",
          toneClasses[tone],
          className,
        )}
        {...props}
      />
    );
  },
);
