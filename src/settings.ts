import { ButtonComponent, Menu, Modal, Notice, PluginSettingTab, type App, type Plugin, type Setting, type SettingDefinitionItem } from 'obsidian';
import { SchemeEditModal, confirmAction, safeError, safeLocation, safeText, type SchemeHost } from './scheme-modal';
import type { RegionKind } from './selection/types';
import type { SchemeDefinition } from './schemes/model';
import { t } from './i18n';
import type { MessageKey } from './locales/en-GB';

const regionNames: Record<RegionKind, MessageKey> = {
  inlineCode: 'region.inlineCode', codeBlock: 'region.codeBlock', quote: 'region.quote', inlineMath: 'region.inlineMath', blockMath: 'region.blockMath', mathGroup: 'region.mathGroup',
};
const lengthLabels = { equal: 'length.equal', risk: 'length.risk', incomplete: 'length.incomplete' } as const;

export class ConverterSettingsTab extends PluginSettingTab {
  private readonly host: SchemeHost;
  constructor(app: App, plugin: Plugin) { super(app, plugin); this.host = plugin as SchemeHost; }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const { host } = this;
    const definitions = host.store.getDefinitions();
    const drafts = host.store.getDrafts().filter(draft => !definitions.some(definition => definition.id === draft.id));
    const rules = host.store.getRules();
    return [
      { name: t('settings.schemes'), desc: !definitions.length && !drafts.length ? t('settings.noSchemes') : undefined,
        render: setting => { setting.addButton(button => button.setButtonText(t('settings.addScheme')).setCta().onClick(() => new SchemeEditModal(host, undefined, () => this.update()).open())); } },
      { name: t('settings.default'), render: setting => {
        setting.addDropdown(dropdown => {
          dropdown.addOption('', t('settings.noDefault'));
          for (const definition of definitions) dropdown.addOption(definition.id, definition.name);
          dropdown.setValue(host.store.getDefaultId() ?? '').setDisabled(!definitions.length);
          dropdown.selectEl.setAttribute('aria-label', t('settings.default'));
          dropdown.onChange(async value => {
            dropdown.setDisabled(true);
            try { await host.store.setDefault(value || null); }
            catch (error) { dropdown.setValue(host.store.getDefaultId() ?? ''); new Notice(safeError(error)); }
            finally { dropdown.setDisabled(false); }
          });
        });
      } },
      ...[...definitions, ...drafts].map((definition): SettingDefinitionItem => ({
        name: definition.name, render: setting => this.row(definition, definitions.some(item => item.id === definition.id), setting),
      })),
      { name: t('settings.regionRules'), searchable: false, render: setting => { setting.setHeading(); } },
      ...(Object.keys(regionNames) as RegionKind[]).map((kind): SettingDefinitionItem => ({
        name: t(regionNames[kind]), render: setting => {
          setting.addDropdown(dropdown => {
            dropdown.addOptions({ always: t('policy.always'), inside: t('policy.inside'), never: t('policy.never') }).setValue(rules.regions[kind]);
            dropdown.selectEl.setAttribute('aria-label', t(regionNames[kind]));
            dropdown.onChange(async value => {
              rules.regions[kind] = value as 'always' | 'inside' | 'never';
              try { await host.store.saveRules(rules); } catch (error) { new Notice(safeError(error)); this.update(); }
            });
          });
        },
      })),
      { name: t('settings.force'), desc: t('settings.forceDesc'), render: setting => {
        setting.addToggle(toggle => {
          toggle.setValue(rules.force); toggle.toggleEl.setAttribute('aria-label', t('settings.force'));
          toggle.onChange(async value => {
            toggle.setDisabled(true);
            try {
              if (value && !await confirmAction(host, t('settings.forceTitle'), t('settings.forceWarning'), t('settings.enableForce'))) { toggle.setValue(false); return; }
              rules.force = value; await host.store.saveRules(rules);
            } catch (error) { toggle.setValue(host.store.getRules().force); new Notice(safeError(error)); }
            finally { toggle.setDisabled(false); }
          });
        });
      } },
    ];
  }
  private row(definition: SchemeDefinition, active: boolean, setting: Setting): void {
    const { host } = this;
    setting.settingEl.setAttribute('data-scheme-id', definition.id);
    const status = host.store.getStatus(definition.id);
    const labels = { unloaded: active ? t('status.cached') : t('status.unloaded'), loading: t('status.loading'), ready: t('status.ready'), dirty: t('status.dirty'), stale: t('status.stale'), unavailable: t('status.unavailable') };
    const report = host.lengthReports.get(definition.id);
    let audit = '';
    if (report) audit = report.snapshotId === status.snapshotId ? t(lengthLabels[report.status]) : t('length.expired');
    setting.setDesc([labels[status.kind], audit].filter(Boolean).join(' · '));
    if (status.error || status.warnings.length) {
      const details = setting.descEl.createEl('details');
      details.createEl('summary', { text: t('action.details') });
      if (status.error) details.createEl('p', { text: safeError(status.error) });
      for (const warning of status.warnings) details.createEl('p', { text: safeText(warning) });
    }
    setting.addButton(button => button.setButtonText(t('action.edit')).onClick(() => new SchemeEditModal(host, definition, () => this.update()).open()))
      .addExtraButton(button => {
        button.setIcon('more-horizontal').setTooltip(t('action.more')).onClick(() => {
          const menu = new Menu().setUseNativeMenu(false);
          menu.addItem(item => item.setTitle(t('action.refresh')).setIcon('refresh-cw').onClick(() => new SchemeEditModal(host, definition, () => this.update()).openPreview()));
          menu.addItem(item => item.setTitle(t('length.check')).setIcon('scan-text').setDisabled(!active).onClick(() => new LengthCheckModal(host, definition, () => { if (this.containerEl.isConnected) this.update(); }).open()));
          menu.addSeparator();
          menu.addItem(item => item.setTitle(t('action.delete')).setIcon('trash-2').setWarning(true).onClick(async () => {
            try {
              if (!await confirmAction(host, t('delete.title'), t('delete.description', { name: definition.name }), t('delete.confirm'))) return;
              await host.store.remove(definition.id); host.lengthReports.delete(definition.id); host.syncSchemeCommands(); this.update();
            } catch (error) { new Notice(safeError(error)); }
          }));
          const bounds = button.extraSettingsEl.getBoundingClientRect();
          menu.showAtPosition({ x: bounds.right, y: bounds.bottom }, button.extraSettingsEl.ownerDocument);
        });
        button.extraSettingsEl.dataset.openccMore = '';
        button.extraSettingsEl.setAttribute('aria-label', t('action.more'));
      });
  }
}

class LengthCheckModal extends Modal {
  private controller?: AbortController;
  private reportEl!: HTMLElement;
  private check!: ButtonComponent;
  private cancel!: ButtonComponent;
  constructor(private readonly host: SchemeHost, private readonly definition: SchemeDefinition, private readonly changed: () => void) { super(host.app); }
  onOpen(): void {
    this.host.uiModals.add(this);
    this.modalEl.addClass('opencc-modal');
    this.setTitle(`${t('length.check')} · ${this.definition.name}`);
    this.reportEl = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const footer = this.contentEl.createDiv({ cls: 'modal-button-container' });
    this.cancel = new ButtonComponent(footer).setButtonText(t('action.close')).onClick(() => {
      if (this.controller) { this.controller.abort(); this.reportEl.setText(t('length.cancelled')); }
      else this.close();
    });
    this.check = new ButtonComponent(footer).setButtonText(t('length.check')).setCta().onClick(() => { void this.run(); });
    void this.run();
  }
  private async run(): Promise<void> {
    if (this.controller) return;
    const controller = new AbortController(); this.controller = controller;
    this.check.setDisabled(true); this.cancel.setButtonText(t('length.cancel')); this.reportEl.setText(t('length.checking'));
    try {
      const snapshot = await this.host.store.getActive(this.definition.id);
      if (controller.signal.aborted) return;
      const report = await this.host.engine.checkLengths(snapshot, controller.signal);
      if (controller.signal.aborted) return;
      this.host.lengthReports.set(this.definition.id, report);
      this.reportEl.empty();
      this.reportEl.createEl('p', { text: t(lengthLabels[report.status]) });
      const details = this.reportEl.createEl('details');
      details.createEl('summary', { text: t('action.details') });
      details.createEl('p', { text: t('length.summary', { status: t(lengthLabels[report.status]), snapshot: report.snapshotId, count: report.checkedEntries }) });
      details.createEl('p', { text: safeLocation(this.definition.source.location) });
      for (const reason of report.reasons) details.createEl('p', { text: safeText(reason) });
      for (const risk of report.risks.slice(0, 20)) details.createEl('p', { text: `${risk.stagePath} / ${risk.dictPath}：${risk.key} → ${risk.defaultValue}（${risk.inputLength} → ${risk.outputLength}）` });
      if (report.risks.length > 20) details.createEl('p', { text: t('length.more', { count: report.risks.length }) });
      this.changed();
    } catch (error) { if (!controller.signal.aborted) this.reportEl.setText(safeError(error)); }
    finally { this.controller = undefined; this.check.setDisabled(false); this.cancel.setButtonText(t('action.close')); }
  }
  onClose(): void { this.controller?.abort(); this.host.uiModals.delete(this); this.contentEl.empty(); }
}
