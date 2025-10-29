// Very small IR → Canvas2D renderer (vector only; no raster background)
// Supports: save/restore, transform, paths (stroke/fill), text (T*, Tm, TJ, Tj),
// basic text color, and image XObjects with absolute CTM.
export function renderIRToCanvas({
  root,
  canvas,
  assets,
  width,
  height,
  zoom = 100,
}) {
  const ctx = canvas.getContext("2d");
  const scale = (typeof zoom === "number" ? zoom : 100) / 100;

  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  // Device space: match PDF (origin bottom-left).
  ctx.setTransform(scale, 0, 0, -scale, 0, canvas.height);
  ctx.clearRect(0, 0, width, height);

  // Remember the "page base" transform so we can apply absolute CTMs for images.
  const PAGE_BASE = ctx.getTransform();

  const stateStack = [];
  function save() {
    stateStack.push(ctx.getTransform());
    ctx.save();
  }
  function restore() {
    const t = stateStack.pop();
    ctx.restore();
    if (t) ctx.setTransform(t);
  }

  function setToPageBase() {
    const b = PAGE_BASE;
    ctx.setTransform(b.a, b.b, b.c, b.d, b.e, b.f);
  }

  function applyCm(a, b, c, d, e, f) {
    const m = ctx.getTransform();
    ctx.setTransform(
      m.a * a + m.c * b,
      m.b * a + m.d * b,
      m.a * c + m.c * d,
      m.b * c + m.d * d,
      m.a * e + m.c * f + m.e,
      m.b * e + m.d * f + m.f
    );
  }

  function rgb([r, g, b]) {
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(
      b * 255
    )})`;
  }

  function drawPath(node) {
    ctx.beginPath();
    for (const seg of node.segments || []) {
      const [op, ...args] = seg;
      if (op === "m") ctx.moveTo(args[0], args[1]);
      else if (op === "l") ctx.lineTo(args[0], args[1]);
      else if (op === "c")
        ctx.bezierCurveTo(args[0], args[1], args[2], args[3], args[4], args[5]);
      else if (op === "h") ctx.closePath();
      else if (op === "re") ctx.rect(args[0], args[1], args[2], args[3]);
    }
    if (node.fill) {
      if (node.fillColor) ctx.fillStyle = rgb(node.fillColor);
      ctx.fill(node.evenOdd ? "evenodd" : "nonzero");
    }
    if (node.stroke) {
      if (node.strokeColor) ctx.strokeStyle = rgb(node.strokeColor);
      if (node.lineWidth != null) ctx.lineWidth = node.lineWidth;
      // optional: lineJoin/Cap/dash — ignored for now in preview
      ctx.stroke();
    }
  }

  function renderTextBlock(n) {
    save();
    // simple text styling we accept from ops inside the block
    let currentFill = null; // if null, canvas default is used
    let currentFontSize = 12;

    function drawText(str) {
      if (!str) return;
      const old = ctx.getTransform();
      // Canvas text is y-up; flip to baseline-friendly space.
      ctx.save();
      ctx.scale(1, -1);
      if (currentFill) ctx.fillStyle = currentFill;
      ctx.font = `${Math.max(1, currentFontSize)}px sans-serif`;
      ctx.fillText(String(str), 0, 0);
      ctx.restore();
      ctx.setTransform(old);
    }

    for (const child of n.children || []) {
      if (child.type !== "op") continue;
      switch (child.op) {
        case "setTextMatrix": {
          const a = child.args || [1, 0, 0, 1, 0, 0];
          applyCm(a[0], a[1], a[2], a[3], a[4], a[5]);
          break;
        }
        case "moveText": {
          const dx = child.args?.[0] || 0;
          const dy = child.args?.[1] || 0;
          applyCm(1, 0, 0, 1, dx, dy);
          break;
        }
        case "setFont": {
          // args: [name, size]
          const sz =
            Array.isArray(child.args) && typeof child.args[1] === "number"
              ? child.args[1]
              : currentFontSize;
          currentFontSize = sz;
          break;
        }
        case "setFillRGBColor": {
          const a = child.args || [0, 0, 0];
          currentFill = rgb([a[0], a[1], a[2]]);
          break;
        }
        case "setFillGray": {
          const g = child.args?.[0] ?? 0;
          currentFill = rgb([g, g, g]);
          break;
        }
        case "showText": {
          drawText(child.args);
          break;
        }
        case "showSpacedText": {
          // args: [ [ string | number (kerning) , ... ] ]
          const arr = Array.isArray(child.args?.[0]) ? child.args[0] : [];
          // We ignore the numeric kerning adjustments for preview.
          const text = arr
            .map((x) => (typeof x === "number" ? "" : String(x)))
            .join("");
          drawText(text);
          break;
        }
        // ignore other text-state ops for preview
        default:
          break;
      }
    }
    restore();
  }

  function renderNode(n) {
    switch (n.type) {
      case "save":
        save();
        (n.children || []).forEach(renderNode);
        restore();
        break;

      case "op":
        if (n.op === "transform") {
          const a = n.args || [1, 0, 0, 1, 0, 0];
          applyCm(a[0], a[1], a[2], a[3], a[4], a[5]);
        }
        // clip & setGState etc. are ignored in preview
        break;

      case "text":
        renderTextBlock(n);
        break;

      case "path":
      case "svgPath":
        drawPath(n);
        break;

      case "image": {
        // Use absolute CTM recorded on the node to avoid double-applying
        // any transforms we already replayed from siblings.
        const prev = ctx.getTransform();
        setToPageBase();
        if (n.cm && n.cm.length === 6)
          applyCm(n.cm[0], n.cm[1], n.cm[2], n.cm[3], n.cm[4], n.cm[5]);

        const im = assets?.[n.name];
        if (im && im._img) {
          // Paint image in 1x1 coords scaled by CTM.
          ctx.drawImage(im._img, 0, 0, 1, 1);
        } else {
          // placeholder rectangle so you can see where the image would be
          ctx.fillStyle = "#ddd";
          ctx.fillRect(0, 0, 1, 1);
          ctx.strokeStyle = "#999";
          ctx.strokeRect(0, 0, 1, 1);
        }

        ctx.setTransform(prev);
        break;
      }

      case "form":
        save();
        (n.children || []).forEach(renderNode);
        restore();
        break;

      default:
        (n.children || []).forEach(renderNode);
        break;
    }
  }

  (root.children || []).forEach(renderNode);
}
