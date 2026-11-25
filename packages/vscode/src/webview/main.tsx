import { render } from "preact";
import { LogicDocument } from "./logic-document.js";
import type { WebviewMessage } from "./protocol.js";
import "./style.css";

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): { toggled?: string[] } | undefined;
  setState(state: { toggled: string[] }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
render(
  <LogicDocument post={(m) => vscode.postMessage(m)} toggled={vscode.getState()?.toggled ?? []} onToggled={(toggled) => vscode.setState({ toggled })} />,
  document.getElementById("root")!,
);
