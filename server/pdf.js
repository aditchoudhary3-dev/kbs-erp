import zlib from 'node:zlib';

// A tiny PDF writer: text in the built-in Helvetica fonts, filled rectangles
// and lines. Enough for receipts and report cards without a dependency.
// Coordinates are in points from the top-left corner of an A4 page.

// Glyph widths (per 1000 units) for ASCII 32–126.
const WIDTHS = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
    556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
    260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
    556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
    556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
    280, 389, 584,
  ],
};

// Non-ASCII characters we use, mapped to WinAnsi codes with [regular, bold] widths.
const EXTRA = {
  '·': [0xb7, 278, 278],
  '–': [0x96, 556, 556],
  '—': [0x97, 1000, 1000],
  '‘': [0x91, 222, 278],
  '’': [0x92, 222, 278],
  '“': [0x93, 333, 500],
  '”': [0x94, 333, 500],
  '…': [0x85, 1000, 1000],
  '×': [0xd7, 584, 584],
};

// The standard fonts have no rupee sign, so spell it out.
const prepare = (text) => String(text).replace(/₹\s?/g, 'Rs. ');

function charWidth(ch, bold) {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return WIDTHS[bold ? 'bold' : 'regular'][code - 32];
  const extra = EXTRA[ch];
  return extra ? extra[bold ? 2 : 1] : 556;
}

function encode(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) out += ch === '(' || ch === ')' || ch === '\\' ? `\\${ch}` : ch;
    else if (EXTRA[ch]) out += String.fromCharCode(EXTRA[ch][0]);
    else out += '?';
  }
  return out;
}

const num = (n) => Number(n.toFixed(2)).toString();

function rgb(hex) {
  const v = hex.replace('#', '');
  return [0, 2, 4].map((i) => num(parseInt(v.slice(i, i + 2), 16) / 255)).join(' ');
}

export class Pdf {
  constructor({ title = 'Document' } = {}) {
    this.width = 595.28;
    this.height = 841.89;
    this.title = title;
    this.pages = [];
    this.images = [];
    this.addPage();
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
  }

  measure(text, size, bold = false) {
    let units = 0;
    for (const ch of prepare(text)) units += charWidth(ch, bold);
    return (units * size) / 1000;
  }

  text(text, x, y, { size = 11, bold = false, color = '#1C2B2A', align = 'left' } = {}) {
    const value = prepare(text);
    const w = this.measure(value, size, bold);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${num(left)} ${num(this.height - y)} Td (${encode(value)}) Tj ET`,
    );
  }

  // Word-wraps text to maxWidth and returns the y just below the last line.
  paragraph(text, x, y, maxWidth, { size = 11, bold = false, color = '#1C2B2A', lineHeight = 1.45 } = {}) {
    const words = prepare(text).split(/\s+/).filter(Boolean);
    let line = '';
    let cursor = y;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && this.measure(next, size, bold) > maxWidth) {
        this.text(line, x, cursor, { size, bold, color });
        cursor += size * lineHeight;
        line = word;
      } else {
        line = next;
      }
    }
    if (line) {
      this.text(line, x, cursor, { size, bold, color });
      cursor += size * lineHeight;
    }
    return cursor;
  }

  rect(x, y, w, h, { fill }) {
    this.ops.push(`${rgb(fill)} rg ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re f`);
  }

  strokeRect(x, y, w, h, { color = '#E4E0D6', width = 1 } = {}) {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re S`);
  }

  // Draws a decoded PNG ({ width, height, rgba }) with its transparency.
  image(picture, x, y, w, h) {
    let entry = this.images.find((i) => i.picture === picture);
    if (!entry) {
      entry = { picture, name: `Im${this.images.length + 1}` };
      this.images.push(entry);
    }
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.height - y - h)} cm /${entry.name} Do Q`);
  }

  // `dash` is [on, off] in points for a dashed line.
  line(x1, y1, x2, y2, { color = '#E4E0D6', width = 1, dash = null } = {}) {
    const pattern = dash ? `[${dash.map(num).join(' ')}] 0 d ` : '';
    this.ops.push(
      `q ${pattern}${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S Q`,
    );
  }

  toBuffer() {
    const objects = [];
    const add = (body) => objects.push(body); // returns the new object's number

    const catalogId = add(null);
    const pagesId = add(null);
    const regularId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const infoId = add(`<< /Title (${encode(prepare(this.title))}) /Producer (KBS School fee system) >>`);

    // Images: colour data plus a separate alpha mask (SMask) for transparency.
    const stream = (dict, data) => {
      const packed = zlib.deflateSync(data);
      return Buffer.concat([
        Buffer.from(`<< ${dict} /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        packed,
        Buffer.from('\nendstream', 'latin1'),
      ]);
    };
    const imageRefs = this.images.map(({ picture, name }) => {
      const { width, height, rgba } = picture;
      const rgb = Buffer.alloc(width * height * 3);
      const alpha = Buffer.alloc(width * height);
      for (let i = 0; i < width * height; i++) {
        rgba.copy(rgb, i * 3, i * 4, i * 4 + 3);
        alpha[i] = rgba[i * 4 + 3];
      }
      const size = `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8`;
      const maskId = add(stream(`${size} /ColorSpace /DeviceGray`, alpha));
      return `/${name} ${add(stream(`${size} /ColorSpace /DeviceRGB /SMask ${maskId} 0 R`, rgb))} 0 R`;
    });
    const xobjects = imageRefs.length ? ` /XObject << ${imageRefs.join(' ')} >>` : '';

    const pageIds = this.pages.map((ops) => {
      const stream = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      const contentId = add(
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
          stream,
          Buffer.from('\nendstream', 'latin1'),
        ]),
      );
      return add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
          `/Resources << /Font << /F1 ${regularId} 0 R /F2 ${boldId} 0 R >>${xobjects} >> /Contents ${contentId} 0 R >>`,
      );
    });

    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = objects.map((body, i) => {
      const at = offset;
      const chunk = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
        Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
        Buffer.from('\nendobj\n', 'latin1'),
      ]);
      chunks.push(chunk);
      offset += chunk.length;
      return at;
    });

    const xref =
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${offset}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}
