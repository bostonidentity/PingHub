// src/webviews/ui/dashboard/main.tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

declare global {
  function acquireVsCodeApi(): { postMessage(message: unknown): void };
}

const vscode = acquireVsCodeApi();
const root = createRoot(document.getElementById("root")!);
root.render(<App vscode={vscode} />);
vscode.postMessage({ kind: "dashboard-refresh" });
