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
    return { itemId: currentItemId(), name: name || '', description: description || '' };
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

  async function printLabel() {
    const item = readItem();
    if (!item.name) {
      toast('Label not printed: could not find the item number on this page.', true);
      return;
    }
    await HHLabel.loadFont(getFontBytes);
    const settings = await chrome.storage.sync.get({ rotate: 0, browserFallback: true });
    const canvas = HHLabel.render(document.createElement('canvas'), item);

    const png = HHLabel.rotated(canvas, settings.rotate).toDataURL('image/png').split(',')[1];
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

  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'p' || !currentItemId()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || busy) return;
      busy = true;
      printLabel()
        .catch((err) => toast(`Label not printed: ${err.message || err}`, true))
        .finally(() => { busy = false; });
    },
    true
  );
})();
