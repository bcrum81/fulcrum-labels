// Talks to the DYMO Connect web service that DYMO Connect for Desktop installs
// on the PC (https://127.0.0.1:41951-41960). Printing through it is silent:
// no print dialog, no printer picker.

const DYMO_PORTS = [41951, 41952, 41953, 41954, 41955, 41956, 41957, 41958, 41959, 41960];
const DYMO_HOSTS = ['127.0.0.1', 'localhost'];
let dymoBase = null;

// DYMO 30334 (2-1/4" x 1-1/4") with one image covering the whole label.
// {{IMAGE}} is replaced by the base64 PNG. Can be overridden on the options
// page with a template exported from DYMO Connect.
//
// DYMO lays this label out in feed direction: 1800 twips (1.25") across,
// 3240 (2.25") long. Bounds must use those dimensions — 3240 x 1800 gets
// clipped to a 1800 x 1800 square and the image is squashed into the leading
// half of the label. The landscape PNG is turned to fit with Rotation270,
// checked against DYMO Connect's RenderLabel preview.
const DEFAULT_TEMPLATE = `<?xml version="1.0" encoding="utf-8"?>
<DieCutLabel Version="8.0" Units="twips">
  <PaperOrientation>Landscape</PaperOrientation>
  <Id>Small30334</Id>
  <PaperName>30334 2-1/4 in x 1-1/4 in</PaperName>
  <DrawCommands>
    <RoundRectangle X="0" Y="0" Width="1800" Height="3240" Rx="270" Ry="270" />
  </DrawCommands>
  <ObjectInfo>
    <ImageObject>
      <Name>LABEL</Name>
      <ForeColor Alpha="255" Red="0" Green="0" Blue="0" />
      <BackColor Alpha="0" Red="255" Green="255" Blue="255" />
      <LinkedObjectName></LinkedObjectName>
      <Rotation>Rotation270</Rotation>
      <IsMirrored>False</IsMirrored>
      <IsVariable>False</IsVariable>
      <Image>{{IMAGE}}</Image>
      <ScaleMode>Fill</ScaleMode>
      <BorderWidth>0</BorderWidth>
      <BorderColor Alpha="255" Red="0" Green="0" Blue="0" />
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Center</VerticalAlignment>
    </ImageObject>
    <Bounds X="0" Y="0" Width="1800" Height="3240" />
  </ObjectInfo>
</DieCutLabel>`;

async function fetchWithTimeout(url, options = {}, ms = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function findDymoService() {
  if (dymoBase) {
    try {
      const r = await fetchWithTimeout(`${dymoBase}/StatusConnected`);
      if (r.ok) return dymoBase;
    } catch (_) { /* rescan below */ }
    dymoBase = null;
  }
  for (const host of DYMO_HOSTS) {
    for (const port of DYMO_PORTS) {
      const base = `https://${host}:${port}/DYMO/DLS/Printing`;
      try {
        const r = await fetchWithTimeout(`${base}/StatusConnected`, {}, 800);
        if (r.ok && (await r.text()).toLowerCase().includes('true')) {
          dymoBase = base;
          return base;
        }
      } catch (_) { /* not on this port */ }
    }
  }
  throw new Error('DYMO Connect web service not found. Is DYMO Connect for Desktop installed and running?');
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1].trim()) : '';
}

async function getPrinters() {
  const base = await findDymoService();
  const r = await fetchWithTimeout(`${base}/GetPrinters`, {}, 5000);
  const xml = await r.text();
  const printers = [];
  for (const m of xml.matchAll(/<(LabelWriterPrinter|LabelManagerPrinter|TapePrinter)>([\s\S]*?)<\/\1>/g)) {
    printers.push({
      name: tag(m[2], 'Name'),
      model: tag(m[2], 'ModelName'),
      connected: tag(m[2], 'IsConnected').toLowerCase() === 'true',
      labelWriter: m[1] === 'LabelWriterPrinter',
    });
  }
  return printers;
}

async function choosePrinter(wanted) {
  const printers = await getPrinters();
  if (wanted) {
    if (printers.some((p) => p.name === wanted)) return wanted;
    throw new Error(`Printer "${wanted}" not found by DYMO Connect.`);
  }
  const lw = printers.filter((p) => p.labelWriter);
  const pick = lw.find((p) => p.connected) || lw[0];
  if (!pick) throw new Error('DYMO Connect reports no LabelWriter printers.');
  return pick.name;
}

async function printLabel(png) {
  const { printerName, template, roll } = await chrome.storage.sync.get({ printerName: '', template: '', roll: 'Auto' });
  const base = await findDymoService();
  const printer = await choosePrinter(printerName);
  const labelXml = (template.trim() || DEFAULT_TEMPLATE).replace('{{IMAGE}}', png);
  // TwinTurboRoll only matters on a Twin Turbo; single-roll printers ignore it.
  const printParamsXml =
    `<LabelWriterPrintParams><Copies>1</Copies><TwinTurboRoll>${roll}</TwinTurboRoll></LabelWriterPrintParams>`;
  const body = new URLSearchParams({ printerName: printer, printParamsXml, labelXml, labelSetXml: '' });
  const r = await fetchWithTimeout(`${base}/PrintLabel`, { method: 'POST', body }, 15000);
  const text = await r.text();
  if (!r.ok || !text.toLowerCase().includes('true')) {
    throw new Error(`DYMO Connect refused the label (${r.status}): ${text.slice(0, 300)}`);
  }
  return printer;
}

async function fontBase64() {
  const r = await fetch(chrome.runtime.getURL('fonts/Jost-700-Bold.otf'));
  const bytes = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const handlers = {
  font: async () => ({ base64: await fontBase64() }),
  print: async (msg) => ({ ok: true, printer: await printLabel(msg.png) }),
  printers: async () => ({ ok: true, printers: await getPrinters() }),
  defaultTemplate: async () => ({ template: DEFAULT_TEMPLATE }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
