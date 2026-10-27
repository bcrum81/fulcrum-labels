// On Fulcrum item pages (/ui/items/<id>), Ctrl+P prints the item label
// instead of opening Chrome's print dialog. Every other page is left alone.
//
// Runs at document_start and listens in the capture phase on window, so it
// sees the keystroke before Fulcrum's own handlers do.

(function () {
  const ITEM_PATH = /^\/ui\/items\/([0-9a-f]{24})(?:[/?#]|$)/i;
  let busy = false;

  function currentItemId() {
    const m = location.pathname.match(ITEM_PATH);
    return m ? m[1] : null;
  }

  function firstLine(text) {
    return (text || '').trim().split('\n')[0].trim();
  }

  // Fulcrum (Angular + Taiga UI) renders each field as an <input>/<textarea>
  // with a <label>; find the control by its label text.
  function fieldValue(labelText) {
    for (const el of document.querySelectorAll('input, textarea')) {
      for (const label of el.labels || []) {
        if (firstLine(label.innerText) === labelText) return el.value.trim();
      }
    }
    return null;
  }

  function readItem() {
    let name = fieldValue('Item');
    if (!name) {
      // Tab title is "ITM HH-0019-71 - Fulcrum"; present on every tab of the item.
      const m = document.title.match(/^ITM\s+(.+?)\s+-\s+Fulcrum/);
      if (m) name = m[1];
    }
    let description = fieldValue('Description');
    if (description == null && name) {
      // Details tab not rendered: the page header reads "<name> <description>".
      for (const el of document.querySelectorAll('h1, h2, h3, h4, [class*="title"], [class*="header"]')) {
        const text = (el.innerText || '').trim();
        if (text.startsWith(name + ' ') && !text.includes('\n')) {
          description = text.slice(name.length).trim();
          break;
        }
      }
    }
    // Notes are only printed when ticked in the Ctrl+Shift+P editor, so they
    // go in a separate field rather than `notes`, which render() prints.
    const internalNotes = fieldValue('Internal Item Notes') || '';
    return { itemId: currentItemId(), name: name || '', description: description || '', internalNotes };
  }

  function getFontBytes() {
    return chrome.runtime.sendMessage({ type: 'font' }).then((res) => {
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    });
  }

  function toast(message, isError) {
    const el = document.createElement('div');
    el.textContent = message;
    Object.assign(el.style, {
      position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483647',
      padding: '12px 16px', borderRadius: '6px', maxWidth: '420px',
      font: '14px/1.4 system-ui, sans-serif', color: '#fff',
      background: isError ? '#b42318' : '#1d2939', boxShadow: '0 4px 12px rgba(0,0,0,.25)',
    });
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), isError ? 7000 : 3000);
  }

  // Fallback when the DYMO web service isn't available: print the label image
  // through Chrome. Shows the print dialog unless Chrome runs with
  // --kiosk-printing, in which case it goes straight to the default printer.
  function browserPrint(canvas) {
    const frame = document.createElement('iframe');
    Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', visibility: 'hidden' });
    document.documentElement.appendChild(frame);
    const doc = frame.contentDocument;
    const style = doc.createElement('style');
    style.textContent =
      '@page { size: 2.25in 1.25in; margin: 0 }' +
      'html, body { margin: 0; padding: 0 }' +
      'canvas { display: block; width: 2.25in; height: 1.25in }';
    doc.head.appendChild(style);
    const copy = doc.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    doc.body.appendChild(copy);
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  }

  async function printLabel(item) {
    const settings = await chrome.storage.sync.get({ rotation: 0, browserFallback: true });
    const canvas = HHLabel.render(document.createElement('canvas'), item);

    const png = HHLabel.rotated(canvas, settings.rotation).toDataURL('image/png').split(',')[1];
    const res = await chrome.runtime.sendMessage({ type: 'print', png });
    if (res && res.ok) {
      toast(`Label for ${item.name} sent to ${res.printer}`);
    } else if (settings.browserFallback) {
      console.warn('[HH Label] DYMO print failed, using browser print:', res && res.error);
      browserPrint(canvas);
    } else {
      toast(`Label not printed: ${(res && res.error) || 'unknown error'}`, true);
    }
  }

  // Ctrl/Cmd+Shift+P: editable preview. Lives in a shadow root so Fulcrum's
  // styles don't leak in, and swallows key events so Fulcrum's shortcuts
  // don't fire while typing.
  let editor = null;

  const EDITOR_CSS = `
    .backdrop { position: fixed; inset: 0; z-index: 2147483646; background: rgba(16,24,40,.55);
      display: flex; align-items: center; justify-content: center; font: 14px/1.4 system-ui, sans-serif; color: #1d2939; }
    .panel { background: #fff; border-radius: 10px; padding: 20px; width: 420px; max-width: calc(100vw - 32px);
      box-shadow: 0 12px 32px rgba(0,0,0,.3); }
    h2 { margin: 0 0 12px; font-size: 16px; }
    canvas { display: block; width: 100%; aspect-ratio: 675 / 375; border: 1px solid #d0d5dd; border-radius: 14px; margin-bottom: 12px; }
    label { display: block; font-weight: 600; font-size: 12px; margin: 10px 0 4px; }
    input, textarea { box-sizing: border-box; width: 100%; font: inherit; padding: 6px 8px; border: 1px solid #d0d5dd; border-radius: 6px; }
    textarea { height: 64px; resize: vertical; }
    textarea#notes { height: 48px; }
    label.check { display: flex; align-items: center; gap: 6px; font-weight: 400; font-size: 13px; margin-top: 12px; cursor: pointer; }
    label.check input { width: auto; margin: 0; }
    [hidden] { display: none !important; }
    .row { display: flex; gap: 10px; }
    .row > div { flex: 1; }
    .row > div.code { flex: 0 0 120px; }
    .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #d0d5dd; background: #fff; cursor: pointer; }
    button.primary { background: #1d2939; border-color: #1d2939; color: #fff; }
    .hint { color: #667085; font-size: 12px; margin-right: auto; align-self: center; }
  `;

  function openEditor(item) {
    if (editor) return;
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${EDITOR_CSS}</style>
      <div class="backdrop">
        <div class="panel" role="dialog" aria-label="Edit label">
          <h2>Edit label</h2>
          <canvas></canvas>
          <label for="desc">Description</label>
          <textarea id="desc"></textarea>
          <div class="row">
            <div><label for="name">Item number</label><input id="name"></div>
            <div class="code"><label for="code">Box text</label><input id="code"></div>
          </div>
          <label class="check"><input type="checkbox" id="includeNotes"> Include Internal Notes</label>
          <textarea id="notes" hidden aria-label="Internal notes"></textarea>
          <div class="buttons">
            <span class="hint">Enter to print \u00b7 Esc to cancel</span>
            <button class="cancel">Cancel</button>
            <button class="primary print">Print</button>
          </div>
        </div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    const canvas = $('canvas');
    const desc = $('#desc');
    const name = $('#name');
    const code = $('#code');
    const includeNotes = $('#includeNotes');
    const notes = $('#notes');
    desc.value = item.description;
    name.value = item.name;
    code.value = HHLabel.shortCode(item.name);
    notes.value = item.internalNotes;
    let codeEdited = false;

    const current = () => ({
      itemId: item.itemId,
      description: desc.value,
      name: name.value.trim(),
      code: code.value.trim(),
      notes: includeNotes.checked ? notes.value : '',
    });
    const redraw = () => HHLabel.render(canvas, current());
    const close = () => { host.remove(); editor = null; };
    const print = () => {
      const data = current();
      close();
      runPrint(data);
    };

    desc.addEventListener('input', redraw);
    name.addEventListener('input', () => {
      if (!codeEdited) code.value = HHLabel.shortCode(name.value);
      redraw();
    });
    code.addEventListener('input', () => { codeEdited = true; redraw(); });
    notes.addEventListener('input', redraw);
    includeNotes.addEventListener('change', () => {
      notes.hidden = !includeNotes.checked;
      redraw();
    });
    $('.cancel').addEventListener('click', close);
    $('.print').addEventListener('click', print);
    $('.backdrop').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) close(); });
    root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
      // Enter prints; Shift+Enter still adds a line break in the description.
      else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'BUTTON') { e.preventDefault(); print(); }
    });
    for (const type of ['keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());

    editor = { print };
    document.documentElement.appendChild(host);
    redraw();
    desc.focus();
    desc.select();
  }

  function runPrint(item) {
    busy = true;
    printLabel(item)
      .catch((err) => toast(`Label not printed: ${err.message || err}`, true))
      .finally(() => { busy = false; });
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key.toLowerCase() !== 'p' || !currentItemId()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || busy) return;
      // After the extension is reloaded or updated, scripts already running in
      // open tabs are cut off from it: chrome.runtime.id disappears and every
      // extension call throws "Extension context invalidated". Fulcrum never
      // does a full page load between items, so a tab can stay like this all
      // day.
      if (!chrome.runtime?.id) {
        toast('The label extension was updated. Reload this page (Ctrl+R / ⌘R) and try again.', true);
        return;
      }
      // Ctrl+P while the editor is open prints what's in it.
      if (editor) {
        editor.print();
        return;
      }
      const item = readItem();
      if (!item.name) {
        toast('Label not printed: could not find the item number on this page.', true);
        return;
      }
      busy = true;
      HHLabel.loadFont(getFontBytes)
        .then(() => {
          busy = false;
          if (e.shiftKey) openEditor(item);
          else runPrint(item);
        })
        .catch((err) => {
          busy = false;
          toast(`Label not printed: ${err.message || err}`, true);
        });
    },
    true
  );
})();
