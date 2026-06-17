"use client";

import {
  Landmark,
  CreditCard,
  Receipt,
  Wallet,
  BarChart3,
  FileSpreadsheet,
  Coins,
  type LucideIcon,
} from "lucide-react";

interface Orbit {
  icon: LucideIcon;
  /** position as % within the orbit field */
  top: string;
  left: string;
  size: "sm" | "md" | "lg";
  tone: string;
}

const ORBITERS: Orbit[] = [
  { icon: Landmark, top: "8%", left: "52%", size: "md", tone: "text-primary-600" },
  { icon: CreditCard, top: "20%", left: "20%", size: "sm", tone: "text-success" },
  { icon: Receipt, top: "26%", left: "82%", size: "md", tone: "text-primary-600" },
  { icon: Wallet, top: "60%", left: "10%", size: "md", tone: "text-primary-600" },
  { icon: BarChart3, top: "78%", left: "30%", size: "sm", tone: "text-warning" },
  { icon: Coins, top: "84%", left: "62%", size: "md", tone: "text-success" },
  { icon: FileSpreadsheet, top: "58%", left: "88%", size: "sm", tone: "text-primary-600" },
];

const SIZES = {
  sm: "h-10 w-10",
  md: "h-12 w-12",
  lg: "h-14 w-14",
} as const;

const ICON_SIZES = { sm: "h-4 w-4", md: "h-5 w-5", lg: "h-6 w-6" } as const;

export function LoginShowcase() {
  return (
    <div
      className="relative hidden h-full flex-col overflow-hidden rounded-[22px] p-10 lg:flex"
      style={{
        background:
          "linear-gradient(160deg, oklch(0.95 0.03 254.6) 0%, oklch(0.9 0.06 254.6) 100%)",
      }}
    >
      <h2 className="text-center font-display text-3xl font-bold tracking-tight text-foreground">
        Run Finance <span className="text-primary">Everywhere</span>
      </h2>

      {/* Orbit field */}
      <div className="relative mx-auto my-auto aspect-square w-full max-w-[420px]">
        {/* concentric rings */}
        <div className="absolute inset-0 animate-spin-slow">
          {[0, 14, 28, 42].map((inset) => (
            <div
              key={inset}
              className="absolute rounded-full border border-primary-600/15"
              style={{
                inset: `${inset}%`,
              }}
            />
          ))}
        </div>

        {/* soft center glow */}
        <div className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/20 blur-3xl" />

        {/* center brand mark */}
        <div className="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl bg-primary text-3xl font-bold text-primary-foreground shadow-lg">
          Δ
        </div>

        {/* orbiting integration icons */}
        {ORBITERS.map((o, i) => {
          const Icon = o.icon;
          return (
            <div
              key={i}
              className="absolute animate-float"
              style={{
                top: o.top,
                left: o.left,
                transform: "translate(-50%, -50%)",
                animationDelay: `${i * 0.6}s`,
              }}
            >
              <div
                className={`flex ${SIZES[o.size]} items-center justify-center rounded-full border border-border bg-surface shadow-md`}
              >
                <Icon className={`${ICON_SIZES[o.size]} ${o.tone}`} />
              </div>
            </div>
          );
        })}
      </div>

      <p className="mx-auto max-w-sm text-center text-sm leading-relaxed text-foreground-muted">
        Connect your <em className="font-medium not-italic text-foreground">banks, payment gateways, and accounting</em>{" "}
        workflows for a seamless finance experience anywhere you do business.
      </p>

      {/* carousel dots */}
      <div className="mt-6 flex justify-center gap-1.5">
        <span className="h-1.5 w-6 rounded-full bg-primary" />
        <span className="h-1.5 w-1.5 rounded-full bg-primary/30" />
        <span className="h-1.5 w-1.5 rounded-full bg-primary/30" />
      </div>
    </div>
  );
}
