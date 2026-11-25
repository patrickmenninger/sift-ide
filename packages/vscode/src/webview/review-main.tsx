import { render } from "preact";
import { ReviewView } from "./review-view.js";
import type { ReviewWebviewMessage } from "./review-protocol.js";
import "./style.css";
import "./review.css";

interface VsCodeApi {
  postMessage(message: ReviewWebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
render(<ReviewView post={(m) => vscode.postMessage(m)} />, document.getElementById("root")!);
