import { cn } from "@/lib/utils";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const CLASSES: Record<Tone, string> = {
  success: "pill-success",
  warning: "pill-warning",
  danger: "pill-danger",
  info: "pill-info",
  neutral: "pill-neutral",
};

export function StatusPill({
  tone,
  children,
  className,
  title,
}: { tone: Tone; children: React.ReactNode; className?: string; title?: string }) {
  return <span className={cn(CLASSES[tone], className)} title={title}>{children}</span>;
}
