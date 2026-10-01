// Throwaway feasibility probe. Run only via Obsidian CLI in the dedicated vault.
(async () => {
  if (app.vault.getName() !== 'OpenCC-Selection-Converter-Test') throw new Error('Wrong vault');
  const fs = require('fs');
  const workDir = globalThis.openccProbeRoot;
  if (typeof workDir !== 'string') throw new Error('Set openccProbeRoot to the extracted package directory parent');
  const root = workDir + '/package/dist';
  let config;
  try { config = JSON.parse(fs.readFileSync(root + '/data/config/s2twp.json', 'utf8')); }
  catch (cause) { throw new Error('Cannot read probe configuration', {cause}); }
  const names = new Set();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.file === 'string') names.add(value.file);
    Object.values(value).forEach(collect);
  }
  collect(config);
  const files = [...names].map(name => [name, new Uint8Array(fs.readFileSync(root + '/data/dict/' + name))]);
  const runWorker = async function (event) {
    let moduleUrl;
    try {
      self.fetch = () => { throw new Error('Network disabled in engine probe'); };
      self.XMLHttpRequest = class { constructor() { throw new Error('Network disabled in engine probe'); } };
      // Electron exposes Node in Workers; this private Worker uses browser APIs only.
      globalThis.process = undefined;
      moduleUrl = URL.createObjectURL(new Blob([event.data.loader], {type: 'text/javascript'}));
      const create = (await import(moduleUrl)).default;
      const mod = await create({wasmBinary: event.data.wasm, locateFile: () => 'opencc-wasm.wasm', printErr: () => {}});
      mod.FS.mkdir('/probe');
      mod.FS.chdir('/probe');
      mod.FS.mkdir('dicts');
      event.data.files.forEach(([name, bytes]) => mod.FS.writeFile(name, bytes));
      function withUtf8(text, call) {
        const bytes = mod.lengthBytesUTF8(text) + 1;
        const pointer = mod._malloc(bytes);
        if (!pointer) throw new Error('Input allocation failed');
        try { mod.stringToUTF8(text, pointer, bytes); return call(pointer); }
        finally { mod._free(pointer); }
      }
      const open = path => withUtf8(path, pointer => mod._opencc_create(pointer));
      const convert = (handle, text) => withUtf8(text, pointer => mod.UTF8ToString(mod._opencc_convert(handle, pointer)));
      const inspect = (handle, text) => withUtf8(text, pointer => mod.UTF8ToString(mod._opencc_inspect(handle, pointer)));
      const close = handle => mod._opencc_destroy(handle);
      const results = [];
      function check(name, fn) {
        try { results.push({name, pass: true, result: fn()}); }
        catch (e) { results.push({name, pass: false, error: String(e)}); }
      }
      function equal(actual, expected) {
        if (actual !== expected) throw new Error(JSON.stringify({expected, actual}));
        return actual;
      }
      function withConfig(name, cfg, fn) {
        mod.FS.writeFile(name + '.json', JSON.stringify(cfg));
        const handle = open('/probe/' + name + '.json');
        if (handle < 0) throw new Error('Invalid converter handle');
        try { return fn(handle); } finally { close(handle); }
      }
      check('official-ocd2-offline', () => withConfig('official', event.data.config, h => equal(convert(h, '服务器软件'), '伺服器軟體')));
      check('official-inspection-pipeline', () => withConfig('trace', event.data.config, h => {
        const trace = JSON.parse(inspect(h, '服务器软件'));
        equal(trace.output, '伺服器軟體');
        return {output:trace.output, pipelineStages:trace.pipelineStages?.length, segments:trace.segments};
      }));
      mod.FS.writeFile('dicts/one.txt', '软件\t軟件\n[\t【\n]\t】\n甲乙\t丙\n');
      mod.FS.writeFile('dicts/two.txt', '軟件\t軟體\n');
      const custom = {name:'relative text chain', segmentation:{type:'mmseg',dict:{type:'text',file:'dicts/one.txt'}},conversion_chain:[{dict:{type:'text',file:'dicts/one.txt'}},{dict:{type:'text',file:'dicts/two.txt'}}]};
      check('custom-relative-text-chain', () => withConfig('custom', custom, h => equal(convert(h, '[软件]\n甲乙'), '【軟體】\n丙')));
      check('custom-inspection-length-change', () => withConfig('custom-trace', custom, h => {
        const trace = JSON.parse(inspect(h, '软件甲乙'));
        equal(trace.output, '軟體丙');
        return trace;
      }));
      check('inline-normalization', () => withConfig('normalization', {name:'normalization',normalization:[{dict:{type:'inline',entries:{'Ａ':'甲'}}}],conversion_chain:[{dict:{type:'inline',entries:{'甲':'乙'}}}]}, h => equal(convert(h,'Ａ'),'乙')));
      check('group-priority', () => withConfig('group', {name:'group',conversion_chain:[{dict:{type:'group',match_policy:'short_circuit',dicts:[{type:'inline',entries:{'甲':'乙'}},{type:'inline',entries:{'甲':'丙'}}]}}]}, h => equal(convert(h,'甲'),'乙')));
      check('missing-dictionary-rejected', () => {
        try { withConfig('missing', {name:'missing',conversion_chain:[{dict:{type:'text',file:'missing.txt'}}]}, () => {}); }
        catch(e) { return String(e); }
        throw new Error('Missing dictionary was accepted');
      });
      check('unknown-dictionary-rejected', () => {
        try { withConfig('unknown', {name:'unknown',conversion_chain:[{dict:{type:'invented',file:'dicts/one.txt'}}]}, () => {}); }
        catch(e) { return String(e); }
        throw new Error('Unknown dictionary was accepted');
      });
      check('mixed-newlines-preserved', () => withConfig('newlines', custom, h => equal(convert(h, '软件\r\n软件\n软件\r'), '軟體\r\n軟體\n軟體\r')));
      check('long-input-50000-codepoints', () => withConfig('long', custom, h => {
        const input = '软件'.repeat(25000);
        const start = performance.now();
        equal(convert(h, input), '軟體'.repeat(25000));
        return {characters:50000,milliseconds:Math.round(performance.now()-start)};
      }));
      check('equal-total-can-hide-internal-shift', () => withConfig('shift', {name:'shift',conversion_chain:[{dict:{type:'inline',entries:{'甲':'甲乙','丙丁':'丙'}}}]}, h => {
        const trace = JSON.parse(inspect(h, '甲丙丁'));
        equal(trace.output,'甲乙丙');
        if ([...trace.input].length !== [...trace.output].length) throw new Error('Expected equal total length');
        return trace;
      }));
      check('unknown-option-observation', () => withConfig('option', {name:'option',unsupported_option:true,conversion_chain:[{dict:{type:'inline',entries:{'甲':'乙'}}}]}, h => ({accepted:convert(h,'甲')==='乙',requiresHostValidation:true})));
      self.postMessage({results, pass: results.every(r => r.pass), network: 'fetch-and-xhr-disabled', runtime: {node: typeof process, worker: typeof Worker}});
    } catch (e) { self.postMessage({fatal: String(e)}); }
    finally { if (moduleUrl) URL.revokeObjectURL(moduleUrl); }
  };
  const workerUrl = URL.createObjectURL(new Blob(['self.onmessage=' + runWorker.toString()], {type:'text/javascript'}));
  const worker = new Worker(workerUrl, {type:'module'});
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Probe timed out')), 20000);
      worker.onmessage = e => { clearTimeout(timer); resolve(e.data); };
      worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
      worker.postMessage({loader:fs.readFileSync(root+'/esm/opencc-wasm.js','utf8'),wasm:new Uint8Array(fs.readFileSync(root+'/esm/opencc-wasm.wasm')),config,files});
    });
    fs.writeFileSync(workDir + '/engine-probe-result.json', JSON.stringify(result,null,2));
    return result;
  } finally { worker.terminate(); URL.revokeObjectURL(workerUrl); }
})()
