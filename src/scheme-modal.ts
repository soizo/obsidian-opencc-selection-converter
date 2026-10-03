import { ButtonComponent, FuzzySuggestModal, Modal, Notice, Setting, type Plugin, type TFile } from 'obsidian';
import { PluginError } from './errors';
import type { EngineClient } from './engine/client';
import type { LengthReport } from './engine/types';
import type { ChainSchemeDefinition, ResourcePlan, SchemeDefinition, SingleResourcePlan, SingleSchemeDefinition, SingleSnapshot, Snapshot } from './schemes/model';
import { combineSnapshots, prepareScheme, loadPrepared, schemeSourceKey, isChainDefinition, splitChainSnapshot } from './schemes/resources';
import type { SchemeStore } from './schemes/store';
import { errorText, t } from './i18n';
import { PRESETS, presetDefinition, type Preset } from './schemes/presets';

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
export function schemeLocation(definition: SchemeDefinition): string {
  return isChainDefinition(definition) ? definition.source.steps.map(step => step.name).join(' → ') : safeLocation(definition.source.location);
}
function planSteps(plan: ResourcePlan): SingleResourcePlan[] { return 'steps' in plan ? plan.steps : [plan]; }
function unapprovedUrls(plan: ResourcePlan): string[] {
  return planSteps(plan).flatMap(step => step.httpUrls.filter(url => !step.definition.approvedHttpUrls?.includes(url)));
}
function approveUrls(plan: ResourcePlan, urls: readonly string[], approved: boolean): void {
  for (const step of planSteps(plan)) {
    const relevant = urls.filter(url => step.httpUrls.includes(url));
    step.definition.approvedHttpUrls = approved
      ? [...new Set([...(step.definition.approvedHttpUrls ?? []), ...relevant])]
      : step.definition.approvedHttpUrls?.filter(url => !relevant.includes(url));
  }
}
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
  private definition: SingleSchemeDefinition;
  private overridesText: string;
  private sourceChoice: 'preset' | 'vault' | 'url' | 'chain';
  private chainDefinition: ChainSchemeDefinition;
  private chainSteps: { definition: SingleSchemeDefinition; snapshot: SingleSnapshot }[] = [];
  private chainInitialized = false;
  private preset: Preset = PRESETS[0];
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
    const draft = original ? host.store.getDraft(original.id) : null;
    const selected = draft ?? original;
    this.chainDefinition = selected && isChainDefinition(selected)
      ? structuredClone(selected)
      : { id: crypto.randomUUID(), name: '', source: { kind: 'chain', steps: [] } };
    this.definition = selected && !isChainDefinition(selected) ? structuredClone(selected) : { id: crypto.randomUUID(), name: '', source: { kind: 'vault', location: '' } };
    this.sourceChoice = selected ? selected.source.kind : 'preset';
    this.overridesText = JSON.stringify(this.definition.overrides ?? {}, null, 2);
    this.scope.register(['Mod'], 'Enter', () => { void this.submit(); return false; });
  }
  onOpen(): void {
    this.host.uiModals.add(this);
    this.setTitle(this.original ? t('modal.editTitle') : t('modal.addTitle'));
    if (this.sourceChoice === 'chain') void this.initializeChain().then(() => this.render(), error => this.contentEl.setText(safeError(error)));
    else this.render();
  }
  private async initializeChain(): Promise<void> {
    if (this.chainInitialized) return;
    this.chainInitialized = true;
    if (!this.original || !isChainDefinition(this.original)) return;
    const snapshot = await this.host.store.getActive(this.original.id);
    if (!('steps' in snapshot)) throw new PluginError('CACHE_INVALID', '转换链快照无效。');
    const steps = await splitChainSnapshot(this.chainDefinition, snapshot);
    this.chainSteps = this.chainDefinition.source.steps.map((definition, index) => ({ definition: structuredClone(definition), snapshot: steps[index]! }));
  }
  private render(): void {
    this.contentEl.empty();
    this.locationSetting = undefined; this.mappingSetting = undefined;
    const form = this.contentEl.createEl('form');
    form.addEventListener('submit', event => { event.preventDefault(); void this.submit(); });
    this.form = form.createDiv();
    new Setting(this.form).setName(t('field.source')).addDropdown(dropdown => {
      if (!this.original) dropdown.addOption('preset', t('official.title'));
      dropdown.addOptions({ vault: t('source.vault'), url: t('source.url'), chain: t('source.chain') }).setValue(this.sourceChoice).onChange(value => {
        this.sourceChoice = value as typeof this.sourceChoice;
        if (value === 'vault' || value === 'url') this.definition.source.kind = value;
        this.render();
      });
      dropdown.selectEl.setAttribute('aria-label', t('field.source'));
    });
    if (this.sourceChoice === 'preset') {
      new Setting(this.form).setName(t('official.preset')).addDropdown(dropdown => {
        for (const preset of PRESETS) dropdown.addOption(preset[0], `${t(preset[1])} (${preset[0]})`);
        dropdown.setValue(this.preset[0]).onChange(value => {
          this.preset = PRESETS.find(preset => preset[0] === value)!;
          this.officialDraft = undefined; this.render();
        });
        dropdown.selectEl.setAttribute('aria-label', t('official.preset'));
        dropdown.selectEl.dataset.openccPresets = '';
      });
    } else if (this.sourceChoice === 'chain') {
      this.renderChain(this.form);
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
    if (this.sourceChoice === 'preset') {
      const candidate = presetDefinition(this.preset[0], t(this.preset[1]));
      void Promise.all([schemeSourceKey(candidate), ...this.host.store.getDefinitions().map(schemeSourceKey)]).then(([key, ...existing]) => {
        if (this.primary.buttonEl.isConnected && existing.includes(key)) this.primary.setButtonText(t('official.added')).setDisabled(true);
      });
    }
  }
  private renderChain(container: HTMLElement): void {
    new Setting(container).setName(t('field.schemeName')).addText(text => {
      text.setPlaceholder(this.chainSteps.map(step => step.definition.name).join(' → ')).setValue(this.chainDefinition.name).onChange(value => { this.chainDefinition.name = value; });
      text.inputEl.setAttribute('aria-label', t('field.schemeName'));
    });
    container.createEl('p', { text: t('chain.desc'), cls: 'setting-item-description' });
    const active = this.host.store.getDefinitions().filter((definition): definition is SingleSchemeDefinition => !isChainDefinition(definition));
    for (const [index, step] of this.chainSteps.entries()) {
      const choices = new Map(active.map(definition => [definition.id, definition]));
      choices.set(step.definition.id, step.definition);
      const setting = new Setting(container).setName(t('chain.step', { count: index + 1 }));
      setting.addDropdown(dropdown => {
        for (const definition of choices.values()) dropdown.addOption(definition.id, definition.name);
        dropdown.setValue(step.definition.id).onChange(async id => {
          const definition = choices.get(id); if (!definition || this.busy) return;
          this.busy = true; dropdown.setDisabled(true);
          try {
            const snapshot = await this.host.store.getActive(definition.id);
            if ('steps' in snapshot) throw new PluginError('INVALID_CONFIG', t('chain.invalid'));
            this.chainSteps[index] = { definition: structuredClone(definition), snapshot };
            this.chainDefinition.source.steps = this.chainSteps.map(item => structuredClone(item.definition));
          } catch (error) { new Notice(safeError(error)); }
          finally { this.busy = false; if (!this.controller.signal.aborted) this.render(); }
        });
        dropdown.selectEl.dataset.openccChainStep = '';
        dropdown.selectEl.dataset.openccResolved = step.snapshot.schemeId;
        dropdown.selectEl.setAttribute('aria-label', t('chain.step', { count: index + 1 }));
      }).addExtraButton(button => {
        button.setIcon('arrow-up').setTooltip(t('chain.up')).setDisabled(index === 0).onClick(() => {
          [this.chainSteps[index - 1], this.chainSteps[index]] = [this.chainSteps[index]!, this.chainSteps[index - 1]!]; this.render();
        });
        button.extraSettingsEl.dataset.openccMoveUp = '';
      }).addExtraButton(button => {
        button.setIcon('arrow-down').setTooltip(t('chain.down')).setDisabled(index === this.chainSteps.length - 1).onClick(() => {
          [this.chainSteps[index], this.chainSteps[index + 1]] = [this.chainSteps[index + 1]!, this.chainSteps[index]!]; this.render();
        });
        button.extraSettingsEl.dataset.openccMoveDown = '';
      }).addExtraButton(button => {
        button.setIcon('trash-2').setTooltip(t('chain.remove')).onClick(() => { this.chainSteps.splice(index, 1); this.render(); });
        button.extraSettingsEl.dataset.openccRemoveStep = '';
      });
    }
    new Setting(container).addButton(button => {
      button.setButtonText(t('chain.add')).setDisabled(!active.length || this.chainSteps.length >= 16).onClick(async () => {
        if (this.busy || !active.length) return;
        this.busy = true; button.setDisabled(true);
        try {
          const definition = active[0]!;
          const snapshot = await this.host.store.getActive(definition.id);
          if ('steps' in snapshot) throw new PluginError('INVALID_CONFIG', t('chain.invalid'));
          this.chainSteps.push({ definition: structuredClone(definition), snapshot });
          this.chainDefinition.source.steps = this.chainSteps.map(item => structuredClone(item.definition));
        } catch (error) { new Notice(safeError(error)); }
        finally { this.busy = false; if (!this.controller.signal.aborted) this.render(); }
      });
      button.buttonEl.type = 'button'; button.buttonEl.dataset.openccAddStep = '';
    });
  }
  private message(text: string): void { this.status.setText(text); this.status.hidden = !text; }
  openPreview(): void {
    this.open();
    if (this.sourceChoice === 'chain') void this.initializeChain().then(() => this.prepare(true, this.chainDefinition));
    else void this.prepare(true);
  }
  private async submitChain(): Promise<void> {
    if (this.chainSteps.length < 2) { this.message(t('chain.invalid')); return; }
    const definition: ChainSchemeDefinition = structuredClone({
      ...this.chainDefinition,
      name: this.chainDefinition.name.trim() || this.chainSteps.map(step => step.definition.name).join(' → '),
      source: { kind: 'chain', steps: this.chainSteps.map(step => structuredClone(step.definition)) },
    });
    this.busy = true; this.lock(true);
    try {
      let snapshot: Snapshot;
      if (this.original && isChainDefinition(this.original) && await schemeSourceKey(definition) === await schemeSourceKey(this.original)) snapshot = await this.host.store.getActive(this.original.id);
      else snapshot = await combineSnapshots(definition, this.chainSteps.map(step => step.snapshot));
      await this.publish(definition, snapshot);
    } catch (error) { await this.failed(error, definition); }
    finally { this.busy = false; if (!this.publishing) this.lock(false); }
  }
  private async submit(): Promise<void> {
    if (this.busy || this.controller.signal.aborted || this.primary.buttonEl.disabled) return;
    if (this.reviewPlan) { await this.load(this.reviewPlan); return; }
    if (this.sourceChoice === 'chain') { await this.submitChain(); return; }
    if (this.sourceChoice === 'preset') {
      this.officialDraft ??= presetDefinition(this.preset[0], t(this.preset[1]));
      await this.prepare(false, this.officialDraft);
    } else await this.prepare();
  }
  private lock(locked: boolean): void {
    for (const field of this.form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea')) field.disabled = locked;
    this.primary.setDisabled(locked);
    if (!locked) this.form.querySelector<HTMLElement>('.is-invalid input, .is-invalid textarea')?.focus();
  }
  private captured(): SingleSchemeDefinition {
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
      if (!isChainDefinition(definition) && definition.source.kind === 'url' && /^http:/i.test(definition.source.location)) {
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
      if (review || plan.warnings.length || unapprovedUrls(plan).length) {
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
    const steps = planSteps(plan);
    this.previewEl.createEl('p', { text: t('preview.summary', { count: steps.reduce((count, step) => count + step.resources.length, 0) }) });
    const details = this.previewEl.createEl('details');
    details.createEl('summary', { text: t('preview.title') });
    const list = details.createEl('ul');
    for (const step of steps) {
      details.createEl('p', { text: t('preview.config', { location: safeLocation(step.configSource.location) }) });
      for (const resource of step.resources) list.createEl('li', { text: `${safeText(resource.originalRef)} → ${safeLocation(resource.source.location)} · ${resource.dictType}` });
    }
    for (const warning of plan.warnings) this.previewEl.createEl('p', { text: safeText(warning) });
    const unapproved = unapprovedUrls(plan);
    this.primary.setButtonText(t('action.load')).setDisabled(unapproved.length > 0);
    if (unapproved.length) {
      new Setting(this.previewEl).setName(t('http.resources')).setDesc(t('http.resourcesDesc', { locations: unapproved.map(safeLocation).join('; ') })).addToggle(toggle => {
        toggle.setValue(false).onChange(value => {
          if (this.busy) { toggle.setValue(!value); return; }
          approveUrls(plan, unapproved, value);
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
  getItemText(item: SchemeDefinition): string { return `${item.name} — ${schemeLocation(item)}`; }
  onChooseItem(item: SchemeDefinition): void { this.choose(item); }
  async onOpen(): Promise<void> { this.host.uiModals.add(this); await super.onOpen(); }
  onClose(): void { super.onClose(); this.host.uiModals.delete(this); }
}
