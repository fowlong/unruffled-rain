// src/app.js
import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import PdfWorker from "pdfjs-dist/build/pdf.worker.mjs?worker";
import { buildPdfFromIR, emitContentStreamFromFullIR } from "./pdf_writer.js";
import { renderIRToCanvas } from "./renderer.js";

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const pageSelect = $("pageSelect");
const tree = $("tree");
const irTextarea = $("irTextarea");
const applyIrBtn = $("applyIrBtn");
const exportBtn = $("exportBtn");
const versionSelect = $("versionSelect");
const irModeSelect = $("irModeSelect");
const exportModeSelect = $("exportModeSelect");
const editorCanvas = $("editorCanvas");
const zoomSlider = $("zoomSlider");
const zoomLabel = $("zoomLabel");
const rerenderBtn = $("rerenderBtn");

let g = {
  pdfDoc: null,
  opNameByCode: null,
  textIRByPage: new Map(),
  fullIRByPage: new Map(),
  assetsByName: {}, // { name: {dataUrl, _img} }
  pageSize: { w: 612, h: 792 },
};

/* ---------------- save helper ---------------- */
async function saveBytesAs(filename, bytes) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  if ("showSaveFilePicker" in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          { description: "PDF", accept: { "application/pdf": [".pdf"] } },
        ],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch {
    window.open(url, "_blank", "noopener");
  }
  setTimeout(() => URL.revokeObjectURL(url), 12000);
}

/* ---------------- image assets ---------------- */
async function addImageAsset(name, dataUrl) {
  const img = new Image();
  img.decoding = "async";
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = dataUrl;
  });
  g.assetsByName[name] = { dataUrl, _img: img };
}

/* ---------------- glyph → string helpers ---------------- */
function glyphToChar(glyph) {
  if (glyph == null) return "";
  if (typeof glyph === "string") return glyph;
  if (typeof glyph === "number") {
    try {
      return String.fromCharCode(glyph);
    } catch {
      return "";
    }
  }
  if (typeof glyph === "object") {
    if (glyph.unicode) return glyph.unicode;
    if (glyph.isSpace) return " ";
    if (typeof glyph.originalCharCode === "number") {
      try {
        return String.fromCharCode(glyph.originalCharCode);
      } catch {}
    }
  }
  return "";
}
function glyphRunToString(run) {
  if (run == null) return "";
  if (typeof run === "string") return run;
  if (Array.isArray(run)) return run.map(glyphToChar).join("");
  if (typeof run === "object") return glyphToChar(run);
  return String(run);
}

/* ---------------- name normalizer (for /XObject names) ---------------- */
function sanitizePdfName(n) {
  // make a valid PDF Name token and keep it stable
  const raw = String(n ?? "Im");
  let out = "Im";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    const ok =
      (code >= 48 && code <= 57) || // 0-9
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      ch === "_" ||
      ch === "."; // common safe extras
    out += ok ? ch : "#" + code.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/* ---------------- load PDF ---------------- */
fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const ab = await file.arrayBuffer();
  g.pdfDoc = await pdfjsLib.getDocument({ data: ab }).promise;

  if (!g.opNameByCode) {
    g.opNameByCode = {};
    for (const [name, code] of Object.entries(pdfjsLib.OPS)) {
      g.opNameByCode[code] = name;
    }
  }

  pageSelect.innerHTML = "";
  for (let i = 1; i <= g.pdfDoc.numPages; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Page ${i}`;
    pageSelect.appendChild(opt);
  }
  pageSelect.disabled = false;
  exportBtn.disabled = false;

  await loadPage(1);
});

pageSelect.addEventListener("change", () => {
  if (g.pdfDoc) void loadPage(parseInt(pageSelect.value || "1", 10));
});
irModeSelect.addEventListener("change", () => {
  if (g.pdfDoc) void loadPage(parseInt(pageSelect.value || "1", 10));
});
zoomSlider.addEventListener("input", () => {
  zoomLabel.textContent = `${zoomSlider.value}%`;
  rerenderCanvas();
});
rerenderBtn.addEventListener("click", rerenderCanvas);

applyIrBtn.addEventListener("click", async () => {
  try {
    const edited = JSON.parse(irTextarea.value);

    if (irModeSelect.value === "text") {
      if (!Array.isArray(edited.pages))
        throw new Error("Text IR must have pages[]");
      edited.pages.forEach((pg, i) => {
        if (!Array.isArray(pg.textItems)) {
          throw new Error(`pages[${i}].textItems must be array`);
        }
      });
      g.textIRByPage.set(currentPage(), edited.pages[0]);
    } else {
      if (
        !edited ||
        edited.type !== "root" ||
        !Array.isArray(edited.children)
      ) {
        throw new Error(
          "Full IR must be a { type:'root', children:[...] } tree"
        );
      }
      if (edited.xobjects && typeof edited.xobjects === "object") {
        for (const [name, spec] of Object.entries(edited.xobjects)) {
          if (spec?.dataUrl)
            await addImageAsset(sanitizePdfName(name), spec.dataUrl);
        }
      }
      // normalize any image names inside provided tree
      normalizeImageNamesInTree(edited);
      g.fullIRByPage.set(currentPage(), {
        type: "root",
        children: edited.children,
      });
    }

    rerenderCanvas();
    alert("IR applied.");
  } catch (err) {
    alert("Invalid IR: " + err.message);
  }
});

/* =======================================================================
   🍒 Asset Harvester
   - renders page to an offscreen canvas (hi-res)
   - crops the exact quads for every image node (via its CTM)
   - stores them as JPEG /XObject assets under normalized names
   ======================================================================= */
const HARVEST_SCALE = 2; // 2x is fine; use 3 for tiny logos

function mul6(a, b) {
  // 2D affine: [a b c d e f] x [A B C D E F]
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function apply6(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function rectFromCMInViewport(cm, viewport) {
  const vm = viewport.transform; // [sx, 0, 0, -sy, 0, height]
  const M = mul6(vm, cm);
  const p0 = apply6(M, 0, 0);
  const p1 = apply6(M, 1, 0);
  const p2 = apply6(M, 0, 1);
  const p3 = apply6(M, 1, 1);
  const xs = [p0[0], p1[0], p2[0], p3[0]];
  const ys = [p0[1], p1[1], p2[1], p3[1]];
  const x = Math.min(...xs),
    y = Math.min(...ys);
  const w = Math.max(...xs) - x,
    h = Math.max(...ys) - y;
  return { x, y, w, h };
}

function normalizeImageNamesInTree(root) {
  (function walk(n) {
    if (n?.type === "image" && n.name) n.name = sanitizePdfName(n.name);
    (n.children || []).forEach(walk);
  })(root);
}

async function ensureImageAssetsForPage(page, fullIR, scale = HARVEST_SCALE) {
  // normalize image names consistently first
  normalizeImageNamesInTree(fullIR);

  // collect missing image nodes
  const missing = [];
  (function walk(n) {
    if (n?.type === "image" && n.name && !g.assetsByName[n.name])
      missing.push(n);
    (n.children || []).forEach(walk);
  })(fullIR);
  if (!missing.length) return;

  // render page offscreen (pdf.js renders with its own Y-up → we’ll just crop)
  const viewport = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.floor(viewport.width));
  c.height = Math.max(1, Math.floor(viewport.height));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;

  // crop each image quad and store as JPEG XObject
  for (const node of missing) {
    const cm =
      Array.isArray(node.cm) && node.cm.length === 6
        ? node.cm
        : [1, 0, 0, 1, 0, 0];
    const r = rectFromCMInViewport(cm, viewport);

    // clamp to canvas bounds
    const sx = Math.max(0, Math.min(c.width, Math.floor(r.x)));
    const sy = Math.max(0, Math.min(c.height, Math.floor(r.y)));
    const sw = Math.max(1, Math.min(c.width - sx, Math.ceil(r.w)));
    const sh = Math.max(1, Math.min(c.height - sy, Math.ceil(r.h)));
    if (sw <= 1 || sh <= 1) continue;

    const sub = document.createElement("canvas");
    sub.width = sw;
    sub.height = sh;
    const sctx = sub.getContext("2d");

    // pdf.js renders images correctly oriented (it handles the CTM flip internally).
    // But when we export to PDF, we'll use the original CTM which typically has negative d.
    // So we need to flip the harvested image vertically so that the PDF's CTM will flip it back.
    sctx.translate(0, sh);
    sctx.scale(1, -1);
    sctx.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);

    try {
      const dataUrl = sub.toDataURL("image/jpeg", 0.92);
      await addImageAsset(node.name, dataUrl); // node.name already normalized
    } catch (err) {
      console.warn("asset harvest failed for", node.name, err);
    }
  }
}

/* ---------------- export ---------------- */
exportBtn.addEventListener("click", async () => {
  if (!g.pdfDoc) return;
  const version = versionSelect.value;
  const mode = exportModeSelect.value; // "new" | "incremental" (beta scaffold)

  const pages = [];
  for (let p = 1; p <= g.pdfDoc.numPages; p++) {
    const page = await g.pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    const width = viewport.width,
      height = viewport.height;

    if (irModeSelect.value === "text") {
      const textIR = g.textIRByPage.get(p) || (await buildTextIRForPage(page));
      pages.push({ width, height, textItems: textIR.textItems });
    } else {
      const fullIR = g.fullIRByPage.get(p) || (await buildFullIRForPage(page));
      // make sure all image XObjects used by this page exist and names are normalized
      await ensureImageAssetsForPage(page, fullIR, HARVEST_SCALE);

      const raw = emitContentStreamFromFullIR(fullIR);
      pages.push({ width, height, rawStream: raw, irFonts: fontsUsed(fullIR) });
    }
  }

  if (mode === "incremental") {
    alert("Incremental export not wired yet; falling back to New PDF.");
  }

  const bytes = buildPdfFromIR(
    {
      pages,
      mode: irModeSelect.value === "full" ? "raw" : undefined,
      xobjects: g.assetsByName, // normalized keys
      fontAliases: collectFontAliases(pages),
    },
    { version }
  );
  await saveBytesAs(`edited-v${version}.pdf`, bytes);
});

/* ---------------- per-page loaders ---------------- */
async function loadPage(n) {
  if (!g.pdfDoc) return;
  const page = await g.pdfDoc.getPage(n);
  const viewport = page.getViewport({ scale: 1.0 });
  g.pageSize = { w: viewport.width, h: viewport.height };

  const opIR = await buildOperatorIRForPage(page);
  renderTree(opIR);

  if (irModeSelect.value === "text") {
    const textIR = g.textIRByPage.get(n) || (await buildTextIRForPage(page));
    g.textIRByPage.set(n, textIR);
    irTextarea.value = JSON.stringify(
      {
        pages: [
          {
            width: viewport.width,
            height: viewport.height,
            textItems: textIR.textItems,
          },
        ],
      },
      null,
      2
    );
  } else {
    const fullIR = g.fullIRByPage.get(n) || (await buildFullIRForPage(page));
    // normalize names + harvest any missing image assets so preview/export can place them
    normalizeImageNamesInTree(fullIR);
    await ensureImageAssetsForPage(page, fullIR, HARVEST_SCALE);

    g.fullIRByPage.set(n, fullIR);
    irTextarea.value = JSON.stringify(
      { ...fullIR, xobjects: currentXObjectsAssetBag() },
      null,
      2
    );
  }

  rerenderCanvas();
  applyIrBtn.disabled = false;
}

/* ---------------- IR builders ---------------- */
async function buildOperatorIRForPage(page) {
  const operatorList = await page.getOperatorList();
  const items = operatorList.fnArray.map((fn, i) => ({
    index: i,
    op: g.opNameByCode[fn] || `OP_${fn}`,
    args: sanitizeArgs(operatorList.argsArray[i]),
  }));
  return { pageIndex: page.pageNumber, items };
}

async function buildTextIRForPage(page) {
  const textContent = await page.getTextContent();
  const items = textContent.items.map((it) => {
    const [, , c, d, e, f] = it.transform;
    const fontSize = Math.hypot(c, d) || Math.abs(d) || 12;
    return { str: it.str, x: e, y: f, fontSize: Number(fontSize.toFixed(2)) };
  });
  return { textItems: items };
}

/* ------------ FULL IR with graphics-state capture + CTM + constructPath ------------ */
async function buildFullIRForPage(page) {
  const ol = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;

  // For constructPath decoding
  const opNameByCode =
    g.opNameByCode ||
    (g.opNameByCode = Object.fromEntries(
      Object.entries(pdfjsLib.OPS).map(([k, v]) => [v, k])
    ));

  const root = { type: "root", children: [] };
  const stack = [root];

  // --- CTM tracking ---
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack = [];
  function mul(a, b) {
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];
  }

  // --- live graphics state we stamp onto paths ---
  const GS_DEFAULT = {
    strokeColor: [0, 0, 0],
    fillColor: [0, 0, 0],
    lineWidth: 1,
    dash: null,
    lineCap: null,
    lineJoin: null,
    miterLimit: null,
  };
  let gs = { ...GS_DEFAULT };

  let curPath = null;
  const freshPath = () => ({
    type: "path",
    segments: [],
    stroke: false,
    fill: false,
    evenOdd: false,
    strokeColor: gs.strokeColor ? [...gs.strokeColor] : undefined,
    fillColor: gs.fillColor ? [...gs.fillColor] : undefined,
    lineWidth: gs.lineWidth,
    dash: gs.dash ? { array: [...gs.dash.array], phase: gs.dash.phase } : null,
    lineCap: gs.lineCap,
    lineJoin: gs.lineJoin,
    miterLimit: gs.miterLimit,
  });
  const flushPath = () => {
    if (curPath && curPath.segments?.length)
      stack.at(-1).children.push(curPath);
    curPath = null;
  };

  const push = (n) => {
    stack.at(-1).children.push(n);
    stack.push(n);
  };
  const pop = () => {
    if (stack.length > 1) stack.pop();
  };

  function addSeg(op, arr) {
    (curPath ||= freshPath()).segments.push([op, ...(arr || [])]);
  }

  function decodeConstructPath(arg) {
    const opsArr = Array.isArray(arg?.[0]) ? arg[0] : [];
    const coords = Array.isArray(arg?.[1]) ? arg[1] : [];
    let i = 0;
    for (const code of opsArr) {
      const name = opNameByCode[code] || "";
      switch (name) {
        case "moveTo":
          addSeg("m", [coords[i++], coords[i++]]);
          break;
        case "lineTo":
          addSeg("l", [coords[i++], coords[i++]]);
          break;
        case "curveTo":
          addSeg("c", [
            coords[i++],
            coords[i++],
            coords[i++],
            coords[i++],
            coords[i++],
            coords[i++],
          ]);
          break;
        case "closePath":
          addSeg("h");
          break;
        case "rectangle":
          addSeg("re", [coords[i++], coords[i++], coords[i++], coords[i++]]);
          break;
        default:
          break;
      }
    }
  }

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const op = g.opNameByCode[fn] || `OP_${fn}`;
    const rawArgs = ol.argsArray[i];
    const args = sanitizeArgs(rawArgs);

    switch (fn) {
      case OPS.save:
        flushPath();
        push({ type: "save", children: [] });
        ctmStack.push(ctm.slice());
        break;
      case OPS.restore:
        flushPath();
        pop();
        ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
        break;

      case OPS.beginText:
        flushPath();
        push({ type: "text", children: [] });
        break;
      case OPS.endText:
        flushPath();
        if (stack.at(-1).type === "text") pop();
        break;

      case OPS.paintFormXObjectBegin:
        flushPath();
        push({ type: "form", name: args?.[0] || null, children: [] });
        ctmStack.push(ctm.slice());
        break;
      case OPS.paintFormXObjectEnd:
        flushPath();
        if (stack.at(-1).type === "form") pop();
        ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
        break;

      // text & color ops — keep literally
      case OPS.setFont:
      case OPS.setCharSpacing:
      case OPS.setWordSpacing:
      case OPS.setLeading:
      case OPS.moveText:
      case OPS.moveTextSetLeading:
      case OPS.setTextMatrix:
      case OPS.setTextRise:
      case OPS.setTextRenderingMode:
      case OPS.setFillRGBColor:
      case OPS.setFillGray:
      case OPS.setStrokeRGBColor:
      case OPS.setStrokeGray:
        flushPath();
        stack.at(-1).children.push({ type: "op", op, args });
        break;

      case OPS.showText: {
        flushPath();
        const s = glyphRunToString(Array.isArray(args) ? args[0] : args);
        stack.at(-1).children.push({ type: "op", op: "showText", args: s });
        break;
      }
      case OPS.showSpacedText: {
        flushPath();
        const src = Array.isArray(args) ? args[0] ?? [] : args ?? [];
        const norm = (Array.isArray(src) ? src : [src]).map((item) =>
          typeof item === "number" ? item : glyphRunToString(item)
        );
        stack
          .at(-1)
          .children.push({ type: "op", op: "showSpacedText", args: [norm] });
        break;
      }

      case OPS.transform: {
        flushPath();
        const m = Array.isArray(args) ? args : [1, 0, 0, 1, 0, 0];
        ctm = mul(ctm, m);
        stack.at(-1).children.push({ type: "op", op: "transform", args: m });
        break;
      }

      // graphics state for paths
      case OPS.setStrokeRGBColor:
        gs.strokeColor = [args[0], args[1], args[2]];
        if (curPath) curPath.strokeColor = [...gs.strokeColor];
        break;
      case OPS.setFillRGBColor:
        gs.fillColor = [args[0], args[1], args[2]];
        if (curPath) curPath.fillColor = [...gs.fillColor];
        break;
      case OPS.setStrokeGray:
        gs.strokeColor = [args[0], args[0], args[0]];
        if (curPath) curPath.strokeColor = [...gs.strokeColor];
        break;
      case OPS.setFillGray:
        gs.fillColor = [args[0], args[0], args[0]];
        if (curPath) curPath.fillColor = [...gs.fillColor];
        break;
      case OPS.setLineWidth:
        gs.lineWidth = args[0];
        if (curPath) curPath.lineWidth = gs.lineWidth;
        break;
      case OPS.setLineCap:
        gs.lineCap = args[0];
        if (curPath) curPath.lineCap = gs.lineCap;
        break;
      case OPS.setLineJoin:
        gs.lineJoin = args[0];
        if (curPath) curPath.lineJoin = gs.lineJoin;
        break;
      case OPS.setMiterLimit:
        gs.miterLimit = args[0];
        if (curPath) curPath.miterLimit = gs.miterLimit;
        break;
      case OPS.setDash: {
        const dashArray = Array.isArray(args?.[0]) ? args[0] : [];
        const phase = Array.isArray(args) ? args[1] || 0 : 0;
        gs.dash = { array: dashArray, phase };
        if (curPath) curPath.dash = { array: [...dashArray], phase };
        break;
      }

      // path building
      case OPS.constructPath:
        decodeConstructPath(rawArgs);
        break;
      case OPS.moveTo:
        addSeg("m", [args[0], args[1]]);
        break;
      case OPS.lineTo:
        addSeg("l", [args[0], args[1]]);
        break;
      case OPS.curveTo:
        addSeg("c", [args[0], args[1], args[2], args[3], args[4], args[5]]);
        break;
      case OPS.closePath:
        addSeg("h");
        break;
      case OPS.rectangle:
        addSeg("re", [args[0], args[1], args[2], args[3]]);
        break;

      // path paint
      case OPS.stroke:
      case OPS.eoFill:
      case OPS.fill:
      case OPS.fillStroke:
      case OPS.eoFillStroke: {
        curPath ||= freshPath();
        if (fn === OPS.stroke) curPath.stroke = true;
        if (fn === OPS.fill || fn === OPS.eoFill) curPath.fill = true;
        if (fn === OPS.fillStroke || fn === OPS.eoFillStroke) {
          curPath.fill = true;
          curPath.stroke = true;
        }
        curPath.evenOdd =
          fn === OPS.eoFill || fn === OPS.eoFillStroke || curPath.evenOdd;
        flushPath();
        break;
      }

      case OPS.endPath:
        flushPath();
        break;

      case OPS.clip:
      case OPS.eoClip:
        flushPath();
        stack.at(-1).children.push({ type: "op", op, args: null });
        break;

      // images/xobjects — carry CTM + normalized name
      case OPS.paintXObject:
      case OPS.paintImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintInlineImageXObject: {
        flushPath();
        let name = Array.isArray(args) && args.length ? args[0] : `Im_${i}`;
        name = sanitizePdfName(name);
        stack.at(-1).children.push({ type: "image", name, cm: ctm.slice() });
        break;
      }

      default:
        flushPath();
        stack.at(-1).children.push({ type: "op", op, args });
    }
  }

  flushPath();
  while (stack.length > 1) stack.pop();

  // Heads-up for missing XObject assets (affects export; preview draws placeholder)
  const missing = new Set();
  (function walk(n) {
    if (n?.type === "image" && n.name && !g.assetsByName[n.name])
      missing.add(n.name);
    (n.children || []).forEach(walk);
  })(root);
  if (missing.size) console.warn("Missing XObject assets for:", [...missing]);

  return root;
}

/* ---------------- canvas ---------------- */
function rerenderCanvas() {
  const page = currentPage();
  const root = g.fullIRByPage.get(page) || { type: "root", children: [] };
  renderIRToCanvas({
    root,
    canvas: editorCanvas,
    assets: g.assetsByName,
    width: g.pageSize.w,
    height: g.pageSize.h,
    zoom: parseInt(zoomSlider.value, 10),
  });
}

/* ---------------- helpers ---------------- */
function currentPage() {
  return parseInt(pageSelect.value || "1", 10);
}
function sanitizeArgs(a) {
  if (!a) return a;
  return Array.isArray(a) ? Array.from(a) : a;
}
function fontsUsed(root) {
  const set = new Set();
  (function walk(n) {
    if (n?.type === "op" && n.op === "setFont") {
      const name =
        Array.isArray(n.args) && typeof n.args[0] === "string"
          ? n.args[0].replace(/^\//, "")
          : null;
      if (name) set.add(name);
    }
    (n.children || []).forEach(walk);
  })(root);
  return [...set];
}
function collectFontAliases(pages) {
  const names = new Set();
  for (const p of pages) (p.irFonts || []).forEach((n) => names.add(n));
  const aliases = {};
  for (const n of names) {
    const key = String(n).toLowerCase();
    if (key.includes("times")) aliases[n] = "Times";
    else if (key.includes("courier")) aliases[n] = "Courier";
    else aliases[n] = "Helvetica";
  }
  return aliases;
}
function currentXObjectsAssetBag() {
  const bag = {};
  for (const [name, spec] of Object.entries(g.assetsByName))
    bag[name] = { dataUrl: spec.dataUrl };
  return bag;
}

/* ---- left panel renderer ---- */
function renderTree(opIR) {
  const lines = [];
  lines.push(`Page ${opIR.pageIndex} — ${opIR.items.length} operator(s)`, "");
  for (const it of opIR.items)
    lines.push(`${pad(it.index, 4)}  ${it.op}  ${formatArgs(it.args)}`);
  tree.textContent = lines.join("\n");
}
function pad(n, w) {
  const s = String(n);
  return " ".repeat(Math.max(0, w - s.length)) + s;
}
function formatArgs(args) {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}
