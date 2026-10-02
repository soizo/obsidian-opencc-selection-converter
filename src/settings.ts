import { Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
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
  display(): void {
    this.hide();
    const { containerEl: root, host } = this;
    root.empty(); root.createEl('h2', { text: t('settings.title') });
    root.createEl('p', { text: t('settings.intro') });
    const definitions = host.store.getDefinitions();
    new Setting(root).setName(t('settings.default')).addDropdown(dropdown => {
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
    new Setting(root).setName(t('settings.schemes')).addButton(button => button.setButtonText(t('settings.addScheme')).setCta().onClick(() => new SchemeEditModal(host, undefined, () => this.display()).open()));
    const drafts = host.store.getDrafts().filter(draft => !definitions.some(definition => definition.id === draft.id));
    if (!definitions.length && !drafts.length) root.createEl('p', { text: t('settings.noSchemes') });
    for (const definition of [...definitions, ...drafts]) this.row(definition, definitions.some(item => item.id === definition.id));
    root.createEl('h3', { text: t('settings.regionRules') });
    root.createEl('p', { text: t('settings.regionHelp') });
    const rules = host.store.getRules();
    for (const kind of Object.keys(regionNames) as RegionKind[]) {
      new Setting(root).setName(t(regionNames[kind])).addDropdown(dropdown => {
        dropdown.addOptions({ always: t('policy.always'), inside: t('policy.inside'), never: t('policy.never') }).setValue(rules.regions[kind]);
        dropdown.selectEl.setAttribute('aria-label', t(regionNames[kind]));
        dropdown.onChange(async value => {
          rules.regions[kind] = value as 'always' | 'inside' | 'never';
          try { await host.store.saveRules(rules); } catch (error) { new Notice(safeError(error)); this.display(); }
        });
      });
    }
    new Setting(root).setName(t('settings.force')).setDesc(t('settings.forceDesc')).addToggle(toggle => {
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
  }
  private row(definition: SchemeDefinition, active: boolean): void {
    const { host } = this;
    const row = this.containerEl.createDiv({ attr: { 'data-scheme-id': definition.id } });
    const status = host.store.getStatus(definition.id);
    const labels = { unloaded: active ? t('status.cached') : t('status.unloaded'), loading: t('status.loading'), ready: t('status.ready'), dirty: t('status.dirty'), stale: t('status.stale'), unavailable: t('status.unavailable') };
    new Setting(row).setName(definition.name).setDesc(`${safeLocation(definition.source.location)} · ${labels[status.kind]}`);
    if (status.error) row.createEl('p', { text: safeError(status.error) });
    for (const warning of status.warnings) row.createEl('p', { text: safeText(warning) });
    new Setting(row).addButton(button => button.setButtonText(t('action.edit')).onClick(() => new SchemeEditModal(host, definition, () => this.display()).open()))
      .addButton(button => button.setButtonText(t('action.refresh')).onClick(() => new SchemeEditModal(host, definition, () => this.display()).openPreview()))
      .addButton(button => button.setButtonText(t('action.delete')).onClick(async () => {
        button.setDisabled(true);
        try {
          if (!await confirmAction(host, t('delete.title'), t('delete.description', { name: definition.name }), t('delete.confirm'))) return;
          await host.store.remove(definition.id); host.lengthReports.delete(definition.id); host.syncSchemeCommands(); this.display();
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
  }
  hide(): void { for (const controller of this.checks) controller.abort(); this.checks.clear(); }
}
