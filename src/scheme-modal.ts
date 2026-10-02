import { ButtonComponent, FuzzySuggestModal, Modal, Notice, Setting, type Plugin, type TFile } from 'obsidian';
import { PluginError } from './errors';
import type { EngineClient } from './engine/client';
import type { LengthReport } from './engine/types';
import type { SchemeDefinition, ResourcePlan, Snapshot } from './schemes/model';
import { prepareScheme, loadPrepared, schemeSourceKey } from './schemes/resources';
import type { SchemeStore } from './schemes/store';
import { errorText, t } from './i18n';

const OFFICIAL_CONFIG_BASE = 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/config';
const OFFICIAL_PRESETS = [
  ['s2t', 'official.s2t'], ['t2s', 'official.t2s'], ['s2tw', 'official.s2tw'], ['tw2s', 'official.tw2s'],
  ['s2hk', 'official.s2hk'], ['hk2s', 'official.hk2s'], ['s2twp', 'official.s2twp'], ['tw2sp', 'official.tw2sp'],
  ['t2tw', 'official.t2tw'], ['tw2t', 'official.tw2t'], ['t2hk', 'official.t2hk'], ['hk2t', 'official.hk2t'],
] as const;

type OfficialPreset = (typeof OFFICIAL_PRESETS)[number];

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
        this.modalEl.addClass('opencc-modal');
        this.setTitle(title);
        this.contentEl.createEl('p', { text: description });
        const footer = this.contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(footer).setButtonText(t('action.cancel')).onClick(() => this.close());
        new ButtonComponent(footer).setButtonText(action).setCta().onClick(() => { accepted = true; this.close(); });
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

class ConfigFilePicker extends FuzzySuggestModal<TFile> {
  constructor(private readonly host: SchemeHost, private readonly choose: (file: TFile) => void) {
    super(host.app); this.setPlaceholder(t('field.browse'));
  }
  getItems(): TFile[] { return this.app.vault.getFiles().filter(file => /^(json|jsonc)$/i.test(file.extension)); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
  async onOpen(): Promise<void> { this.host.uiModals.add(this); await super.onOpen(); }
  onClose(): void { super.onClose(); this.host.uiModals.delete(this); }
}

export class SchemeEditModal extends Modal {
  private definition: SchemeDefinition;
  private overridesText: string;
  private sourceChoice: 'preset' | 'vault' | 'url';
  private preset: OfficialPreset = OFFICIAL_PRESETS[0];
  private officialDraft?: SchemeDefinition;
  private readonly controller = new AbortController();
  private busy = false;
  private publishing = false;
  private form!: HTMLElement;
  private status!: HTMLElement;
  private previewEl!: HTMLElement;
  private primary!: ButtonComponent;
  private cancel!: ButtonComponent;
  private locationSetting?: Setting;
  private mappingSetting?: Setting;
  private reviewPlan?: ResourcePlan;
  constructor(private readonly host: SchemeHost, private readonly original?: SchemeDefinition, private readonly saved: () => void = () => {}) {
    super(host.app);
    this.modalEl.addClass('opencc-modal');
    this.definition = original ? host.store.getDraft(original.id) ?? structuredClone(original) : { id: crypto.randomUUID(), name: '', source: { kind: 'vault', location: '' } };
    this.sourceChoice = original ? this.definition.source.kind : 'preset';
    this.overridesText = JSON.stringify(this.definition.overrides ?? {}, null, 2);
    this.scope.register(['Mod'], 'Enter', () => { void this.submit(); return false; });
  }
  onOpen(): void {
    this.host.uiModals.add(this);
    this.setTitle(this.original ? t('modal.editTitle') : t('modal.addTitle'));
    this.render();
  }
  private render(): void {
    this.contentEl.empty();
    this.locationSetting = undefined; this.mappingSetting = undefined;
    const form = this.contentEl.createEl('form');
    form.addEventListener('submit', event => { event.preventDefault(); void this.submit(); });
    this.form = form.createDiv();
    new Setting(this.form).setName(t('field.source')).addDropdown(dropdown => {
      if (!this.original) dropdown.addOption('preset', t('official.title'));
      dropdown.addOptions({ vault: t('source.vault'), url: t('source.url') }).setValue(this.sourceChoice).onChange(value => {
        this.sourceChoice = value as typeof this.sourceChoice;
        if (value !== 'preset') this.definition.source.kind = value as 'url' | 'vault';
        this.render();
      });
      dropdown.selectEl.setAttribute('aria-label', t('field.source'));
    });
    if (this.sourceChoice === 'preset') {
      new Setting(this.form).setName(t('official.preset')).addDropdown(dropdown => {
        for (const preset of OFFICIAL_PRESETS) dropdown.addOption(preset[0], `${t(preset[1])} (${preset[0]})`);
        dropdown.setValue(this.preset[0]).onChange(value => {
          this.preset = OFFICIAL_PRESETS.find(preset => preset[0] === value)!;
          this.officialDraft = undefined; this.render();
        });
        dropdown.selectEl.setAttribute('aria-label', t('official.preset'));
        dropdown.selectEl.dataset.openccPresets = '';
      });
    } else {
      this.locationSetting = new Setting(this.form).setName(t('field.location')).addText(text => {
        text.setPlaceholder(this.sourceChoice === 'url' ? 'https://…/config.json' : 'OpenCC/config.json').setValue(this.definition.source.location).onChange(value => {
          this.definition.source.location = value; this.locationSetting?.setErrorMessage(null);
        });
        text.inputEl.setAttribute('aria-label', t('field.location'));
      });
      if (this.sourceChoice === 'vault') this.locationSetting.addButton(button => {
        button.setButtonText(t('field.browse')).onClick(() => new ConfigFilePicker(this.host, file => {
          if (this.controller.signal.aborted) return;
          this.definition.source.location = file.path; this.render();
        }).open());
        button.buttonEl.type = 'button';
      });
      new Setting(this.form).setName(t('field.schemeName')).addText(text => {
        text.setPlaceholder(t('field.autoName')).setValue(this.definition.name).onChange(value => { this.definition.name = value; });
        text.inputEl.setAttribute('aria-label', t('field.schemeName'));
      });
      const advanced = this.form.createEl('details');
      advanced.createEl('summary', { text: t('advanced.title') });
      new Setting(advanced).setName(t('field.dependencyBase')).setDesc(t('field.dependencyBaseDesc')).addText(text => {
        text.setValue(this.definition.dependencyBase ?? '').onChange(value => { this.definition.dependencyBase = value.trim() || undefined; });
        text.inputEl.setAttribute('aria-label', t('field.dependencyBase'));
      });
      this.mappingSetting = new Setting(advanced).setName(t('field.fileMapping')).setDesc(t('field.fileMappingDesc')).addTextArea(text => {
        text.setValue(this.overridesText).onChange(value => { this.overridesText = value; this.mappingSetting?.setErrorMessage(null); });
        text.inputEl.rows = 4; text.inputEl.setAttribute('aria-label', t('field.fileMapping'));
      });
      new Setting(advanced).setName(t('preview.title')).addButton(button => {
        button.setButtonText(t('action.preview')).onClick(() => { void this.prepare(true); }); button.buttonEl.type = 'button';
      });
    }
    this.status = form.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    this.status.hidden = true;
    this.previewEl = form.createDiv();
    const footer = form.createDiv({ cls: 'modal-button-container' });
    this.cancel = new ButtonComponent(footer).setButtonText(t('action.close')).onClick(() => { if (!this.publishing) this.close(); });
    this.cancel.buttonEl.type = 'button';
    this.primary = new ButtonComponent(footer).setButtonText(this.sourceChoice === 'preset' ? t('official.add') : t('action.load')).setCta();
    this.primary.buttonEl.type = 'submit';
    if (this.sourceChoice === 'preset' && this.host.store.getDefinitions().some(definition => definition.source.kind === 'url' && definition.source.location === this.officialLocation(this.preset[0]))) {
      this.primary.setButtonText(t('official.added')).setDisabled(true);
    }
  }
  private message(text: string): void { this.status.setText(text); this.status.hidden = !text; }
  openPreview(): void { this.open(); void this.prepare(true); }
  private officialLocation(id: OfficialPreset[0]): string { return `${OFFICIAL_CONFIG_BASE}/${id}.json`; }
  private async submit(): Promise<void> {
    if (this.busy || this.controller.signal.aborted || this.primary.buttonEl.disabled) return;
    if (this.reviewPlan) { await this.load(this.reviewPlan); return; }
    if (this.sourceChoice === 'preset') {
      this.officialDraft ??= { id: crypto.randomUUID(), name: t(this.preset[1]), source: { kind: 'url', location: this.officialLocation(this.preset[0]) } };
      await this.prepare(false, this.officialDraft);
    } else await this.prepare();
  }
  private lock(locked: boolean): void {
    for (const field of this.form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea')) field.disabled = locked;
    this.primary.setDisabled(locked);
    if (!locked) this.form.querySelector<HTMLElement>('.is-invalid input, .is-invalid textarea')?.focus();
  }
  private captured(): SchemeDefinition {
    const definition = structuredClone(this.definition);
    definition.source.location = definition.source.location.trim();
    if (!definition.source.location) {
      this.locationSetting?.setErrorMessage(t('error.location'));
      this.locationSetting?.controlEl.querySelector('input')?.focus();
      throw new PluginError('INVALID_CONFIG', t('error.location'));
    }
    let fallback = definition.source.location.split(/[?#]/)[0]!.split('/').pop() ?? '';
    try { fallback = decodeURIComponent(fallback); } catch { /* Keep malformed escape text readable. */ }
    definition.name = definition.name.trim() || fallback.replace(/\.jsonc?$/i, '') || t('official.custom');
    let overrides: unknown;
    try { overrides = JSON.parse(this.overridesText || '{}'); } catch { overrides = null; }
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.values(overrides).some(value => typeof value !== 'string')) {
      this.mappingSetting?.setErrorMessage(t('error.mappingValues'));
      const details = this.mappingSetting?.settingEl.closest('details'); if (details) details.open = true;
      this.mappingSetting?.controlEl.querySelector('textarea')?.focus();
      throw new PluginError('INVALID_CONFIG', t('error.mappingValues'));
    }
    definition.overrides = overrides as Record<string, string>;
    return definition;
  }
  private async prepare(review = false, official?: SchemeDefinition): Promise<void> {
    if (this.busy || this.controller.signal.aborted) return;
    this.busy = true; this.lock(true); this.previewEl.empty(); this.message(t('prepare.running'));
    let reviewed = false;
    let definition: SchemeDefinition | undefined;
    try {
      definition = official ?? this.captured();
      if (!review && this.original && this.host.store.getDefinitions().some(item => item.id === this.original!.id) && await schemeSourceKey(definition) === await schemeSourceKey(this.original)) {
        const snapshot = await this.host.store.getActive(this.original.id);
        if (!this.controller.signal.aborted) await this.publish(definition, snapshot);
        return;
      }
      if (definition.source.kind === 'url' && /^http:/i.test(definition.source.location)) {
        const url = new URL(definition.source.location).href;
        if (!definition.approvedHttpUrls?.includes(url)) {
          if (!await confirmAction(this.host, t('http.configTitle'), t('http.configDesc', { location: safeLocation(url) }), t('http.allow'), this.controller.signal)) { this.message(''); return; }
          definition.approvedHttpUrls = [...(definition.approvedHttpUrls ?? []), url];
        }
      }
      if (this.controller.signal.aborted) return;
      await this.host.store.saveDraft(definition);
      const plan = await prepareScheme(this.app, definition, this.controller.signal);
      if (this.controller.signal.aborted) return;
      if (review || plan.warnings.length || plan.httpUrls.some(url => !plan.definition.approvedHttpUrls?.includes(url))) {
        this.showPlan(plan); reviewed = true;
      } else {
        this.busy = false;
        await this.load(plan);
      }
    } catch (error) { await this.failed(error, definition); }
    finally { this.busy = false; if (!reviewed && !this.reviewPlan) this.lock(false); }
  }
  private showPlan(plan: ResourcePlan): void {
    this.reviewPlan = plan;
    this.form.hidden = true;
    this.previewEl.dataset.openccReview = '';
    this.previewEl.createEl('p', { text: t('preview.summary', { count: plan.resources.length }) });
    const details = this.previewEl.createEl('details');
    details.createEl('summary', { text: t('preview.title') });
    details.createEl('p', { text: t('preview.config', { location: safeLocation(plan.configSource.location) }) });
    const list = details.createEl('ul');
    for (const resource of plan.resources) list.createEl('li', { text: `${safeText(resource.originalRef)} → ${safeLocation(resource.source.location)} · ${resource.dictType}` });
    for (const warning of plan.warnings) this.previewEl.createEl('p', { text: safeText(warning) });
    const unapproved = plan.httpUrls.filter(url => !plan.definition.approvedHttpUrls?.includes(url));
    this.primary.setButtonText(t('action.load')).setDisabled(unapproved.length > 0);
    if (unapproved.length) {
      new Setting(this.previewEl).setName(t('http.resources')).setDesc(t('http.resourcesDesc', { locations: unapproved.map(safeLocation).join('; ') })).addToggle(toggle => {
        toggle.setValue(false).onChange(value => {
          if (this.busy) { toggle.setValue(!value); return; }
          plan.definition.approvedHttpUrls = value ? [...new Set([...(plan.definition.approvedHttpUrls ?? []), ...unapproved])] : plan.definition.approvedHttpUrls?.filter(url => !unapproved.includes(url));
          this.primary.setDisabled(!value);
        });
        toggle.toggleEl.setAttribute('aria-label', t('http.resources'));
      });
    }
    const back = new ButtonComponent(this.previewEl).setButtonText(t('action.back')).onClick(() => {
      if (this.busy) return;
      this.reviewPlan = undefined; this.previewEl.empty(); delete this.previewEl.dataset.openccReview;
      this.form.hidden = false; this.lock(false); this.message('');
      this.primary.setButtonText(this.sourceChoice === 'preset' ? t('official.add') : t('action.load'));
      this.form.querySelector('input')?.focus();
    });
    back.buttonEl.type = 'button';
    this.message('');
    if (!this.primary.buttonEl.disabled) this.primary.buttonEl.focus();
  }
  private async publish(definition: SchemeDefinition, snapshot: Snapshot): Promise<void> {
    this.publishing = true; this.cancel.setDisabled(true); this.message(t('load.publishing'));
    const first = this.host.store.getDefinitions().length === 0 && !this.host.store.getDefaultId();
    await this.host.store.activate(definition, snapshot);
    if (first) {
      try { await this.host.store.setDefault(definition.id); }
      catch (error) { new Notice(safeError(error)); }
    }
    this.host.syncSchemeCommands(); this.saved(); this.close();
  }
  private async load(plan: ResourcePlan): Promise<void> {
    if (this.busy || this.controller.signal.aborted) return;
    this.busy = true; this.lock(true);
    for (const field of this.previewEl.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) field.disabled = true;
    this.message(t('load.running'));
    const priorStatus = this.host.store.getStatus(plan.definition.id);
    try {
      await this.host.store.setStatus(plan.definition.id, { kind: 'loading', warnings: plan.warnings });
      const snapshot = await loadPrepared(this.app, plan, this.host.engine, this.controller.signal);
      if (this.controller.signal.aborted) return;
      await this.publish(plan.definition, snapshot);
    } catch (error) {
      if (this.controller.signal.aborted) await this.host.store.setStatus(plan.definition.id, priorStatus);
      else await this.failed(error, plan.definition);
    } finally {
      this.publishing = false; this.busy = false; this.cancel.setDisabled(false);
      if (!this.reviewPlan) this.lock(false);
      else this.primary.setDisabled(false);
      for (const field of this.previewEl.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) field.disabled = false;
    }
  }
  private async failed(error: unknown, definition?: SchemeDefinition): Promise<void> {
    if (this.controller.signal.aborted) return;
    const failure = error instanceof PluginError ? error : new PluginError('LOAD_FAILED', t('error.load'));
    this.message(safeError(failure));
    this.publishing = false; this.cancel.setDisabled(false);
    if (definition && this.host.store.getDraft(definition.id)) {
      await this.host.store.setStatus(definition.id, { kind: this.host.store.getDefinitions().some(item => item.id === definition.id) ? 'stale' : 'unavailable', error: failure, warnings: [] });
      this.saved();
    }
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
  async onOpen(): Promise<void> { this.host.uiModals.add(this); await super.onOpen(); }
  onClose(): void { super.onClose(); this.host.uiModals.delete(this); }
}
