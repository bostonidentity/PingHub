// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JourneyDiffGraphModal } from "@/app/compare/JourneyDiffGraph";
import type { FileDiff, JourneyNodeInfo, JourneyTreeNode } from "@/lib/diff-types";

type MockCanvasNode = {
  id: string;
  data: {
    label?: string;
    nodeType?: string;
    diffStatus?: string;
  };
};

type MockCanvasProps = {
  baseNodes: MockCanvasNode[];
  onNodeDoubleClick?: (id: string, data: MockCanvasNode["data"]) => void;
};

vi.mock("@/components/diff-graph/DiffGraphCanvas", () => ({
  DiffGraphCanvas: ({ baseNodes, onNodeDoubleClick }: MockCanvasProps) => (
    <div data-testid="diff-graph-canvas">
      {baseNodes.map((node) => (
        <button
          data-testid={`node-${node.id}`}
          key={node.id}
          onClick={() => onNodeDoubleClick?.(node.id, node.data)}
          type="button"
        >
          {node.data.label ?? node.id}:{node.data.diffStatus ?? "unknown"}
        </button>
      ))}
    </div>
  ),
}));

const parentJourney = JSON.stringify({
  entryNodeId: "inner-node",
  staticNodes: {
    startNode: { x: 0, y: 0 },
  },
  nodes: {
    "inner-node": {
      nodeType: "InnerTreeEvaluatorNode",
      displayName: "IJ: Kerberos",
      connections: {},
      x: 100,
      y: 100,
    },
  },
});

const childJourney = JSON.stringify({
  entryNodeId: "changed-node",
  staticNodes: {
    startNode: { x: 0, y: 0 },
  },
  nodes: {
    "changed-node": {
      nodeType: "ScriptedDecisionNode",
      displayName: "Changed child script",
      connections: {},
      x: 100,
      y: 100,
    },
  },
});

const parentNodeInfos: JourneyNodeInfo[] = [
  {
    uuid: "inner-node",
    name: "Inner Tree Evaluator",
    displayName: "IJ: Kerberos",
    nodeType: "InnerTreeEvaluatorNode",
    status: "modified",
    modifiedReason: "subjourney",
  },
];

const childNodeInfos: JourneyNodeInfo[] = [
  {
    uuid: "changed-node",
    name: "Scripted Decision",
    displayName: "Changed child script",
    nodeType: "ScriptedDecisionNode",
    status: "modified",
  },
];

const journeyTree: JourneyTreeNode[] = [
  {
    name: "Parent",
    status: "modified",
    isEntry: true,
    nodes: parentNodeInfos,
    scripts: [],
    subJourneys: [
      {
        name: "Child",
        status: "modified",
        isEntry: false,
        nodes: childNodeInfos,
        scripts: [],
        subJourneys: [],
      },
    ],
  },
];

const files: FileDiff[] = [
  {
    relativePath: "alpha/journeys/Parent/nodes/InnerTreeEvaluatorNode/inner-node.json",
    scope: "journeys",
    status: "unchanged",
    localContent: JSON.stringify({
      _id: "inner-node",
      _type: { _id: "InnerTreeEvaluatorNode" },
      tree: "Child",
    }),
    remoteContent: JSON.stringify({
      _id: "inner-node",
      _type: { _id: "InnerTreeEvaluatorNode" },
      tree: "Child",
    }),
  },
  {
    relativePath: "alpha/journeys/Child/Child.json",
    scope: "journeys",
    status: "modified",
    localContent: childJourney,
    remoteContent: childJourney,
  },
];

describe("JourneyDiffGraphModal", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves inner journey node statuses when navigating from the parent graph", async () => {
    render(
      <JourneyDiffGraphModal
        files={files}
        journeyName="Parent"
        journeyTree={journeyTree}
        localContent={parentJourney}
        nodeInfos={parentNodeInfos}
        onClose={vi.fn()}
        remoteContent={parentJourney}
        sourceEnv="ide"
        sourceLabel="IDE"
        targetEnv="ide3"
        targetLabel="IDE3"
      />,
    );

    expect(screen.getByTestId("node-inner-node")).toHaveTextContent("IJ: Kerberos:modified");

    fireEvent.click(screen.getByTestId("node-inner-node"));
    fireEvent.click(await screen.findByRole("button", { name: /navigate into diff/i }));

    await waitFor(() => {
      expect(screen.getByTestId("node-changed-node")).toHaveTextContent("Changed child script:modified");
    });
  });
});
