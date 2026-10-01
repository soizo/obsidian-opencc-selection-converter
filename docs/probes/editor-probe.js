// Throwaway editor API verification; no plugin implementation.
(async () => {
  if (app.vault.getName() !== 'OpenCC-Selection-Converter-Test') throw new Error('Wrong vault');
  const view = app.workspace.activeLeaf.view;
  if (view.file?.path !== 'Syntax-Probe.md') throw new Error('Wrong fixture');
  const results = [];
  for (const source of [false, true]) {
    await view.setState({...view.getState(), mode:'source', source}, {history:false});
    const editor = view.editor;
    const before = editor.getValue();
    const start = before.indexOf('软**件**');
    if (start < 0) throw new Error('Fixture missing');
    editor.setSelection(editor.offsetToPos(start), editor.offsetToPos(start+6));
    const tx = {changes:[
      {from:editor.offsetToPos(start),to:editor.offsetToPos(start+1),text:'軟'},
      {from:editor.offsetToPos(start+3),to:editor.offsetToPos(start+4),text:'體'}
    ]};
    editor.transaction(tx, 'opencc-feasibility');
    const expected = before.slice(0,start)+'軟**體**'+before.slice(start+6);
    if (editor.getValue() !== expected) throw new Error('Unexpected transaction output');
    editor.undo();
    if (editor.getValue() !== before) throw new Error('Single undo did not restore exact source');
    editor.redo();
    if (editor.getValue() !== expected) throw new Error('Redo mismatch');
    editor.undo();
    results.push({mode:source?'source':'live-preview',multiChange:true,outsideSelectionUnchanged:true,undo:true,redo:true});
  }
  await view.setState({...view.getState(),source:false}, {history:false});
  return results;
})()
