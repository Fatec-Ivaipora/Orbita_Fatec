// ==========================================================================
// PDF das folhas de resposta (Correção de Provas) — gerado no navegador, sem biblioteca externa.
// Converte o SVG de cada folha (folha.js, medidas em mm) em uma página A4 de PDF: retângulos, círculos,
// linhas, caminhos retos, textos (Helvetica/Courier, codificação WinAnsi, que tem os acentos do
// português) e o logo (JPEG). Como as medidas são as mesmas, o leitor lê a folha impressa do PDF.
// ==========================================================================
const PT = 72 / 25.4;                  // 1 mm em pontos
const PW = 210 * PT, PH = 297 * PT;    // A4
const cor = (hex) => {
  const h = String(hex || '#000').replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
  return [0, 2, 4].map(i => (parseInt(v.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
};
const n = (v) => (Math.round(v * 100) / 100).toString();
// WinAnsi (cp1252): caracteres acima de 0x7F que não são latin-1
const CP1252 = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
function textoPdf(s) {
  let out = '';
  for (const ch of String(s)) {
    let c = ch.codePointAt(0);
    if (CP1252[ch]) c = CP1252[ch];
    else if (c > 255 || (c >= 0x80 && c < 0xa0)) c = 0x3f;   // fora do WinAnsi vira "?"
    const b = String.fromCharCode(c);
    out += b === '(' || b === ')' || b === '\\' ? '\\' + b : c < 32 ? ' ' : b;
  }
  return out;
}
const medidor = document.createElement('canvas').getContext('2d');
function largura(txt, tamPt, negrito, mono) {
  medidor.font = `${negrito ? 'bold ' : ''}${tamPt}px ${mono ? 'Courier New, monospace' : 'Helvetica, Arial, sans-serif'}`;
  return medidor.measureText(txt).width;
}
// fontes: F1 Helvetica, F2 Helvetica-Bold, F3 Courier-Bold
const fonte = (negrito, mono) => (mono ? 'F3' : negrito ? 'F2' : 'F1');
const X = (mm) => mm * PT, Y = (mm) => PH - mm * PT;

function pagina(svg) {
  const ops = [];
  const at = (el, k, def = null) => (el.hasAttribute(k) ? el.getAttribute(k) : def);
  const num = (el, k, def = 0) => Number(at(el, k, def));
  const pintar = (el, desenho) => {
    const fill = at(el, 'fill', '#000'), stroke = at(el, 'stroke');
    const temFill = fill && fill !== 'none', temStroke = stroke && stroke !== 'none';
    if (!temFill && !temStroke) return;
    ops.push('q');
    if (temFill) ops.push(`${cor(fill)} rg`);
    if (temStroke) {
      ops.push(`${cor(stroke)} RG`, `${n(num(el, 'stroke-width', 0.3) * PT)} w`);
      const dash = at(el, 'stroke-dasharray');
      if (dash) ops.push(`[${dash.split(/[ ,]+/).map(d => n(Number(d) * PT)).join(' ')}] 0 d`);
    }
    ops.push(desenho, temFill && temStroke ? 'B' : temFill ? 'f' : 'S', 'Q');
  };
  for (const el of svg.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'rect') {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      pintar(el, `${n(X(x))} ${n(Y(y + h))} ${n(w * PT)} ${n(h * PT)} re`);
    } else if (tag === 'circle') {
      const cx = X(num(el, 'cx')), cy = Y(num(el, 'cy')), r = num(el, 'r') * PT, k = 0.5523 * r;
      pintar(el, `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c h`);
    } else if (tag === 'line') {
      if (!el.hasAttribute('fill')) el.setAttribute('fill', 'none');
      pintar(el, `${n(X(num(el, 'x1')))} ${n(Y(num(el, 'y1')))} m ${n(X(num(el, 'x2')))} ${n(Y(num(el, 'y2')))} l`);
    } else if (tag === 'path') {
      // só M, L e Z (a folha não usa curva em caminho)
      const d = at(el, 'd', '').match(/[MLZ][^MLZ]*/gi) || [];
      const partes = d.map(seg => {
        const c = seg[0].toUpperCase(), v = seg.slice(1).trim().split(/[ ,]+/).filter(Boolean).map(Number);
        return c === 'Z' ? 'h' : `${n(X(v[0]))} ${n(Y(v[1]))} ${c === 'M' ? 'm' : 'l'}`;
      });
      pintar(el, partes.join(' '));
    } else if (tag === 'text') {
      const tam = num(el, 'font-size', 3) * PT, ancora = at(el, 'text-anchor', 'start');
      const mono = /mono|consolas|courier/i.test(at(el, 'font-family', ''));
      const pedacos = [];
      el.childNodes.forEach(nd => {
        if (nd.nodeType === 3) pedacos.push({ t: nd.textContent, neg: at(el, 'font-weight') === '700', fill: at(el, 'fill', '#000') });
        else if (nd.tagName && nd.tagName.toLowerCase() === 'tspan') pedacos.push({ t: nd.textContent, neg: (nd.getAttribute('font-weight') || at(el, 'font-weight')) === '700', fill: nd.getAttribute('fill') || at(el, 'fill', '#000') });
      });
      const total = pedacos.reduce((s, p) => s + largura(p.t, tam, p.neg, mono), 0);
      let x = X(num(el, 'x'));
      if (ancora === 'end') x -= total; else if (ancora === 'middle') x -= total / 2;
      const y = Y(num(el, 'y'));
      pedacos.forEach(p => {
        if (!p.t) return;
        ops.push('BT', `${cor(p.fill)} rg`, `/${fonte(p.neg, mono)} ${n(tam)} Tf`, `${n(x)} ${n(y)} Td`, `(${textoPdf(p.t)}) Tj`, 'ET');
        x += largura(p.t, tam, p.neg, mono);
      });
    } else if (tag === 'image') {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      ops.push({ imagem: { x, y, w, h } });
    }
  }
  return ops;
}

async function logoJpeg(url) {
  try {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = url; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0);
    const b64 = c.toDataURL('image/jpeg', 0.92).split(',')[1];
    return { bytes: Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)), w: c.width, h: c.height };
  } catch (e) { return null; }
}

// recebe o HTML de htmlFolhas() e devolve um Blob PDF
export async function pdfDasFolhas(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const svgs = [...doc.querySelectorAll('svg.pg')];
  const logoUrl = (doc.querySelector('image') || { getAttribute: () => '' }).getAttribute('href');
  const logo = logoUrl ? await logoJpeg(logoUrl) : null;
  const enc = new TextEncoder();
  const partes = []; let pos = 0; const offsets = [];
  const push = (x) => { const b = typeof x === 'string' ? latin1(x) : x; partes.push(b); pos += b.length; };
  const latin1 = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  const obj = (id, corpo) => { offsets[id] = pos; push(`${id} 0 obj\n`); corpo(); push('\nendobj\n'); };
  // 1 catálogo, 2 páginas, 3-5 fontes, 6 logo, 7.. páginas e conteúdos
  const nPag = svgs.length, primeiro = 7;
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${nPag} /Kids [${svgs.map((_, i) => `${primeiro + i * 2} 0 R`).join(' ')}] >>`));
  obj(3, () => push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  obj(4, () => push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  obj(5, () => push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>'));
  obj(6, () => {
    if (!logo) { push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xFF\nendstream'); return; }
    push(`<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.bytes.length} >>\nstream\n`);
    push(logo.bytes); push('\nendstream');
  });
  svgs.forEach((svg, i) => {
    const ops = pagina(svg).map(o => {
      if (typeof o === 'string') return o;
      const { x, y, w, h } = o.imagem;
      // preserveAspectRatio xMinYMid meet: encaixa o logo na caixa mantendo a proporção
      const prop = logo ? logo.w / logo.h : 1;
      let ww = w, hh = w / prop; if (hh > h) { hh = h; ww = h * prop; }
      const yy = y + (h - hh) / 2;
      return `q ${n(ww * PT)} 0 0 ${n(hh * PT)} ${n(X(x))} ${n(Y(yy + hh))} cm /Logo Do Q`;
    }).join('\n');
    const conteudo = latin1(ops);
    obj(primeiro + i * 2, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(PW)} ${n(PH)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> /XObject << /Logo 6 0 R >> >> /Contents ${primeiro + i * 2 + 1} 0 R >>`));
    obj(primeiro + i * 2 + 1, () => { push(`<< /Length ${conteudo.length} >>\nstream\n`); push(conteudo); push('\nendstream'); });
  });
  const total = primeiro + nPag * 2;
  const xref = pos;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  void enc;
  return new Blob(partes, { type: 'application/pdf' });
}
