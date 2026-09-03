import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost" | "icon" | "primary-icon";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 disabled:bg-primary/50",
  secondary:
    "border border-border bg-surface text-navy shadow-sm hover:bg-surface-muted disabled:text-muted",
  destructive:
    "border border-error-foreground bg-error-foreground text-white shadow-sm hover:bg-error-foreground/90 disabled:bg-error-foreground/50",
  ghost:
    "bg-transparent text-muted hover:bg-surface-muted hover:text-navy disabled:text-muted/60",
  icon:
    "border border-border bg-surface text-navy shadow-sm hover:bg-surface-muted disabled:text-muted",
  "primary-icon":
    "border border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 disabled:bg-primary/50",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, disabled, type = "button", variant = "primary", ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled}
        className={cn(
          "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-70 motion-reduce:transition-none",
          variantClasses[variant],
          (variant === "icon" || variant === "primary-icon") && "min-w-11 px-2",
          className,
        )}
        {...props}
      />
    );
  },
);
