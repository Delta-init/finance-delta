import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary-700",
        secondary:
          "bg-surface text-foreground border border-border shadow-xs hover:bg-surface-muted",
        ghost: "text-foreground-muted hover:bg-surface-muted hover:text-foreground",
        outline:
          "border border-border-strong bg-transparent hover:bg-surface-muted",
        destructive: "bg-danger text-white shadow-xs hover:opacity-90",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-11 px-6 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      
      {...props}
    >
      {loading ? (
        <>
          <FinanceSpinner size={size === "lg" ? 16 : 13} />
          <span className="opacity-60">{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  ),
);
Button.displayName = "Button";

/** Finance-themed button spinner: spinning ring + static bar-chart inside. */
function FinanceSpinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* Spinning arc track */}
      <svg
        className="animate-spin absolute inset-0"
        viewBox="0 0 16 16"
        fill="none"
        width={size}
        height={size}
      >
        {/* Dim full circle track */}
        <circle
          cx="8"
          cy="8"
          r="6.25"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.18"
        />
        {/* Bright leading arc (~270°) */}
        <path
          d="M8 1.75 A6.25 6.25 0 1 1 1.75 8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>

      {/* Static mini bar-chart — stays upright while ring spins */}
      {/* <svg
        className="absolute inset-0"
        viewBox="0 0 16 16"
        fill="none"
        width={size}
        height={size}
      >
        <rect x="4.25" y="10.5" width="1.75" height="2.25" rx="0.35" fill="currentColor" opacity="0.35" />
        <rect x="7.12" y="8.25" width="1.75" height="4.5" rx="0.35" fill="currentColor" opacity="0.6" />
        <rect x="10" y="5.75" width="1.75" height="7" rx="0.35" fill="currentColor" opacity="0.9" />
      </svg> */}
    </span>
  );
}
