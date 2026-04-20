import { cn } from "@/lib/utils";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const CLASSES: Record<Tone, string> = {
  success: "pill-success",
  warning: "pill-warning",
  danger:  "pill-danger",
  info:    "pill-info",
  neutral: "pill-neutral",
};

export function StatusPill({
  tone,
  children,
  className,
}: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn(CLASSES[tone], className)}>{children}</span>;
}
