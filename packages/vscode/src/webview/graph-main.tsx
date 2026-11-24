import { render } from "preact";
import { GraphApp } from "./graph-view.js";
import type { GraphWebviewMessage } from "./graph-protocol.js";
import "./graph.css";

interface VsCodeApi {
  postMessage(message: GraphWebviewMessage): void;
  getState(): { diagram?: boolean } | undefined;
  setState(state: { diagram: boolean }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
render(<GraphApp post={(m) => vscode.postMessage(m)} diagram={vscode.getState()?.diagram ?? false} onDiagram={(diagram) => vscode.setState({ diagram })} />, document.getElementById("root")!);
