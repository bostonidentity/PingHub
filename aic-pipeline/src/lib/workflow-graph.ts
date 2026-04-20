// ── Types ─────────────────────────────────────────────────────────────────────

export type WorkflowStepKind = "approvalTask" | "scriptTask" | "exclusiveGateway";

export interface WorkflowNextStep {
  outcome: string;
  step: string;
  condition: string | null;
}

export interface WorkflowStep {
  id: string;
  displayName: string;
  kind: WorkflowStepKind;
  nextStep: WorkflowNextStep[];
  hasScript: boolean;
  x: number;
  y: number;
}

export interface WorkflowData {
  id: string;
  displayName: string;
  status: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startConnection: string;
  steps: WorkflowStep[];
}

// ── Internal JSON shapes ───────────────────────────────────────────────────────

interface TopLevelJson {
  id?: string;
  name?: string;
  displayName?: string;
  status?: string;
  staticNodes?: {
    startNode?: { connections?: Record<string, string>; x?: number; y?: number };
    endNode?: { x?: number; y?: number };
    uiConfig?: Record<string, { x?: number; y?: number }>;
  };
}

interface StepJson {
  name?: string;
  displayName?: string;
  approvalTask?: { nextStep?: WorkflowNextStep[] };
  scriptTask?: { nextStep?: WorkflowNextStep[]; script?: unknown };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function kindFromId(id: string): WorkflowStepKind {
  if (id.startsWith("approvalTask"))     return "approvalTask";
  if (id.startsWith("exclusiveGateway")) return "exclusiveGateway";
  return "scriptTask";
}

function extractNextSteps(s: StepJson): WorkflowNextStep[] {
  const raw = s.approvalTask?.nextStep ?? s.scriptTask?.nextStep ?? [];
  return raw.map((n) => ({
    outcome:   n.outcome   ?? "",
    step:      n.step      ?? "endNode",
    condition: n.condition ?? null,
  }));
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseWorkflowData(topJson: string, stepJsonStrings: string[]): WorkflowData | null {
  let top: TopLevelJson;
  try { top = JSON.parse(topJson) as TopLevelJson; } catch { return null; }

  const sn       = top.staticNodes ?? {};
  const uiConfig = sn.uiConfig ?? {};

  const steps: WorkflowStep[] = [];
  for (const raw of stepJsonStrings) {
    let s: StepJson;
    try { s = JSON.parse(raw) as StepJson; } catch { continue; }
    if (!s.name) continue;
    const pos = uiConfig[s.name] ?? {};
    steps.push({
      id:          s.name,
      displayName: s.displayName ?? s.name,
      kind:        kindFromId(s.name),
      nextStep:    extractNextSteps(s),
      hasScript:   !!s.scriptTask?.script,
      x:           pos.x ?? 400,
      y:           pos.y ?? 225,
    });
  }

  return {
    id:              top.id ?? top.name ?? "workflow",
    displayName:     top.displayName ?? top.name ?? "Workflow",
    status:          top.status ?? "unknown",
    startX:          sn.startNode?.x ?? 70,
    startY:          sn.startNode?.y ?? 225,
    endX:            sn.endNode?.x  ?? 2000,
    endY:            sn.endNode?.y  ?? 225,
    startConnection: sn.startNode?.connections?.["start"] ?? "",
    steps,
  };
}
