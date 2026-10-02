import { Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { SchemeEditModal, confirmAction, safeError, safeLocation, safeText, type SchemeHost } from './scheme-modal';
import type { RegionKind } from './selection/types';
import type { SchemeDefinition } from './schemes/model';

const regionNames: Record<RegionKind, string> = {
  inlineCode: '行内代码', codeBlock: '代码块', quote: '引用', inlineMath: '行内数学', blockMath: '块数学', mathGroup: '数学子组与参数',
};
export class ConverterSettingsTab extends PluginSettingTab {
  private readonly checks = new Set<AbortController>();
  private readonly host: SchemeHost;
  constructor(app: App, plugin: Plugin) { super(app, plugin); this.host = plugin as SchemeHost; }
  display(): void {
    this.hide();
    const { containerEl: root, host } = this;
    root.empty(); root.createEl('h2', { text: 'OpenCC 选区转换' });
    root.createEl('p', { text: '只转换当前可见选区，保留链接目标和选区外内容。笔记不上传；快捷键由 Obsidian 的「快捷键」设置管理。' });
    const definitions = host.store.getDefinitions();
    new Setting(root).setName('默认方案').addDropdown(dropdown => {
      dropdown.addOption('', '无默认方案');
      for (const definition of definitions) dropdown.addOption(definition.id, `${definition.name} — ${safeLocation(definition.source.location)}`);
      dropdown.setValue(host.store.getDefaultId() ?? ''); dropdown.selectEl.setAttribute('aria-label', '默认方案');
      dropdown.onChange(async value => {
        dropdown.setDisabled(true);
        try { await host.store.setDefault(value || null); }
        catch (error) { dropdown.setValue(host.store.getDefaultId() ?? ''); new Notice(safeError(error)); }
        finally { dropdown.setDisabled(false); }
      });
    });
    new Setting(root).setName('方案').addButton(button => button.setButtonText('添加方案').setCta().onClick(() => new SchemeEditModal(host, undefined, () => this.display()).open()));
    const drafts = host.store.getDrafts().filter(draft => !definitions.some(definition => definition.id === draft.id));
    if (!definitions.length && !drafts.length) root.createEl('p', { text: '还没有方案。添加配置 URL 或库内 JSON 文件，预览字典依赖后再加载。' });
    for (const definition of [...definitions, ...drafts]) this.row(definition, definitions.some(item => item.id === definition.id));
    root.createEl('h3', { text: '区域策略' });
    root.createEl('p', { text: '判断依据是原始完整选区。父区域不允许转换时，子区域也不会转换。' });
    const rules = host.store.getRules();
    for (const kind of Object.keys(regionNames) as RegionKind[]) {
      new Setting(root).setName(regionNames[kind]).addDropdown(dropdown => {
        dropdown.addOptions({ always: '始终转换', inside: '仅选区完全位于区域内', never: '永不转换' }).setValue(rules.regions[kind]);
        dropdown.selectEl.setAttribute('aria-label', regionNames[kind]);
        dropdown.onChange(async value => {
          rules.regions[kind] = value as 'always' | 'inside' | 'never';
          try { await host.store.saveRules(rules); } catch (error) { new Notice(safeError(error)); this.display(); }
        });
      });
    }
    new Setting(root).setName('强制模式').setDesc('默认关闭。开启后允许长度变化，词组输出继承起始格式；仍拒绝不安全的源码映射。').addToggle(toggle => {
      toggle.setValue(rules.force); toggle.toggleEl.setAttribute('aria-label', '强制模式');
      toggle.onChange(async value => {
        toggle.setDisabled(true);
        try {
          if (value && !await confirmAction(host, '开启强制模式？', '允许不等长替换。跨格式词组可能丢失后续格式；不会放宽选区外源码、链接目标和结构保护。', '开启强制模式')) { toggle.setValue(false); return; }
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
    const labels = { unloaded: active ? '已缓存（待验证）' : '未加载', loading: '加载中', ready: '已就绪', dirty: '来源已变化（仍使用缓存）', stale: '使用旧缓存（刷新失败）', unavailable: '不可用' };
    new Setting(row).setName(definition.name).setDesc(`${safeLocation(definition.source.location)} · ${labels[status.kind]}`);
    if (status.error) row.createEl('p', { text: safeError(status.error) });
    for (const warning of status.warnings) row.createEl('p', { text: safeText(warning) });
    new Setting(row).addButton(button => button.setButtonText('编辑').onClick(() => new SchemeEditModal(host, definition, () => this.display()).open()))
      .addButton(button => button.setButtonText('刷新').onClick(() => new SchemeEditModal(host, definition, () => this.display()).openPreview()))
      .addButton(button => button.setButtonText('删除').onClick(async () => {
        button.setDisabled(true);
        try {
          if (!await confirmAction(host, '删除方案？', `删除「${definition.name}」及其缓存引用，不删除来源文件。若它是默认方案，默认项将清空。`, '确认删除')) return;
          await host.store.remove(definition.id); host.lengthReports.delete(definition.id); host.syncSchemeCommands(); this.display();
        } catch (error) { new Notice(safeError(error)); }
        finally { button.setDisabled(false); }
      }));
    const reportEl = row.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const renderReport = () => {
      reportEl.empty();
      const report = host.lengthReports.get(definition.id);
      if (!report) { reportEl.setText('尚未进行等长检查。'); return; }
      if (report.snapshotId !== host.store.getStatus(definition.id).snapshotId) { reportEl.setText('检查已过期，请重新检查。'); return; }
      reportEl.createEl('p', { text: `${{ equal: '检查完整：等长', risk: '存在长度风险', incomplete: '检查不完整' }[report.status]} · 快照 ${report.snapshotId} · 已检查 ${report.checkedEntries} 项` });
      for (const reason of report.reasons) reportEl.createEl('p', { text: safeText(reason) });
      for (const risk of report.risks.slice(0, 20)) reportEl.createEl('p', { text: `${risk.stagePath} / ${risk.dictPath}：${risk.key} → ${risk.defaultValue}（${risk.inputLength} → ${risk.outputLength}）` });
      if (report.risks.length > 20) reportEl.createEl('p', { text: `仅显示前 20 项，共 ${report.risks.length} 项风险。` });
    };
    renderReport();
    let controller: AbortController | undefined;
    new Setting(row).addButton(button => button.setButtonText('等长检查').setDisabled(!active).onClick(async () => {
      if (controller) return;
      controller = new AbortController(); const running = controller; this.checks.add(running); button.setDisabled(true); reportEl.setText('检查中…');
      try {
        const snapshot = await host.store.getActive(definition.id);
        if (running.signal.aborted) return;
        const report = await host.engine.checkLengths(snapshot, running.signal);
        if (running.signal.aborted) return;
        host.lengthReports.set(definition.id, report); renderReport();
      } catch (error) { if (!running.signal.aborted) reportEl.setText(safeError(error)); }
      finally { this.checks.delete(running); controller = undefined; button.setDisabled(false); }
    })).addButton(button => button.setButtonText('取消检查').onClick(() => { controller?.abort(); reportEl.setText('检查已取消，不代表等长。'); }));
  }
  hide(): void { for (const controller of this.checks) controller.abort(); this.checks.clear(); }
}
