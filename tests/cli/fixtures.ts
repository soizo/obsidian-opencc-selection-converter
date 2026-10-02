import { MarkdownView, TFile } from 'obsidian';
import type { App, Plugin } from 'obsidian';

export type TestPlugin = Plugin & { convertDefault(): Promise<unknown> };

export async function openFixture(app: App, text: string, name = 'smoke.md'): Promise<MarkdownView> {
  if (!/^[A-Za-z0-9_-]+\.md$/.test(name)) throw new Error('Invalid fixture filename');
  const folder = '__opencc_tests__';
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  const path = `${folder}/${name}`;
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) file = await app.vault.create(path, text);
  else if (file instanceof TFile) await app.vault.modify(file, text);
  if (!(file instanceof TFile)) throw new Error('Fixture is not a file');
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file, { state: { mode: 'source', source: true } });
  if (!(leaf.view instanceof MarkdownView)) throw new Error('Fixture did not open as Markdown');
  await leaf.view.setState({ ...leaf.view.getState(), mode: 'source', source: true }, { history: false });
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  return leaf.view;
}
