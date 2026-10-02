import { FuzzySuggestModal, Modal, Setting, type Plugin } from 'obsidian';
import { PluginError } from './errors';
import type { EngineClient } from './engine/client';
import type { LengthReport } from './engine/types';
import type { SchemeDefinition, ResourcePlan } from './schemes/model';
import { prepareScheme, loadPrepared } from './schemes/resources';
import type { SchemeStore } from './schemes/store';
import { errorText, t } from './i18n';

export interface SchemeHost extends Plugin {
  store: SchemeStore;
  engine: EngineClient;
  lengthReports: Map<string, LengthReport>;
  uiModals: Set<Modal>;
  syncSchemeCommands(): void;
}

export function safeLocation(location: string): string {
  if (!/^https?:/i.test(location)) return location;
  try {
    const url = new URL(location);
    const displayLocation = `${url.origin}${url.pathname}`;
    return url.search ? t('location.queryHidden', { location: displayLocation }) : displayLocation;
  } catch { return t('location.invalid'); }
}
export function safeText(text: string): string { return text.replace(/https?:\/\/[^\s"'<>）)]+/gi, safeLocation); }
export function safeError(error: unknown): string {
  const message = error instanceof PluginError ? t('error.format', { code: error.code, message: errorText(error.code, error.message) }) : t('error.generic');
  return safeText(message);
}

export function confirmAction(host: SchemeHost, title: string, description: string, action: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    let accepted = false;
    class Confirmation extends Modal {
      onOpen(): void {
        host.uiModals.add(this);
        this.setTitle(title);
        this.contentEl.createEl('p', { text: description });
        new Setting(this.contentEl).addButton(button => button.setButtonText(t('action.cancel')).onClick(() => this.close()))
          .addButton(button => button.setButtonText(action).setCta().onClick(() => { accepted = true; this.close(); }));
      }
      onClose(): void {
        signal?.removeEventListener('abort', abort);
        host.uiModals.delete(this);
        this.contentEl.empty();
        resolve(accepted);
      }
    }
    const modal = new Confirmation(host.app);
    const abort = () => modal.close();
    if (signal?.aborted) { resolve(false); return; }
    signal?.addEventListener('abort', abort, { once: true });
    modal.open();
  });
}

export class SchemeEditModal extends Modal {
  private definition: SchemeDefinition;
  private overridesText: string;
  private readonly controller = new AbortController();
  private busy = false;
  private publishing = false;
  private form!: HTMLElement;
  private status!: HTMLElement;
  private previewEl!: HTMLElement;
  constructor(private readonly host: SchemeHost, private readonly original?: SchemeDefinition, private readonly saved: () => void = () => {}) {
    super(host.app);
    this.definition = original ? host.store.getDraft(original.id) ?? structuredClone(original) : { id: crypto.randomUUID(), name: '', source: { kind: 'vault', location: '' } };
    this.overridesText = JSON.stringify(this.definition.overrides ?? {}, null, 2);
  }
  onOpen(): void {
    this.host.uiModals.add(this);
    this.setTitle(this.original ? t('modal.editTitle') : t('modal.addTitle'));
    this.form = this.contentEl.createDiv();
    new Setting(this.form).setName(t('field.schemeName')).addText(text => text.setValue(this.definition.name).onChange(value => { this.definition.name = value; }).inputEl.setAttribute('aria-label', t('field.schemeName')));
    new Setting(this.form).setName(t('field.source')).addDropdown(dropdown => {
      dropdown.addOptions({ vault: t('source.vault'), url: t('source.url') }).setValue(this.definition.source.kind).onChange(value => { this.definition.source.kind = value as 'url' | 'vault'; });
      dropdown.selectEl.setAttribute('aria-label', t('field.source'));
    });
    new Setting(this.form).setName(t('field.location')).setDesc(t('field.locationDesc')).addText(text => {
      text.setValue(this.definition.source.location).onChange(value => { this.definition.source.location = value; }); text.inputEl.setAttribute('aria-label', t('field.location'));
    });
    const advanced = this.form.createEl('details');
    advanced.createEl('summary', { text: t('advanced.title') });
    new Setting(advanced).setName(t('field.dependencyBase')).setDesc(t('field.dependencyBaseDesc')).addText(text => {
      text.setValue(this.definition.dependencyBase ?? '').onChange(value => { this.definition.dependencyBase = value || undefined; }); text.inputEl.setAttribute('aria-label', t('field.dependencyBase'));
    });
    new Setting(advanced).setName(t('field.fileMapping')).setDesc(t('field.fileMappingDesc')).addTextArea(text => {
      text.setValue(this.overridesText).onChange(value => { this.overridesText = value; }); text.inputEl.setAttribute('aria-label', t('field.fileMapping'));
    });
    new Setting(this.form).addButton(button => button.setButtonText(t('action.preview')).setCta().onClick(() => { void this.prepare(); }));
    if (this.original && this.host.store.getDefinitions().some(item => item.id === this.original!.id)) {
      new Setting(this.form).setDesc(t('rename.desc')).addButton(button => button.setButtonText(t('action.rename')).onClick(() => { void this.rename(); }));
    }
    this.status = this.contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    this.previewEl = this.contentEl.createDiv();
    new Setting(this.contentEl).addButton(button => button.setButtonText(t('action.close')).onClick(() => { if (!this.publishing) this.close(); }));
  }
  openPreview(): void { this.open(); void this.prepare(); }
  private lock(locked: boolean): void {
    for (const field of this.form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea')) field.disabled = locked;
  }
  private captured(): SchemeDefinition {
    const definition = structuredClone(this.definition);
    definition.name = definition.name.trim(); definition.source.location = definition.source.location.trim();
    if (!definition.name || !definition.source.location) throw new PluginError('INVALID_CONFIG', t('error.nameLocation'));
    let overrides: unknown;
    try { overrides = JSON.parse(this.overridesText); } catch { throw new PluginError('INVALID_CONFIG', t('error.mappingJson')); }
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.values(overrides).some(value => typeof value !== 'string')) throw new PluginError('INVALID_CONFIG', t('error.mappingValues'));
    definition.overrides = overrides as Record<string, string>;
    return definition;
  }
  private async rename(): Promise<void> {
    if (this.busy || !this.original) return;
    this.busy = true; this.lock(true);
    try {
      const name = this.definition.name.trim();
      if (!name) throw new PluginError('INVALID_CONFIG', t('error.name'));
      const snapshot = await this.host.store.getActive(this.original.id);
      if (this.controller.signal.aborted) return;
      this.publishing = true; this.status.setText(t('rename.saving'));
      await this.host.store.activate({ ...this.original, name }, snapshot);
      this.host.syncSchemeCommands(); this.saved(); this.close();
    } catch (error) { this.status.setText(safeError(error)); }
    finally { this.publishing = false; this.busy = false; this.lock(false); }
  }
  private async prepare(): Promise<void> {
    if (this.busy || this.controller.signal.aborted) return;
    this.busy = true; this.lock(true); this.previewEl.empty(); this.status.setText(t('prepare.running'));
    let prepared = false;
    try {
      const definition = this.captured();
      if (definition.source.kind === 'url' && /^http:/i.test(definition.source.location)) {
        const url = new URL(definition.source.location).href;
        if (!definition.approvedHttpUrls?.includes(url)) {
          if (!await confirmAction(this.host, t('http.configTitle'), t('http.configDesc', { location: safeLocation(url) }), t('http.allow'), this.controller.signal)) return;
          definition.approvedHttpUrls = [...(definition.approvedHttpUrls ?? []), url];
        }
      }
      if (this.controller.signal.aborted) return;
      await this.host.store.saveDraft(definition);
      const plan = await prepareScheme(this.app, definition, this.controller.signal);
      if (this.controller.signal.aborted) return;
      this.showPlan(plan); prepared = true; this.status.setText(t('prepare.ready'));
    } catch (error) { await this.failed(error); }
    finally { this.busy = false; if (!prepared) this.lock(false); }
  }
  private showPlan(plan: ResourcePlan): void {
    this.previewEl.createEl('h3', { text: t('preview.title') });
    this.previewEl.createEl('p', { text: t('preview.config', { location: safeLocation(plan.configSource.location) }) });
    const list = this.previewEl.createEl('ul');
    for (const resource of plan.resources) list.createEl('li', { text: `${safeText(resource.originalRef)} → ${safeLocation(resource.source.location)} · ${resource.dictType}` });
    if (!plan.resources.length) this.previewEl.createEl('p', { text: t('preview.none') });
    for (const warning of plan.warnings) this.previewEl.createEl('p', { text: safeError(new PluginError('CONFIG_WARNING', warning)) });
    const unapproved = plan.httpUrls.filter(url => !plan.definition.approvedHttpUrls?.includes(url));
    let approved = unapproved.length === 0;
    let loadButton: HTMLButtonElement;
    if (unapproved.length) {
      new Setting(this.previewEl).setName(t('http.resources')).setDesc(t('http.resourcesDesc', { locations: unapproved.map(safeLocation).join('; ') })).addToggle(toggle => {
        toggle.setValue(false).onChange(value => { approved = value; loadButton.disabled = !value; });
        toggle.toggleEl.setAttribute('aria-label', t('http.resources'));
      });
    }
    new Setting(this.previewEl).addButton(button => button.setButtonText(t('action.back')).onClick(() => { if (!this.busy) { this.previewEl.empty(); this.lock(false); this.status.setText(t('prepare.retry')); } }))
      .addButton(button => {
        button.setButtonText(t('action.load')).setCta().setDisabled(!approved).onClick(() => {
          if (!approved) return;
          plan.definition.approvedHttpUrls = [...new Set([...(plan.definition.approvedHttpUrls ?? []), ...unapproved])];
          void this.load(plan);
        }); loadButton = button.buttonEl;
      });
  }
  private async load(plan: ResourcePlan): Promise<void> {
    if (this.busy || this.controller.signal.aborted) return;
    this.busy = true;
    for (const button of this.previewEl.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
    this.status.setText(t('load.running'));
    const priorStatus = this.host.store.getStatus(plan.definition.id);
    await this.host.store.setStatus(plan.definition.id, { kind: 'loading', warnings: plan.warnings });
    try {
      const snapshot = await loadPrepared(this.app, plan, this.host.engine, this.controller.signal);
      if (this.controller.signal.aborted) return;
      this.publishing = true; this.status.setText(t('load.publishing'));
      await this.host.store.activate(plan.definition, snapshot);
      this.host.syncSchemeCommands(); this.saved(); this.close();
    } catch (error) {
      if (this.controller.signal.aborted) await this.host.store.setStatus(plan.definition.id, priorStatus);
      else await this.failed(error);
    } finally {
      this.publishing = false; this.busy = false;
      for (const button of this.previewEl.querySelectorAll<HTMLButtonElement>('button')) button.disabled = false;
    }
  }
  private async failed(error: unknown): Promise<void> {
    if (this.controller.signal.aborted) return;
    const failure = error instanceof PluginError ? error : new PluginError('LOAD_FAILED', t('error.load'));
    this.status.setText(safeError(failure));
    await this.host.store.setStatus(this.definition.id, { kind: this.host.store.getDefinitions().some(item => item.id === this.definition.id) ? 'stale' : 'unavailable', error: failure, warnings: [] });
    this.saved();
  }
  onClose(): void {
    // Publication is a durable operation; closing its UI does not roll it back.
    if (!this.publishing) this.controller.abort();
    this.host.uiModals.delete(this);
    this.contentEl.empty();
  }
}

export class SchemePicker extends FuzzySuggestModal<SchemeDefinition> {
  constructor(private readonly host: SchemeHost, private readonly choose: (definition: SchemeDefinition) => void) {
    super(host.app); this.setPlaceholder(t('picker.placeholder'));
  }
  getItems(): SchemeDefinition[] { return [...this.host.store.getDefinitions()]; }
  getItemText(item: SchemeDefinition): string { return `${item.name} — ${safeLocation(item.source.location)}`; }
  onChooseItem(item: SchemeDefinition): void { this.choose(item); }
  onOpen(): void { super.onOpen(); this.host.uiModals.add(this); }
  onClose(): void { super.onClose(); this.host.uiModals.delete(this); }
}
