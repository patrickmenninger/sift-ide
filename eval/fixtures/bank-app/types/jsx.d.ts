// Minimal JSX typing so components type-check without React installed.
declare namespace JSX {
  interface Element {
    readonly __jsx: true;
  }
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}
