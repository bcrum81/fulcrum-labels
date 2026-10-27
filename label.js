// Draws the 2.25" x 1.25" item label onto a canvas. Shared by the content
// script (real prints) and the options page (preview / test print).
//
// Everything is laid out in printer pixels: DYMO LabelWriters are 300 dpi, so
// the label is 675 x 375. Positions were measured from example-label.png.

var HHLabel = (function () {
  const W = 675;
  const H = 375;
  const PAD_LEFT = 27;
  const RIGHT = 635;        // right edge of the QR code and the black box
  const FONT_FAMILY = 'HHLabelJost';

  const QR_BOX = 145;       // max QR size; shrunk to a whole number of px per module
  const QR_TOP = 45;

  const DESC_TOP = 52;      // cap-height top of the first description line
  const DESC_BOTTOM = 245;
  const DESC_MAX_SIZE = 60;
  const DESC_MIN_SIZE = 20;
  const DESC_LINE_HEIGHT = 1.12; // x font size

  const DASH = { x: PAD_LEFT, y: 282, w: 31, h: 3 };

  // Optional internal notes: small text just above the dash, left of the box.
  const NOTES_BASELINE = 263; // last line
  const NOTES_SIZE = 22;
  const NOTES_MIN_SIZE = 15;
  const NOTES_MAX_LINES = 2;
  const NOTES_GAP = 14;       // between the description and the notes
  const NAME_BASELINE = 332;
  const NAME_SIZE = 32;

  const BOX = { x: 402, y: 253, w: RIGHT - 402, h: 93 };

  let fontReady = null;

  // getBytes() resolves to an ArrayBuffer of the font. Loading from bytes
  // (rather than a URL) keeps the page's Content-Security-Policy out of it.
  function loadFont(getBytes) {
    if (!fontReady) {
      fontReady = getBytes()
        .then((bytes) => {
          const face = new FontFace(FONT_FAMILY, bytes, { weight: '700' });
          document.fonts.add(face);
          return face.load();
        })
        .catch((err) => {
          fontReady = null;
          console.warn('[HH Label] font failed to load, using fallback', err);
        });
    }
    return fontReady;
  }

  function font(size) {
    return `700 ${size}px ${FONT_FAMILY}, "Futura", "Century Gothic", Arial, sans-serif`;
  }

  // Greedy word wrap. widthFor(n) is the width available to line n, so lines
  // below the QR code can run wider. Words too wide for a line are broken by
  // character.
  function wrap(ctx, text, widthFor) {
    const lines = [];
    for (const para of text.split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width <= widthFor(lines.length)) {
          line = test;
          continue;
        }
        if (line) lines.push(line);
        line = word;
        while (ctx.measureText(line).width > widthFor(lines.length) && line.length > 1) {
          let i = line.length - 1;
          while (i > 1 && ctx.measureText(line.slice(0, i)).width > widthFor(lines.length)) i--;
          lines.push(line.slice(0, i));
          line = line.slice(i);
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  function capHeight(ctx) {
    return ctx.measureText('H').actualBoundingBoxAscent;
  }

  // Lines beside the QR code get narrowWidth; lines whose tops clear qrBottom
  // get the full label width.
  function drawDescription(ctx, text, narrowWidth, qrBottom, bottom) {
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    let size = DESC_MAX_SIZE;
    let lines;
    let widthFor;
    for (; size >= DESC_MIN_SIZE; size--) {
      ctx.font = font(size);
      const lineHeight = size * DESC_LINE_HEIGHT;
      // Ascenders/parentheses rise ~0.2em above the cap height.
      const lineTop = (n) => DESC_TOP + n * lineHeight - size * 0.2;
      widthFor = (n) => (lineTop(n) > qrBottom + 6 ? RIGHT - PAD_LEFT : narrowWidth);
      lines = wrap(ctx, text, widthFor);
      const height = capHeight(ctx) + (lines.length - 1) * lineHeight + size * 0.25;
      if (DESC_TOP + height <= bottom) break;
    }
    size = Math.max(size, DESC_MIN_SIZE);
    ctx.font = font(size);
    const lineHeight = size * DESC_LINE_HEIGHT;
    const cap = capHeight(ctx);
    const maxLines = Math.max(1, Math.floor((bottom - DESC_TOP - cap - size * 0.25) / lineHeight) + 1);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      let last = lines[maxLines - 1];
      while (last && ctx.measureText(last + '…').width > widthFor(maxLines - 1)) last = last.slice(0, -1);
      lines[maxLines - 1] = last.trimEnd() + '…';
    }
    lines.forEach((line, i) => ctx.fillText(line, PAD_LEFT, DESC_TOP + cap + i * lineHeight));
  }

  // Draws up to NOTES_MAX_LINES lines ending at NOTES_BASELINE, shrinking
  // before truncating. Returns the y of the top of the block.
  function drawNotes(ctx, text, maxWidth) {
    const widthFor = () => maxWidth;
    let size = NOTES_SIZE;
    let lines;
    for (; size >= NOTES_MIN_SIZE; size--) {
      ctx.font = font(size);
      lines = wrap(ctx, text, widthFor);
      if (lines.length <= NOTES_MAX_LINES) break;
    }
    size = Math.max(size, NOTES_MIN_SIZE);
    ctx.font = font(size);
    if (lines.length > NOTES_MAX_LINES) {
      lines = lines.slice(0, NOTES_MAX_LINES);
      let last = lines[NOTES_MAX_LINES - 1];
      while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      lines[NOTES_MAX_LINES - 1] = last.trimEnd() + '…';
    }
    const lineHeight = size * 1.2;
    const firstBaseline = NOTES_BASELINE - (lines.length - 1) * lineHeight;
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    lines.forEach((line, i) => ctx.fillText(line, PAD_LEFT, firstBaseline + i * lineHeight));
    return firstBaseline - capHeight(ctx);
  }

  function drawQr(ctx, text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const m = Math.max(1, Math.floor(QR_BOX / n));
    const size = m * n;
    const x0 = RIGHT - size;
    const y0 = QR_TOP;
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(x0 + c * m, y0 + r * m, m, m);
      }
    }
    return { left: x0, bottom: y0 + size };
  }

  function fitSize(ctx, text, start, maxWidth, maxCap) {
    let size = start;
    for (; size > 8; size--) {
      ctx.font = font(size);
      if (ctx.measureText(text).width <= maxWidth && (!maxCap || capHeight(ctx) <= maxCap)) break;
    }
    return size;
  }

  // Text for the black box: the last 5 characters of the item number, except
  // that a number cut in half is widened to its significant digits (leading
  // zeros dropped), and leading separators are removed.
  //   HH-0001-01 -> 01-01    X_PHL-0120-08 -> 120-08    MFR-2985 -> 2985
  function shortCode(name) {
    const s = name.trim();
    const isDigit = (c) => c >= '0' && c <= '9';
    let start = Math.max(0, s.length - 5);
    if (start > 0 && isDigit(s[start]) && isDigit(s[start - 1])) {
      let runStart = start;
      while (runStart > 0 && isDigit(s[runStart - 1])) runStart--;
      let firstSignificant = runStart;
      while (firstSignificant < start && s[firstSignificant] === '0') firstSignificant++;
      start = firstSignificant;
    }
    return s.slice(start).replace(/^[^A-Za-z0-9]+/, '') || s;
  }

  // data: { description, name, itemId, code?, notes? } — code overrides the black-box
  // text, which otherwise comes from shortCode(name).
  function render(canvas, data) {
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    const name = data.name || '';
    const tail = (data.code != null ? data.code : shortCode(name)).trim();
    // With no box text the box is left off and the item number and notes may
    // use the full width.
    const nameRight = tail ? BOX.x - 12 : RIGHT;

    const qr = drawQr(ctx, `ITEM-${data.itemId}`);
    const notes = (data.notes || '').trim();
    const notesTop = notes ? drawNotes(ctx, notes, nameRight - PAD_LEFT) : null;
    const descBottom = notes ? Math.min(DESC_BOTTOM, notesTop - NOTES_GAP) : DESC_BOTTOM;
    drawDescription(ctx, data.description || '', qr.left - 18 - PAD_LEFT, qr.bottom, descBottom);

    ctx.fillStyle = '#000';
    ctx.fillRect(DASH.x, DASH.y, DASH.w, DASH.h);

    ctx.textBaseline = 'alphabetic';
    ctx.font = font(fitSize(ctx, name, NAME_SIZE, nameRight - PAD_LEFT));
    ctx.fillText(name, PAD_LEFT, NAME_BASELINE);
    if (!tail) return canvas;

    ctx.fillRect(BOX.x, BOX.y, BOX.w, BOX.h);
    const size = fitSize(ctx, tail, 80, BOX.w - 24, BOX.h * 0.6);
    ctx.font = font(size);
    const cap = capHeight(ctx);
    const tw = ctx.measureText(tail).width;
    ctx.fillStyle = '#fff';
    ctx.fillText(tail, BOX.x + (BOX.w - tw) / 2, BOX.y + (BOX.h + cap) / 2);

    return canvas;
  }

  // Rotates by a multiple of 90 degrees, for printers/templates that feed the
  // label the other way round.
  function rotated(canvas, degrees) {
    const turns = (((degrees || 0) / 90) % 4 + 4) % 4;
    if (!turns) return canvas;
    const out = document.createElement('canvas');
    out.width = turns % 2 ? canvas.height : canvas.width;
    out.height = turns % 2 ? canvas.width : canvas.height;
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((turns * Math.PI) / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out;
  }

  return { W, H, loadFont, render, rotated, shortCode };
})();
