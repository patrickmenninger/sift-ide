import type { AdapterOptions, AdapterProject, LanguageAdapter } from "./adapter.js";

/**
 * Keeps one adapter project open per language for a long-lived workspace (phase-2-design §4: "the
 * adapter project stays open"). Each `openProject` brings the held project up to date with the disk
 * (`AdapterProject.refresh`), which re-reads only what changed, instead of building it again. A
 * project that cannot follow the disk, or says it must be reopened (its tsconfig changed), is
 * opened again.
 */
export class OpenProjects {
  private readonly held = new Map<string, { root: string; project: AdapterProject }>();
  /** The adapters to hand to the engine: `openProject` returns the held project, and `dispose` on it does nothing. */
  readonly adapters: LanguageAdapter[];

  constructor(base: LanguageAdapter[]) {
    this.adapters = base.map((adapter) => ({
      id: adapter.id,
      extensions: adapter.extensions,
      hashFile: (path, text) => adapter.hashFile(path, text),
      openProject: (root, files, options) => this.open(adapter, root, files, options),
    }));
  }

  /** The held project for an adapter, brought up to date with the disk; opened if needed. */
  async open(adapter: LanguageAdapter, root: string, files: string[], options?: AdapterOptions): Promise<AdapterProject> {
    const held = this.held.get(adapter.id);
    if (held && held.root === root && held.project.refresh?.(files)) return shared(held.project);
    held?.project.dispose();
    this.held.delete(adapter.id);
    const project = await adapter.openProject(root, files, options);
    if (!project.refresh) return project; // cannot follow the disk, so it is not kept
    this.held.set(adapter.id, { root, project });
    return shared(project);
  }

  dispose(): void {
    for (const { project } of this.held.values()) project.dispose();
    this.held.clear();
  }
}

/** The project as callers see it: theirs to use, but not to close. */
function shared(project: AdapterProject): AdapterProject {
  const view: AdapterProject = {
    extractFile: (path) => project.extractFile(path),
    findImplementations: (symbol) => project.findImplementations(symbol),
    dispose: () => {},
  };
  if (project.refresh) view.refresh = (files) => project.refresh!(files);
  if (project.extractText) view.extractText = (path, text) => project.extractText!(path, text);
  if (project.diagnostics) view.diagnostics = (overlays, files) => project.diagnostics!(overlays, files);
  if (project.declarationText) view.declarationText = (ref) => project.declarationText!(ref);
  return view;
}
