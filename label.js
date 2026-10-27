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
  const DESC_MAX_SIZE = 40;
  const DESC_MIN_SIZE = 20;

  const DASH = { x: PAD_LEFT, y: 282, w: 31, h: 3 };
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

  // Greedy word wrap. Words wider than the line are broken by character.
  function wrap(ctx, text, maxWidth) {
    const lines = [];
    for (const para of text.split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width <= maxWidth) {
          line = test;
          continue;
        }
        if (line) lines.push(line);
        line = word;
        while (ctx.measureText(line).width > maxWidth && line.length > 1) {
          let i = line.length - 1;
          while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxWidth) i--;
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

  function drawDescription(ctx, text, maxWidth) {
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    let size = DESC_MAX_SIZE;
    let lines;
    for (; size >= DESC_MIN_SIZE; size--) {
      ctx.font = font(size);
      lines = wrap(ctx, text, maxWidth);
      const lineHeight = size * 1.25;
      const height = capHeight(ctx) + (lines.length - 1) * lineHeight + size * 0.25;
      if (DESC_TOP + height <= DESC_BOTTOM) break;
    }
    size = Math.max(size, DESC_MIN_SIZE);
    ctx.font = font(size);
    const lineHeight = size * 1.25;
    const cap = capHeight(ctx);
    const maxLines = Math.max(1, Math.floor((DESC_BOTTOM - DESC_TOP - cap - size * 0.25) / lineHeight) + 1);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      let last = lines[maxLines - 1];
      while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = last.trimEnd() + '…';
    }
    lines.forEach((line, i) => ctx.fillText(line, PAD_LEFT, DESC_TOP + cap + i * lineHeight));
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
    return x0;
  }

  function fitSize(ctx, text, start, maxWidth, maxCap) {
    let size = start;
    for (; size > 8; size--) {
      ctx.font = font(size);
      if (ctx.measureText(text).width <= maxWidth && (!maxCap || capHeight(ctx) <= maxCap)) break;
    }
    return size;
  }

  // data: { description, name, itemId }
  function render(canvas, data) {
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    const qrLeft = drawQr(ctx, `ITEM-${data.itemId}`);
    drawDescription(ctx, data.description || '', qrLeft - 18 - PAD_LEFT);

    ctx.fillStyle = '#000';
    ctx.fillRect(DASH.x, DASH.y, DASH.w, DASH.h);

    const name = data.name || '';
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(fitSize(ctx, name, NAME_SIZE, BOX.x - 12 - PAD_LEFT));
    ctx.fillText(name, PAD_LEFT, NAME_BASELINE);

    ctx.fillRect(BOX.x, BOX.y, BOX.w, BOX.h);
    const tail = name.slice(-5);
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

  return { W, H, loadFont, render, rotated };
})();
