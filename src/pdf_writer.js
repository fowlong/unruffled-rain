/* PDF writer: 1.4 (xref table) and 1.7/2.0 (xref stream)
   Modes:
   - Text IR: { pages:[ {width,height,textItems:[...]} ] }
   - Raw/Full IR: {
       mode: "raw",
       pages:[ { width,height, rawStream: "<content-stream BODY>" } ],
       xobjects?: { ImName:{dataUrl,width?,height?,colorSpace?,bitsPerComponent?} },
       fontAliases?: { F5:"Helvetica", F12:"Helvetica" }
     }
   Also exported: emitContentStreamFromFullIR(fullIRTree) → string
*/

const te = new TextEncoder();
const td = new TextDecoder();

/* ===== small utils ===== */
const esc = (s) => String(s).replace(/([\\\(\)])/g, "\\$1");
const num = (n) =>
  typeof n === "number" ? String(Number((+n).toFixed(4))) : String(n);
const nameTok = (x) => `/${String(x).replace(/^\//, "")}`;
const lit = (s) => `(${esc(String(s))})`;
const arr = (a) => `[ ${a.map(renderArg).join(" ")} ]`;
function renderArg(a) {
  if (Array.isArray(a)) return arr(a);
  if (typeof a === "number") return num(a);
  if (typeof a === "string") return a.startsWith("/") ? a : lit(a);
  return String(a);
}
const dict = (obj) =>
  `<< ${Object.entries(obj)
    .map(([k, v]) => `/${k} ${v}`)
    .join(" ")} >>\n`;
function argsAry(a) {
  if (a == null) return [];
  return Array.isArray(a) ? a : [a];
}

class ByteSink {
  constructor() {
    this.chunks = [];
    this.len = 0;
  }
  length() {
    return this.len;
  }
  writeString(s) {
    const b = te.encode(s);
    this.chunks.push(b);
    this.len += b.length;
  }
  writeBytes(u8) {
    const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    this.chunks.push(b);
    this.len += b.length;
  }
  toUint8Array() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
function writeObj(sink, id, bodyBytes) {
  sink.writeBytes(te.encode(`${id} 0 obj\n`));
  sink.writeBytes(bodyBytes);
  sink.writeBytes(te.encode("\nendobj\n"));
}
function writePlainDictObj(sink, id, dictStr) {
  writeObj(sink, id, te.encode(dictStr));
}

/* ===== glyph → string coercion ===== */
function strFrom(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number") {
    try {
      return String.fromCharCode(x);
    } catch {
      return String(x);
    }
  }
  if (typeof x === "object") {
    if (x.unicode) return x.unicode;
    if (x.isSpace) return " ";
    if (typeof x.originalCharCode === "number") {
      try {
        return String.fromCharCode(x.originalCharCode);
      } catch {}
    }
    return "";
  }
  return String(x);
}

/* ======================================================================
   Full IR → content stream BODY (string)  — now honors path styles
   ====================================================================== */
export function emitContentStreamFromFullIR(root) {
  let s = "";
  const tok = {
    transform: "cm",
    setDash: "d",
    setLineWidth: "w",
    setLineCap: "J",
    setLineJoin: "j",
    setMiterLimit: "M",
    setStrokeRGBColor: "RG",
    setFillRGBColor: "rg",
    setStrokeGray: "G",
    setFillGray: "g",
    setStrokeCMYKColor: "K",
    setFillCMYKColor: "k",
    moveTo: "m",
    lineTo: "l",
    curveTo: "c",
    curveTo2: "v",
    curveTo3: "y",
    rectangle: "re",
    closePath: "h",
    stroke: "S",
    closeStroke: "s",
    fill: "f",
    eoFill: "f*",
    fillStroke: "B",
    eoFillStroke: "B*",
    clip: "W",
    eoClip: "W*",
    setFont: "Tf",
    setCharSpacing: "Tc",
    setWordSpacing: "Tw",
    setLeading: "TL",
    setTextRise: "Ts",
    setTextRenderingMode: "Tr",
    moveText: "Td",
    moveTextSetLeading: "TD",
    setTextMatrix: "Tm",
    showText: "Tj",
    showSpacedText: "TJ",
  };

  // Track CTM to handle images with absolute positioning
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack = [];
  
  function mulCTM(a, b) {
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];
  }
  
  function inverseCTM(m) {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-10) {
      // Singular matrix, return identity
      return [1, 0, 0, 1, 0, 0];
    }
    return [
      d / det,
      -b / det,
      -c / det,
      a / det,
      (c * f - d * e) / det,
      (b * e - a * f) / det,
    ];
  }

  function emitNode(node) {
    switch (node.type) {
      case "save":
        s += "q\n";
        ctmStack.push(ctm.slice());
        (node.children || []).forEach(emitNode);
        ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
        s += "Q\n";
        break;

      case "text": {
        s += "BT\n";
        for (const ch of node.children || []) {
          if (ch.type !== "op") continue;
          const t = tok[ch.op];
          if (!t) {
            s += `% unsupported text op ${ch.op}\n`;
            continue;
          }

          if (t === "Tj") {
            const a = argsAry(ch.args);
            const s0 = a.length ? strFrom(a[0]) : "";
            s += `(${esc(s0)}) Tj\n`;
          } else if (t === "TJ") {
            const raw = argsAry(ch.args)[0] || [];
            const seq = (Array.isArray(raw) ? raw : [raw]).map((item) =>
              typeof item === "number" ? num(item) : `(${esc(strFrom(item))})`
            );
            s += `[ ${seq.join(" ")} ] TJ\n`;
          } else if (t === "Tf") {
            const a = argsAry(ch.args);
            const fontName = a[0] ? String(a[0]).replace(/^\//, "") : "F1";
            const size = a[1] ?? 12;
            s += `/${fontName} ${num(size)} Tf\n`;
          } else {
            s += `${argsAry(ch.args).map(renderArg).join(" ")} ${t}\n`;
          }
        }
        s += "ET\n";
        break;
      }

      case "form":
        s += `% form ${node.name || ""} begin\n`;
        (node.children || []).forEach(emitNode);
        s += `% form end\n`;
        break;

      case "image": {
        // Images have absolute CTM stored. To prevent compounding with current CTM,
        // we need to reset to identity first, then apply the image's absolute CTM.
        s += "q\n";
        if (node.cm && Array.isArray(node.cm) && node.cm.length === 6) {
          // Apply inverse of current CTM to reset to identity
          const inv = inverseCTM(ctm);
          if (inv[0] !== 1 || inv[1] !== 0 || inv[2] !== 0 || inv[3] !== 1 || inv[4] !== 0 || inv[5] !== 0) {
            s += `${inv.map(num).join(" ")} cm\n`;
          }
          // Apply the image's CTM, but flip the d component (vertical scale) to compensate
          // for the fact that harvested images are in correct orientation (not pre-flipped)
          const [a, b, c, d, e, f] = node.cm;
          s += `${num(a)} ${num(b)} ${num(c)} ${num(-d)} ${num(e)} ${num(f)} cm\n`;
        }
        s += `${nameTok(node.name)} Do\nQ\n`;
        break;
      }

      case "svgPath":
      case "path": {
        // styles
        if (node.transform && node.transform.length === 6)
          s += `${node.transform.map(num).join(" ")} cm\n`;
        if (Array.isArray(node.strokeColor))
          s += `${node.strokeColor.map(num).join(" ")} RG\n`;
        if (Array.isArray(node.fillColor))
          s += `${node.fillColor.map(num).join(" ")} rg\n`;
        if (node.lineWidth != null) s += `${num(node.lineWidth)} w\n`;
        if (node.lineCap != null) s += `${num(node.lineCap)} J\n`;
        if (node.lineJoin != null) s += `${num(node.lineJoin)} j\n`;
        if (node.miterLimit != null) s += `${num(node.miterLimit)} M\n`;
        if (node.dash && Array.isArray(node.dash.array)) {
          const arrStr = `[ ${node.dash.array.map(num).join(" ")} ]`;
          const phase = num(node.dash.phase || 0);
          s += `${arrStr} ${phase} d\n`;
        }

        for (const seg of node.segments || []) {
          const [op, ...a] = seg;
          s += `${a.map(num).join(" ")} ${op}\n`;
        }
        if (node.fill && node.stroke) s += node.evenOdd ? "B*\n" : "B\n";
        else if (node.fill) s += node.evenOdd ? "f*\n" : "f\n";
        else if (node.stroke) s += "S\n";
        else s += "n\n";
        break;
      }

      case "op": {
        const t = tok[node.op];
        if (!t) {
          s += `% unsupported op ${node.op}\n`;
          break;
        }
        s += `${argsAry(node.args).map(renderArg).join(" ")} ${t}\n`;
        // Track CTM updates for transform operators
        if (node.op === "transform" && Array.isArray(node.args) && node.args.length === 6) {
          ctm = mulCTM(ctm, node.args);
        }
        break;
      }

      default:
        s += `% unknown node ${node.type}\n`;
    }
  }

  (root.children || []).forEach(emitNode);
  return s;
}

/* ======================================================================
   Text IR (simple) page → content stream
   ====================================================================== */
function makeTextStream(page) {
  let body = "BT\n";
  // Ensure text has visible fill color (black)
  body += "0 g\n";
  let lastSize = null;
  for (const t of page.textItems || []) {
    const s = t.str ?? "";
    const x = Number.isFinite(t.x) ? t.x : 0;
    const y = Number.isFinite(t.y) ? t.y : 0;
    const size = Number.isFinite(t.fontSize) ? t.fontSize : 12;
    if (size !== lastSize) {
      body += `/F1 ${Number(size.toFixed(2))} Tf\n`;
      lastSize = size;
    }
    body += `1 0 0 1 ${num(x)} ${num(y)} Tm\n`;
    body += `(${esc(s)}) Tj\n`;
  }
  body += "ET\n";
  return body;
}

function pageContentsToStreamObj(page) {
  const body = page.rawStream || makeTextStream(page);
  const header = te.encode(`<< /Length ${body.length} >>\nstream\n`);
  const footer = te.encode("endstream\n");
  const bodyBytes = te.encode(body);
  const u8 = new Uint8Array(header.length + bodyBytes.length + footer.length);
  u8.set(header, 0);
  u8.set(bodyBytes, header.length);
  u8.set(footer, header.length + bodyBytes.length);
  return u8;
}

/* ======================================================================
   Assets: XObjects (JPEG only in this demo)
   ====================================================================== */
function dataUrlToBytes(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl || "");
  if (!m) throw new Error("xobject dataUrl must be base64 (e.g., image/jpeg)");
  const mime = m[1];
  const b64 = m[2];
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { mime, bytes: u8 };
}
function jpegSize(u8) {
  let p = 2;
  while (p + 9 < u8.length) {
    if (u8[p] !== 0xff) {
      p++;
      continue;
    }
    const m = u8[p + 1];
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (m === 0xc0 || m === 0xc2) {
      return {
        w: (u8[p + 7] << 8) | u8[p + 8],
        h: (u8[p + 5] << 8) | u8[p + 6],
      };
    }
    p += 2 + len;
  }
  return null;
}
function buildXObjectsFromAssets(assets, startId = 3) {
  const objects = [];
  const map = {};
  let nextId = startId;
  for (const [name, spec] of Object.entries(assets || {})) {
    if (!spec?.dataUrl) continue;
    const { mime, bytes } = dataUrlToBytes(spec.dataUrl);
    // Use case-insensitive comparison for MIME type
    if (mime.toLowerCase() !== "image/jpeg") continue; // demo: JPEG only
    let W = spec.width,
      H = spec.height;
    if (!W || !H) {
      const sz = jpegSize(bytes);
      if (sz) {
        W = W || sz.w;
        H = H || sz.h;
      }
    }
    if (!W || !H) {
      W = 100;
      H = 100;
    }
    const id = nextId++;
    map[name] = id;
    const imgDict = dict({
      Type: "/XObject",
      Subtype: "/Image",
      Width: W,
      Height: H,
      ColorSpace: "/DeviceRGB",
      BitsPerComponent: 8,
      Filter: "/DCTDecode",
      Length: bytes.length,
    });
    const head = te.encode(imgDict + "stream\n");
    const tail = te.encode("endstream\n");
    const buf = new Uint8Array(head.length + bytes.length + tail.length);
    buf.set(head, 0);
    buf.set(bytes, head.length);
    buf.set(tail, head.length + bytes.length);
    objects.push({ id, bytes: buf });
  }
  const dictStr = Object.keys(map).length
    ? `<< ${Object.entries(map)
        .map(([n, id]) => `/${n} ${id} 0 R`)
        .join(" ")} >>`
    : null;
  return { dictStr, objects, nextId };
}

/* ======================================================================
   Fonts: Base14 aliasing
   ====================================================================== */
function buildFontAliases(fontAliases, startId) {
  const objs = [];
  let nextId = startId;
  const dictEntries = [];
  if (!fontAliases || !Object.keys(fontAliases).length)
    return { dictStr: null, objects: objs, nextId };
  for (const [fname, base] of Object.entries(fontAliases)) {
    const id = nextId++;
    const baseName =
      base === "Helvetica" || base === "Times" || base === "Courier"
        ? base
        : "Helvetica";
    const dictStr = `<< /Type /Font /Subtype /Type1 /BaseFont /${baseName} >>\n`;
    objs.push({ id, bytes: te.encode(dictStr) });
    dictEntries.push(`/${fname} ${id} 0 R`);
  }
  const dictStr = `<< ${dictEntries.join(" ")} >>`;
  return { dictStr, objects: objs, nextId };
}

/* ======================================================================
   XRef helpers
   ====================================================================== */
function encodeXrefEntries(offsets) {
  const size = offsets.length,
    entryLen = 1 + 4 + 2;
  const bytes = new Uint8Array(size * entryLen);
  let p = 0;
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) {
      bytes[p + i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    p += n;
  };
  put(0, 1);
  put(0, 4);
  put(65535, 2);
  for (let i = 1; i < size; i++) {
    put(1, 1);
    put(offsets[i] || 0, 4);
    put(0, 2);
  }
  return bytes;
}

/* ======================================================================
   PDF builders
   ====================================================================== */
function buildPdf14FromIR(doc) {
  const sink = new ByteSink();
  sink.writeString("%PDF-1.4\n%âãÏÓ\n");
  const catalogId = 1,
    pagesId = 2;
  let nextId = 3;
  const offsets = [];
  const record = (id) => {
    offsets[id] = sink.length();
  };

  const xo = buildXObjectsFromAssets(doc.xobjects || {}, nextId);
  nextId = xo.nextId;
  for (const o of xo.objects) {
    record(o.id);
    writeObj(sink, o.id, o.bytes);
  }

  const fa = buildFontAliases(doc.fontAliases || {}, nextId);
  nextId = fa.nextId;
  for (const o of fa.objects) {
    record(o.id);
    writePlainDictObj(sink, o.id, td.decode(o.bytes));
  }

  const pageObjs = [];
  for (const p of doc.pages) {
    const pageId = nextId++,
      contentsId = nextId++;
    pageObjs.push({ pageId, contentsId, p });
    record(contentsId);
    writeObj(sink, contentsId, pageContentsToStreamObj(p));
  }

  const kids = pageObjs.map((po) => `${po.pageId} 0 R`).join(" ");
  record(pagesId);
  writePlainDictObj(
    sink,
    pagesId,
    `<< /Type /Pages /Count ${pageObjs.length} /Kids [ ${kids} ] >>\n`
  );

  for (const po of pageObjs) {
    record(po.pageId);
    const w = num(po.p.width || 612),
      h = num(po.p.height || 792);
    const resources = `<<${fa.dictStr ? ` /Font ${fa.dictStr}` : ""}${
      xo.dictStr ? ` /XObject ${xo.dictStr}` : ""
    } >>`;
    writePlainDictObj(
      sink,
      po.pageId,
      `<< /Type /Page
/Parent ${pagesId} 0 R
/MediaBox [0 0 ${w} ${h}]
/Resources ${resources}
/Contents ${po.contentsId} 0 R
>>\n`
    );
  }

  record(catalogId);
  writePlainDictObj(
    sink,
    catalogId,
    `<< /Type /Catalog /Pages ${pagesId} 0 R >>\n`
  );

  const xrefStart = sink.length();
  let tbl = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    const off = offsets[i] || 0;
    tbl += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  sink.writeString(tbl);
  sink.writeString(
    `trailer\n<< /Size ${offsets.length} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  );
  return sink.toUint8Array();
}

function buildXrefStream(doc, headerVersion) {
  const sink = new ByteSink();
  sink.writeString(`%PDF-${headerVersion}\n%âãÏÓ\n`);
  const catalogId = 1,
    pagesId = 2;
  let nextId = 3;

  const xo = buildXObjectsFromAssets(doc.xobjects || {}, nextId);
  nextId = xo.nextId;
  const offsets = new Array(nextId).fill(0);
  const at = () => sink.length();
  for (const o of xo.objects) {
    offsets[o.id] = at();
    writeObj(sink, o.id, o.bytes);
  }

  const fa = buildFontAliases(doc.fontAliases || {}, nextId);
  nextId = fa.nextId;
  for (const o of fa.objects) {
    offsets[o.id] = at();
    writePlainDictObj(sink, o.id, td.decode(o.bytes));
  }

  const pageObjs = [];
  for (const p of doc.pages) {
    const pageId = nextId++,
      contentsId = nextId++;
    pageObjs.push({ pageId, contentsId, p });
    offsets[contentsId] = at();
    writeObj(sink, contentsId, pageContentsToStreamObj(p));
  }

  offsets[pagesId] = at();
  const kids = pageObjs.map((po) => `${po.pageId} 0 R`).join(" ");
  writePlainDictObj(
    sink,
    pagesId,
    `<< /Type /Pages /Count ${pageObjs.length} /Kids [ ${kids} ] >>\n`
  );

  for (const po of pageObjs) {
    offsets[po.pageId] = at();
    const w = num(po.p.width || 612),
      h = num(po.p.height || 792);
    const resources = `<<${fa.dictStr ? ` /Font ${fa.dictStr}` : ""}${
      xo.dictStr ? ` /XObject ${xo.dictStr}` : ""
    } >>`;
    writePlainDictObj(
      sink,
      po.pageId,
      `<< /Type /Page
/Parent ${pagesId} 0 R
/MediaBox [0 0 ${w} ${h}]
/Resources ${resources}
/Contents ${po.contentsId} 0 R
>>\n`
    );
  }

  offsets[catalogId] = at();
  writePlainDictObj(
    sink,
    catalogId,
    `<< /Type /Catalog /Pages ${pagesId} 0 R >>\n`
  );

  const xrefId = nextId++;
  const xrefOffset = at();
  offsets[xrefId] = xrefOffset;
  const entries = encodeXrefEntries(offsets);
  const xDict = dict({
    Type: "/XRef",
    Size: offsets.length,
    Root: `${catalogId} 0 R`,
    W: "[1 4 2]",
    Index: `[0 ${offsets.length}]`,
    Length: entries.length,
  });
  const head = te.encode(xDict + "stream\n"),
    tail = te.encode("endstream\n");
  const buf = new Uint8Array(head.length + entries.length + tail.length);
  buf.set(head, 0);
  buf.set(entries, head.length);
  buf.set(tail, head.length + entries.length);
  writeObj(sink, xrefId, buf);
  sink.writeString(`startxref\n${xrefOffset}\n%%EOF\n`);
  return sink.toUint8Array();
}

/* ======================================================================
   Facade
   ====================================================================== */
export function buildPdfFromIR(doc, opts = {}) {
  const version = String(opts.version || "2.0");
  if (version === "1.4") return buildPdf14FromIR(doc);
  return buildXrefStream(doc, version === "1.7" ? "1.7" : "2.0");
}
