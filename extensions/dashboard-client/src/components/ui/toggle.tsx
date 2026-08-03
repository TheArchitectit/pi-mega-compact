import * as React from "react";
import { cn } from "../../utils/cn";

export interface ToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  pressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
}

export function Toggle({ pressed, onPressedChange, className, onClick, ...props }: ToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={(e) => {
        onClick?.(e);
        onPressedChange?.(!pressed);
      }}
      className={cn(
        "inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium transition-all",
        pressed
          ? "border-primary/50 bg-primary/15 text-neon glow-primary"
          : "border-border bg-transparent text-muted hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
