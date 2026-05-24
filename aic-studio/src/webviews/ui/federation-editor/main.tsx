// src/webviews/ui/federation-editor/main.tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

declare global {
  // VS Code injects acquireVsCodeApi() into webviews
  function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
  };
}

const vscode = acquireVsCodeApi();
const root = createRoot(document.getElementById("root")!);
root.render(<App vscode={vscode} />);

// Tell host the webview is ready
vscode.postMessage({ kind: "ready" });
