import { Notice, PluginSettingTab, Setting, type App, type Plugin, type SettingDefinitionItem } from 'obsidian';
import { SchemeEditModal, confirmAction, safeError, safeLocation, safeText, type SchemeHost } from './scheme-modal';
import type { RegionKind } from './selection/types';
import type { SchemeDefinition } from './schemes/model';
import { t } from './i18n';
import type { MessageKey } from './locales/en-GB';

const regionNames: Record<RegionKind, MessageKey> = {
  inlineCode: 'region.inlineCode', codeBlock: 'region.codeBlock', quote: 'region.quote', inlineMath: 'region.inlineMath', blockMath: 'region.blockMath', mathGroup: 'region.mathGroup',
};
export class ConverterSettingsTab extends PluginSettingTab {
  private readonly checks = new Set<AbortController>();
  private readonly host: SchemeHost;
  constructor(app: App, plugin: Plugin) { super(app, plugin); this.host = plugin as SchemeHost; }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const { host } = this;
    const definitions = host.store.getDefinitions();
    const drafts = host.store.getDrafts().filter(draft => !definitions.some(definition => definition.id === draft.id));
    const rules = host.store.getRules();
    return [
      { name: t('settings.title'), desc: t('settings.intro'), searchable: false, render: setting => { setting.setHeading(); } },
      { name: t('settings.default'), render: setting => {
        setting.addDropdown(dropdown => {
          dropdown.addOption('', t('settings.noDefault'));
          for (const definition of definitions) dropdown.addOption(definition.id, `${definition.name} — ${safeLocation(definition.source.location)}`);
          dropdown.setValue(host.store.getDefaultId() ?? ''); dropdown.selectEl.setAttribute('aria-label', t('settings.default'));
          dropdown.onChange(async value => {
            dropdown.setDisabled(true);
            try { await host.store.setDefault(value || null); }
            catch (error) { dropdown.setValue(host.store.getDefaultId() ?? ''); new Notice(safeError(error)); }
            finally { dropdown.setDisabled(false); }
          });
        });
      } },
      { name: t('settings.schemes'), desc: !definitions.length && !drafts.length ? t('settings.noSchemes') : undefined,
        render: setting => { setting.addButton(button => button.setButtonText(t('settings.addScheme')).setCta().onClick(() => new SchemeEditModal(host, undefined, () => this.update()).open())); } },
      ...[...definitions, ...drafts].map((definition): SettingDefinitionItem => ({
        type: 'group', items: [{ name: definition.name, desc: safeLocation(definition.source.location),
          render: setting => this.row(definition, definitions.some(item => item.id === definition.id), setting) }],
      })),
      { name: t('settings.regionRules'), desc: t('settings.regionHelp'), searchable: false, render: setting => { setting.setHeading(); } },
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
  private row(definition: SchemeDefinition, active: boolean, setting: Setting): () => void {
    const { host } = this;
    // The declarative renderer owns group children; custom content belongs to this setting.
    const row = setting.infoEl;
    row.setAttribute('data-scheme-id', definition.id);
    const status = host.store.getStatus(definition.id);
    const labels = { unloaded: active ? t('status.cached') : t('status.unloaded'), loading: t('status.loading'), ready: t('status.ready'), dirty: t('status.dirty'), stale: t('status.stale'), unavailable: t('status.unavailable') };
    setting.setDesc(`${safeLocation(definition.source.location)} · ${labels[status.kind]}`);
    if (status.error) row.createEl('p', { text: safeError(status.error) });
    for (const warning of status.warnings) row.createEl('p', { text: safeText(warning) });
    new Setting(row).addButton(button => button.setButtonText(t('action.edit')).onClick(() => new SchemeEditModal(host, definition, () => this.update()).open()))
      .addButton(button => button.setButtonText(t('action.refresh')).onClick(() => new SchemeEditModal(host, definition, () => this.update()).openPreview()))
      .addButton(button => button.setButtonText(t('action.delete')).onClick(async () => {
        button.setDisabled(true);
        try {
          if (!await confirmAction(host, t('delete.title'), t('delete.description', { name: definition.name }), t('delete.confirm'))) return;
          await host.store.remove(definition.id); host.lengthReports.delete(definition.id); host.syncSchemeCommands(); this.update();
        } catch (error) { new Notice(safeError(error)); }
        finally { button.setDisabled(false); }
      }));
    const reportEl = row.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const renderReport = () => {
      reportEl.empty();
      const report = host.lengthReports.get(definition.id);
      if (!report) { reportEl.setText(t('length.none')); return; }
      if (report.snapshotId !== host.store.getStatus(definition.id).snapshotId) { reportEl.setText(t('length.expired')); return; }
      const reportStatus = { equal: t('length.equal'), risk: t('length.risk'), incomplete: t('length.incomplete') }[report.status];
      reportEl.createEl('p', { text: t('length.summary', { status: reportStatus, snapshot: report.snapshotId, count: report.checkedEntries }) });
      for (const reason of report.reasons) reportEl.createEl('p', { text: safeText(reason) });
      for (const risk of report.risks.slice(0, 20)) reportEl.createEl('p', { text: `${risk.stagePath} / ${risk.dictPath}：${risk.key} → ${risk.defaultValue}（${risk.inputLength} → ${risk.outputLength}）` });
      if (report.risks.length > 20) reportEl.createEl('p', { text: t('length.more', { count: report.risks.length }) });
    };
    renderReport();
    let controller: AbortController | undefined;
    new Setting(row).addButton(button => button.setButtonText(t('length.check')).setDisabled(!active).onClick(async () => {
      if (controller) return;
      controller = new AbortController(); const running = controller; this.checks.add(running); button.setDisabled(true); reportEl.setText(t('length.checking'));
      try {
        const snapshot = await host.store.getActive(definition.id);
        if (running.signal.aborted) return;
        const report = await host.engine.checkLengths(snapshot, running.signal);
        if (running.signal.aborted) return;
        host.lengthReports.set(definition.id, report); renderReport();
      } catch (error) { if (!running.signal.aborted) reportEl.setText(safeError(error)); }
      finally { this.checks.delete(running); controller = undefined; button.setDisabled(false); }
    })).addButton(button => button.setButtonText(t('length.cancel')).onClick(() => { controller?.abort(); reportEl.setText(t('length.cancelled')); }));
    return () => { if (controller) { controller.abort(); this.checks.delete(controller); } };
  }
  hide(): void { for (const controller of this.checks) controller.abort(); this.checks.clear(); }
}
