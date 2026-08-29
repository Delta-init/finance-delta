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

/**
 * One integration travelling one of the rings.
 *
 * `ring` is an inset percentage, so it picks out the circle the icon rides —
 * the same insets the rings themselves are drawn at, which is what makes an
 * icon sit *on* a ring rather than near it.
 *
 * `startAt` is where on the circle it begins, in seconds of its own animation.
 * Applied as a negative delay, so the orbit opens partway through instead of
 * every icon setting off from the top together.
 */
interface Orbit {
  icon: LucideIcon;
  ring: number;
  startAt: number;
  size: "sm" | "md";
  tone: string;
}

/**
 * The three rings, as inset percentages, with how long each takes to come round.
 *
 * Inset works inwards, so a *larger* number is a *smaller* circle. 30% is the
 * tightest orbit here and still clears the mark at the centre; anything
 * further in would carry icons behind it.
 *
 * Outer rings turn slower, which is what makes the field read as having depth
 * rather than as one rigid disc.
 */
const RINGS = [2, 16, 30] as const;
const RING_DURATION: Record<number, string> = {
  2: "62s",
  16: "46s",
  30: "34s",
};

const ORBITERS: Orbit[] = [
  { icon: Landmark, ring: 2, startAt: 0, size: "md", tone: "text-primary-600" },
  { icon: Receipt, ring: 2, startAt: 21, size: "md", tone: "text-primary-600" },
  { icon: Coins, ring: 2, startAt: 42, size: "md", tone: "text-success" },
  { icon: CreditCard, ring: 16, startAt: 8, size: "sm", tone: "text-success" },
  { icon: Wallet, ring: 16, startAt: 31, size: "md", tone: "text-primary-600" },
  { icon: FileSpreadsheet, ring: 30, startAt: 4, size: "sm", tone: "text-primary-600" },
  { icon: BarChart3, ring: 30, startAt: 21, size: "sm", tone: "text-warning" },
];

const SIZES = { sm: "h-10 w-10", md: "h-12 w-12" } as const;
const ICON_SIZES = { sm: "h-4 w-4", md: "h-5 w-5" } as const;

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
        {/* The rings themselves. Static now — they are the track, and a track
            that moves under a travelling icon reads as two things sliding
            past each other rather than one thing going round. */}
        {RINGS.map((inset) => (
          <div
            key={inset}
            className="absolute rounded-full border border-primary-600/15"
            style={{ inset: `${inset}%` }}
          />
        ))}

        {/* soft center glow */}
        <div className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/20 blur-3xl" />

        {/* Orbiting integrations. Each rides a wrapper inset to its ring: the
            wrapper turns, carrying the icon around the circle, and the icon
            turns back at the same rate so it stays the right way up. */}
        {ORBITERS.map((o, i) => {
          const Icon = o.icon;
          const duration = RING_DURATION[o.ring] ?? "40s";
          return (
            <div
              key={i}
              className="animate-orbit pointer-events-none absolute"
              style={{
                inset: `${o.ring}%`,
                ["--orbit-duration" as string]: duration,
                animationDelay: `-${o.startAt}s`,
              }}
            >
              {/* Sits on the ring at twelve o'clock; the wrapper's rotation
                  takes it round from there. */}
              <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2">
                <div
                  className="animate-orbit-upright"
                  style={{
                    ["--orbit-duration" as string]: duration,
                    animationDelay: `-${o.startAt}s`,
                  }}
                >
                  <div
                    className={`flex ${SIZES[o.size]} items-center justify-center rounded-full border border-border bg-surface shadow-md`}
                  >
                    <Icon className={`${ICON_SIZES[o.size]} ${o.tone}`} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Just the "d" — the wordmark is four times wider than tall and would
            crowd the orbits. The letterform is recoloured white for the blue
            chip; the gradient circle is left alone, since it is the one piece
            of colour the mark has. */}
        <div className="absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl bg-primary shadow-lg">
          <img src="/delta-mark-white.png" alt="Delta Finance" className="h-10 w-auto" />
        </div>
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
