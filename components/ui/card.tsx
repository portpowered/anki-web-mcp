import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export const Card = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <section
        ref={ref}
        className={cn(
          "rounded-card border border-border bg-surface shadow-card",
          className,
        )}
        {...props}
      />
    );
  },
);

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6 pb-0", className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6", className)} {...props} />;
}
