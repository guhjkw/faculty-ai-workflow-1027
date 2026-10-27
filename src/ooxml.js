// src/ooxml.js: writes real, editable PowerPoint (.pptx) and Word (.docx) files, and reads the text of a
// .pptx, with no libraries. The same file runs in the browser (downloads) and in node (tests).
//   Ooxml.pptx(deck)  -> Uint8Array   deck: { title, author, created, slides: [{ layout, title, subtitle,
//                                       bullets: [{ text, lvl }], notes: [..], hidden, tag, footer }] }
//   Ooxml.docx(doc)   -> Uint8Array   doc:  { title, author, created, blocks: [{ type, text | runs | rows }] }
//   Ooxml.readPptx(bytes, inflateRaw) -> Promise<{ slides: [{ n, title, bullets, notes }], problems }>
// Files are stored uncompressed (ZIP "store"), which every Office app reads. The fixed parts (theme,
// slide master, layouts, notes master) come from src/ooxml-parts.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ooxml-parts.js'));
  else root.Ooxml = factory(root.OoxmlParts);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  // ---------- bytes and ZIP ----------
  const utf8 = (s) => new TextEncoder().encode(s);
  const text = (u8) => new TextDecoder('utf-8').decode(u8);
  let TABLE = null;
  function crc32(u8) {
    if (!TABLE) {
      TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        TABLE[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < u8.length; i++) crc = TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function dosTime(d) {
    return {
      time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
      date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
  }
  // files: [{ name, data: string | Uint8Array }] in the order they should appear. Returns the .zip bytes.
  function zip(files, when) {
    const t = dosTime(when ? new Date(when) : new Date(Date.UTC(2026, 9, 27, 12, 0, 0)));
    const locals = [], centrals = [];
    let offset = 0;
    const seen = new Set();
    files.forEach((f) => {
      if (seen.has(f.name)) throw new Error('duplicate part ' + f.name);
      seen.add(f.name);
      const name = utf8(f.name), data = typeof f.data === 'string' ? utf8(f.data) : f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, t.time, true); h.setUint16(12, t.date, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, t.time, true); c.setUint16(14, t.date, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true);
      c.setUint32(42, offset, true);
      locals.push(new Uint8Array(h.buffer), name, data);
      centrals.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = centrals.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    const parts = locals.concat(centrals, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
    let p = 0;
    parts.forEach((b) => { out.set(b, p); p += b.length; });
    return out;
  }
  // Reads the central directory, then each entry. inflateRaw(Uint8Array) -> Promise<Uint8Array> handles
  // compressed entries (PowerPoint compresses everything); stored entries need nothing.
  async function unzip(u8, inflateRaw) {
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a ZIP file (no end of central directory)');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const out = {};
    for (let k = 0; k < count; k++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('damaged ZIP central directory');
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      const name = text(u8.subarray(p + 46, p + 46 + nlen));
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = u8.subarray(start, start + csize);
      if (method === 0) out[name] = raw;
      else if (method === 8) {
        if (!inflateRaw) throw new Error('compressed entry ' + name + ' needs an inflate function');
        out[name] = await inflateRaw(raw);
      } else throw new Error('unsupported ZIP method ' + method + ' in ' + name);
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  // ---------- XML helpers ----------
  const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  const esc = (s) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const CT = 'application/vnd.openxmlformats-officedocument.';
  function rels(list) {
    return HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      list.map((r, i) => '<Relationship Id="rId' + (i + 1) + '" Type="' + r[0] + '" Target="' + r[1] + '"/>').join('') + '</Relationships>';
  }
  function contentTypes(overrides) {
    return HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      overrides.map((o) => '<Override PartName="' + o[0] + '" ContentType="' + o[1] + '"/>').join('') + '</Types>';
  }
  function iso(d) { return new Date(d || Date.UTC(2026, 9, 27, 12)).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  function core(meta) {
    return HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + esc(meta.title || '') + '</dc:title><dc:creator>' + esc(meta.author || '') + '</dc:creator><cp:lastModifiedBy>' + esc(meta.author || '') + '</cp:lastModifiedBy><cp:revision>1</cp:revision>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso(meta.created) + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + iso(meta.created) + '</dcterms:modified></cp:coreProperties>';
  }
  function app(extra) {
    return HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Faculty Course Studio</Application>' + (extra || '') + '</Properties>';
  }

  // ---------- PowerPoint ----------
  const EMU = { w: 12192000, h: 6858000 };
  const run = (t, rpr) => '<a:r><a:rPr lang="en-US"' + (rpr || '') + ' dirty="0"/><a:t>' + esc(t) + '</a:t></a:r>';
  const para = (t, lvl) => t ? '<a:p>' + (lvl ? '<a:pPr lvl="' + lvl + '"/>' : '') + run(t) + '</a:p>' : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>';
  function placeholder(id, name, ph, paras, fit) {
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>' + ph + '</p:nvPr></p:nvSpPr><p:spPr/>' +
      '<p:txBody><a:bodyPr>' + (fit ? '<a:normAutofit/>' : '') + '</a:bodyPr><a:lstStyle/>' + (paras || para('')) + '</p:txBody></p:sp>';
  }
  function textBox(id, name, x, y, cx, cy, t, size, color, fill, bold) {
    return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="' + (fill ? 'roundRect' : 'rect') + '"><a:avLst/></a:prstGeom>' +
      (fill ? '<a:solidFill><a:srgbClr val="' + fill + '"/></a:solidFill><a:ln><a:noFill/></a:ln>' : '<a:noFill/>') + '</p:spPr>' +
      '<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p>' + (fill ? '<a:pPr algn="ctr"/>' : '') +
      '<a:r><a:rPr lang="en-US" sz="' + size + '"' + (bold ? ' b="1"' : '') + ' dirty="0"><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill></a:rPr><a:t>' + esc(t) + '</a:t></a:r></a:p></p:txBody></p:sp>';
  }
  function slideXml(s) {
    const shapes = [];
    if (s.layout === 'title') {
      shapes.push(placeholder(2, 'Title 1', '<p:ph type="ctrTitle"/>', para(s.title)));
      shapes.push(placeholder(3, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', para(s.subtitle || '')));
    } else {
      shapes.push(placeholder(2, 'Title 1', '<p:ph type="title"/>', para(s.title)));
      const body = (s.bullets || []).filter((b) => b && b.text).map((b) => para(b.text, Math.min(4, b.lvl || 0))).join('');
      shapes.push(placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', body, true));
    }
    let id = 4;
    if (s.tag) shapes.push(textBox(id++, 'Instructor tag', EMU.w - 2743200 - 457200, 152400, 2743200, 369332, s.tag, 1200, 'FFFFFF', '8C1D40', true));
    if (s.footer) shapes.push(textBox(id++, 'Source line', 609600, EMU.h - 457200, EMU.w - 1219200, 307777, s.footer, 1000, '6B7280'));
    return HEAD + '<p:sld ' + NS_P + (s.hidden ? ' show="0"' : '') + '><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      shapes.join('') + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  }
  function notesXml(lines) {
    return HEAD + '<p:notes ' + NS_P + '><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
      placeholder(3, 'Notes Placeholder 2', '<p:ph type="body" sz="quarter" idx="3"/>', lines.map((l) => para(l)).join('')) +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
  }
  function pptx(deck) {
    const slides = deck.slides || [];
    if (!slides.length) throw new Error('a deck needs at least one slide');
    const files = [], over = [], presRels = [
      [REL + 'slideMaster', 'slideMasters/slideMaster1.xml'], [REL + 'notesMaster', 'notesMasters/notesMaster1.xml'],
      [REL + 'presProps', 'presProps.xml'], [REL + 'viewProps', 'viewProps.xml'], [REL + 'theme', 'theme/theme1.xml'], [REL + 'tableStyles', 'tableStyles.xml'],
    ];
    const body = [];
    let notesCount = 0, hidden = 0;
    slides.forEach((s, i) => {
      const n = i + 1, hasNotes = (s.notes || []).some((l) => String(l).trim());
      presRels.push([REL + 'slide', 'slides/slide' + n + '.xml']);
      body.push({ name: 'ppt/slides/slide' + n + '.xml', data: slideXml(s) });
      const sr = [[REL + 'slideLayout', '../slideLayouts/slideLayout' + (s.layout === 'title' ? 1 : 2) + '.xml']];
      if (hasNotes) {
        notesCount++;
        sr.push([REL + 'notesSlide', '../notesSlides/notesSlide' + n + '.xml']);
        body.push({ name: 'ppt/notesSlides/notesSlide' + n + '.xml', data: notesXml(s.notes.map(String)) });
        body.push({ name: 'ppt/notesSlides/_rels/notesSlide' + n + '.xml.rels', data: rels([[REL + 'notesMaster', '../notesMasters/notesMaster1.xml'], [REL + 'slide', '../slides/slide' + n + '.xml']]) });
        over.push(['/ppt/notesSlides/notesSlide' + n + '.xml', CT + 'presentationml.notesSlide+xml']);
      }
      if (s.hidden) hidden++;
      body.push({ name: 'ppt/slides/_rels/slide' + n + '.xml.rels', data: rels(sr) });
      over.push(['/ppt/slides/slide' + n + '.xml', CT + 'presentationml.slide+xml']);
    });
    const pres = HEAD + '<p:presentation ' + NS_P + ' saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>' +
      slides.map((s, i) => '<p:sldId id="' + (256 + i) + '" r:id="rId' + (7 + i) + '"/>').join('') + '</p:sldIdLst>' +
      '<p:sldSz cx="' + EMU.w + '" cy="' + EMU.h + '"/><p:notesSz cx="6858000" cy="9144000"/>' + P.defaultTextStyle + '</p:presentation>';
    files.push({ name: '[Content_Types].xml', data: contentTypes([
      ['/ppt/presentation.xml', CT + 'presentationml.presentation.main+xml'],
      ['/ppt/slideMasters/slideMaster1.xml', CT + 'presentationml.slideMaster+xml'],
      ['/ppt/slideLayouts/slideLayout1.xml', CT + 'presentationml.slideLayout+xml'],
      ['/ppt/slideLayouts/slideLayout2.xml', CT + 'presentationml.slideLayout+xml'],
      ['/ppt/notesMasters/notesMaster1.xml', CT + 'presentationml.notesMaster+xml'],
      ['/ppt/theme/theme1.xml', CT + 'theme+xml'], ['/ppt/theme/theme2.xml', CT + 'theme+xml'],
      ['/ppt/presProps.xml', CT + 'presentationml.presProps+xml'], ['/ppt/viewProps.xml', CT + 'presentationml.viewProps+xml'],
      ['/ppt/tableStyles.xml', CT + 'presentationml.tableStyles+xml'],
      ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'], ['/docProps/app.xml', CT + 'extended-properties+xml'],
    ].concat(over)) });
    files.push({ name: '_rels/.rels', data: rels([[REL + 'officeDocument', 'ppt/presentation.xml'], ['http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], [REL + 'extended-properties', 'docProps/app.xml']]) });
    files.push({ name: 'docProps/core.xml', data: core(deck) });
    files.push({ name: 'docProps/app.xml', data: app('<Slides>' + slides.length + '</Slides><Notes>' + notesCount + '</Notes><HiddenSlides>' + hidden + '</HiddenSlides>') });
    files.push({ name: 'ppt/presentation.xml', data: pres });
    files.push({ name: 'ppt/_rels/presentation.xml.rels', data: rels(presRels) });
    files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: HEAD + P.master.replace(/^<\?xml[^>]*\?>/, '') });
    files.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([[REL + 'slideLayout', '../slideLayouts/slideLayout1.xml'], [REL + 'slideLayout', '../slideLayouts/slideLayout2.xml'], [REL + 'theme', '../theme/theme1.xml']]) });
    files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: HEAD + P.layoutTitle.replace(/^<\?xml[^>]*\?>/, '') });
    files.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([[REL + 'slideMaster', '../slideMasters/slideMaster1.xml']]) });
    files.push({ name: 'ppt/slideLayouts/slideLayout2.xml', data: HEAD + P.layoutContent.replace(/^<\?xml[^>]*\?>/, '') });
    files.push({ name: 'ppt/slideLayouts/_rels/slideLayout2.xml.rels', data: rels([[REL + 'slideMaster', '../slideMasters/slideMaster1.xml']]) });
    files.push({ name: 'ppt/notesMasters/notesMaster1.xml', data: HEAD + P.notesMaster.replace(/^<\?xml[^>]*\?>/, '') });
    files.push({ name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: rels([[REL + 'theme', '../theme/theme2.xml']]) });
    files.push({ name: 'ppt/theme/theme1.xml', data: HEAD + P.theme1.replace(/^<\?xml[^>]*\?>/, '') });
    files.push({ name: 'ppt/theme/theme2.xml', data: HEAD + P.theme2.replace(/^<\?xml[^>]*\?>/, '') });
    files.push({ name: 'ppt/presProps.xml', data: HEAD + P.presProps.replace(/^<\?xml[^>]*\?>/, '') });
    files.push({ name: 'ppt/viewProps.xml', data: HEAD + P.viewProps.replace(/^<\?xml[^>]*\?>/, '') });
    files.push({ name: 'ppt/tableStyles.xml', data: HEAD + P.tableStyles.replace(/^<\?xml[^>]*\?>/, '') });
    return zip(files.concat(body), deck.created);
  }

  // ---------- Word ----------
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  function wRuns(b) {
    const runs = b.runs || [{ text: b.text || '' }];
    return runs.map((r) => {
      const pr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (r.color ? '<w:color w:val="' + r.color + '"/>' : '');
      return '<w:r>' + (pr ? '<w:rPr>' + pr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + esc(r.text) + '</w:t></w:r>';
    }).join('');
  }
  const STYLE = { title: 'Title', h1: 'Heading1', h2: 'Heading2', note: 'InstructorNote', source: 'Provenance', p: null, bullet: 'ListBullet', number: 'ListNumber' };
  function docx(doc) {
    const blocks = doc.blocks || [];
    let lists = 0, inList = false;
    const body = blocks.map((b) => {
      if (b.type === 'table') {
        inList = false;
        const rows = b.rows || [], cols = Math.max(1, ...rows.map((r) => r.length));
        // Column widths in twentieths of a point across the 6.5-inch text block (9360), from optional ratios.
        const ratio = (b.widths && b.widths.length === cols ? b.widths : Array(cols).fill(1)), sum = ratio.reduce((a, c) => a + c, 0);
        const ws = ratio.map((r) => Math.floor(9360 * r / sum));
        return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>' +
          ws.map((w) => '<w:gridCol w:w="' + w + '"/>').join('') + '</w:tblGrid>' +
          rows.map((r, ri) => '<w:tr>' + Array.from({ length: cols }, (_, ci) => '<w:tc><w:tcPr><w:tcW w:w="' + ws[ci] + '" w:type="dxa"/>' + (ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF5"/>' : '') + '</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>' +
            wRuns({ runs: [{ text: r[ci] == null ? '' : String(r[ci]), b: ri === 0 }] }) + '</w:p></w:tc>').join('') + '</w:tr>').join('') + '</w:tbl><w:p/>';
      }
      const style = STYLE[b.type] || null;
      let num = '';
      if (b.type === 'bullet') num = '<w:numPr><w:ilvl w:val="' + Math.min(1, b.lvl || 0) + '"/><w:numId w:val="1"/></w:numPr>';
      if (b.type === 'number') {
        if (!inList || b.restart) lists++;
        num = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="' + (1 + lists) + '"/></w:numPr>';
      }
      // A note or source line under a numbered item keeps the list going; anything else ends it.
      inList = b.type === 'number' || (inList && (b.type === 'note' || b.type === 'source'));
      return '<w:p>' + (style || num ? '<w:pPr>' + (style ? '<w:pStyle w:val="' + style + '"/>' : '') + num + '</w:pPr>' : '') + wRuns(b) + '</w:p>';
    }).join('');
    const document = HEAD + '<w:document ' + W + '><w:body>' + body +
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>';
    const lvl = (i, fmt, txt, left) => '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + fmt + '"/><w:lvlText w:val="' + txt + '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' + left + '" w:hanging="360"/></w:pPr></w:lvl>';
    let numbering = HEAD + '<w:numbering ' + W + '>' +
      '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + lvl(0, 'bullet', '•', 360) + lvl(1, 'bullet', '◦', 720) + '</w:abstractNum>' +
      // One numbering definition per numbered list, so every reader restarts each list at 1.
      Array.from({ length: lists }, (_, k) => '<w:abstractNum w:abstractNumId="' + (k + 1) + '"><w:multiLevelType w:val="hybridMultilevel"/>' + lvl(0, 'decimal', '%1.', 360) + '</w:abstractNum>').join('') +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    for (let k = 1; k <= lists; k++) numbering += '<w:num w:numId="' + (1 + k) + '"><w:abstractNumId w:val="' + k + '"/></w:num>';
    numbering += '</w:numbering>';
    const pStyle = (id, name, pPr, rPr, extra) => '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' + (extra || '') + '<w:qFormat/>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '</w:style>';
    const border = (n) => '<w:' + n + ' w:val="single" w:sz="4" w:space="0" w:color="A3AEBD"/>';
    const styles = HEAD + '<w:styles ' + W + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      pStyle('Title', 'Title', '<w:spacing w:after="120"/>', '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:color w:val="1B2A41"/><w:sz w:val="44"/><w:szCs w:val="44"/>') +
      pStyle('Heading1', 'heading 1', '<w:keepNext/><w:spacing w:before="300" w:after="100"/><w:outlineLvl w:val="0"/>', '<w:b/><w:color w:val="1F5F8B"/><w:sz w:val="30"/><w:szCs w:val="30"/>') +
      pStyle('Heading2', 'heading 2', '<w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/>', '<w:b/><w:color w:val="1B2A41"/><w:sz w:val="24"/><w:szCs w:val="24"/>') +
      pStyle('ListBullet', 'List Bullet', '<w:numPr><w:numId w:val="1"/></w:numPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/>', '') +
      pStyle('ListNumber', 'List Number', '<w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/>', '') +
      pStyle('InstructorNote', 'Instructor Note', '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="8C1D40"/></w:pBdr><w:ind w:left="240"/>', '<w:color w:val="374151"/>') +
      pStyle('Provenance', 'Provenance', '<w:spacing w:after="80"/>', '<w:i/><w:color w:val="6B7280"/><w:sz w:val="18"/><w:szCs w:val="18"/>') +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
      '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('') + '</w:tblBorders></w:tblPr></w:style></w:styles>';
    const settings = HEAD + '<w:settings ' + W + '><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';
    return zip([
      { name: '[Content_Types].xml', data: contentTypes([
        ['/word/document.xml', CT + 'wordprocessingml.document.main+xml'], ['/word/styles.xml', CT + 'wordprocessingml.styles+xml'],
        ['/word/numbering.xml', CT + 'wordprocessingml.numbering+xml'], ['/word/settings.xml', CT + 'wordprocessingml.settings+xml'],
        ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'], ['/docProps/app.xml', CT + 'extended-properties+xml']]) },
      { name: '_rels/.rels', data: rels([[REL + 'officeDocument', 'word/document.xml'], ['http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'], [REL + 'extended-properties', 'docProps/app.xml']]) },
      { name: 'docProps/core.xml', data: core(doc) },
      { name: 'docProps/app.xml', data: app('') },
      { name: 'word/document.xml', data: document },
      { name: 'word/_rels/document.xml.rels', data: rels([[REL + 'styles', 'styles.xml'], [REL + 'numbering', 'numbering.xml'], [REL + 'settings', 'settings.xml']]) },
      { name: 'word/styles.xml', data: styles },
      { name: 'word/numbering.xml', data: numbering },
      { name: 'word/settings.xml', data: settings },
    ], doc.created);
  }

  // ---------- reading a .pptx (publisher decks, your prior decks) ----------
  function paragraphs(xml) {
    const out = [];
    (xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g) || []).forEach((p) => {
      const t = (p.match(/<a:t>([\s\S]*?)<\/a:t>|<a:t [^>]*>([\s\S]*?)<\/a:t>/g) || []).map((m) => unesc(m.replace(/<\/?a:t[^>]*>/g, ''))).join('');
      const lvl = +((/<a:pPr[^>]*\blvl="(\d)"/.exec(p) || [])[1] || 0);
      if (t.trim()) out.push({ text: t.replace(/\s+/g, ' ').trim(), lvl });
    });
    return out;
  }
  function relTargets(xml) {
    const map = {};
    (xml.match(/<Relationship [^>]*>/g) || []).forEach((r) => {
      const id = (/Id="([^"]+)"/.exec(r) || [])[1], target = (/Target="([^"]+)"/.exec(r) || [])[1], type = (/Type="([^"]+)"/.exec(r) || [])[1];
      if (id) map[id] = { target, type };
    });
    return map;
  }
  const resolve = (base, target) => {
    const parts = base.split('/').slice(0, -1);
    target.split('/').forEach((seg) => { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); });
    return parts.join('/');
  };
  async function readPptx(bytes, inflateRaw) {
    const files = await unzip(bytes, inflateRaw);
    const get = (n) => (files[n] ? text(files[n]) : null);
    const pres = get('ppt/presentation.xml');
    if (!pres) throw new Error('not a PowerPoint file (no ppt/presentation.xml)');
    const presRels = relTargets(get('ppt/_rels/presentation.xml.rels') || '');
    const ids = (pres.match(/<p:sldId [^>]*>/g) || []).map((s) => (/r:id="([^"]+)"/.exec(s) || [])[1]);
    const slides = [], problems = [];
    ids.forEach((rid, i) => {
      const rel = presRels[rid];
      if (!rel) { problems.push('slide ' + (i + 1) + ': missing relationship ' + rid); return; }
      const path = resolve('ppt/presentation.xml', rel.target), xml = get(path);
      if (!xml) { problems.push('slide ' + (i + 1) + ': part ' + path + ' is missing'); return; }
      let title = '';
      const bullets = [];
      (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).forEach((sp) => {
        const isTitle = /<p:ph[^>]*type="(title|ctrTitle)"/.test(sp);
        const ps = paragraphs(sp);
        if (isTitle && !title) title = ps.map((p) => p.text).join(' ');
        else ps.forEach((p) => bullets.push(p));
      });
      const srels = relTargets(get(path.replace('slides/', 'slides/_rels/') + '.rels') || '');
      const notesRel = Object.values(srels).find((r) => /notesSlide$/.test(r.type));
      let notes = '';
      if (notesRel) {
        const nx = get(resolve(path, notesRel.target)) || '';
        (nx.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).forEach((sp) => {
          if (/<p:ph[^>]*type="body"/.test(sp)) notes = paragraphs(sp).map((p) => p.text).join('\n');
        });
      }
      slides.push({ n: i + 1, title, bullets, notes, hidden: /<p:sld [^>]*show="0"/.test(xml) });
    });
    return { slides, problems };
  }

  return { crc32, zip, unzip, pptx, docx, readPptx, esc };
});
