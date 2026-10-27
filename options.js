const SAMPLE = {
  itemId: '6a833274cc252675a0041033',
  name: 'HH-0019-71',
  description: 'Cipher, Archon Type B w/ Enigma, Right handed',
};
const DEFAULTS = { printerName: '', browserFallback: true, rotate: 0, template: '' };

const $ = (id) => document.getElementById(id);

function save(patch) {
  return chrome.storage.sync.set(patch);
}

async function loadPrinters(selected) {
  const select = $('printer');
  const status = $('printerStatus');
  status.textContent = 'Looking for DYMO Connect…';
  status.className = 'hint';
  const res = await chrome.runtime.sendMessage({ type: 'printers' });
  select.length = 1;
  if (!res.ok) {
    status.textContent = res.error;
    status.className = 'hint err';
  } else {
    for (const p of res.printers) {
      select.add(new Option(`${p.name}${p.connected ? '' : ' (not connected)'}`, p.name));
    }
    status.textContent = res.printers.length ? `DYMO Connect found ${res.printers.length} printer(s).` : 'DYMO Connect is running but sees no printers.';
    status.className = res.printers.length ? 'hint ok' : 'hint err';
  }
  if (selected && ![...select.options].some((o) => o.value === selected)) {
    select.add(new Option(`${selected} (not found)`, selected));
  }
  select.value = selected || '';
}

function preview() {
  HHLabel.render($('preview'), SAMPLE);
}

async function testPrint() {
  const status = $('status');
  status.textContent = 'Printing…';
  status.className = '';
  const { rotate } = await chrome.storage.sync.get(DEFAULTS);
  const png = HHLabel.rotated(HHLabel.render(document.createElement('canvas'), SAMPLE), rotate)
    .toDataURL('image/png').split(',')[1];
  const res = await chrome.runtime.sendMessage({ type: 'print', png });
  status.textContent = res.ok ? `Sent to ${res.printer}` : res.error;
  status.className = res.ok ? 'ok' : 'err';
}

(async function init() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  $('browserFallback').checked = settings.browserFallback;
  $('rotate').value = String(settings.rotate);
  $('template').value = settings.template;

  await HHLabel.loadFont(() => fetch('fonts/Jost-700-Bold.otf').then((r) => r.arrayBuffer()));
  preview();
  loadPrinters(settings.printerName);

  $('printer').addEventListener('change', (e) => save({ printerName: e.target.value }));
  $('refresh').addEventListener('click', () => loadPrinters($('printer').value));
  $('browserFallback').addEventListener('change', (e) => save({ browserFallback: e.target.checked }));
  $('rotate').addEventListener('change', (e) => save({ rotate: Number(e.target.value) }));
  $('template').addEventListener('change', (e) => save({ template: e.target.value }));
  $('showDefault').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'defaultTemplate' });
    $('template').value = res.template;
    save({ template: '' });
  });
  $('test').addEventListener('click', testPrint);
})();
