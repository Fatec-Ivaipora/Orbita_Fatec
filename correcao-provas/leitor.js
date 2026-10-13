// ==========================================================================
// Leitor da folha de respostas (Correção de Provas). Sem biblioteca externa: acha os 4 quadrados pretos
// dos cantos da área de respostas, calcula a perspectiva da foto (homografia) e mede o quanto cada
// bolinha está preenchida. O código da folha (avaliação + aluno) é uma faixa de 40 quadradinhos
// cheios/vazios dentro da mesma área, com conferência (se a leitura errar um bit, não confere).
//
// Todas as medidas abaixo são em milímetros, a partir do centro do quadrado do canto superior esquerdo.
// A folha (app.js) é desenhada com estas mesmas medidas — mudar aqui é mudar a folha.
// ==========================================================================
export const L = {
  W: 180, H: 172, MARCA: 8,                       // centros dos 4 quadrados: (0,0) (W,0) (W,H) (0,H)
  ID_Y: 9, ID_X0: 12, ID_PASSO: 4, ID_LADO: 3.2, ID_BITS: 40,
  LINHAS: 20, Y0: 23, PASSO_Y: 7.4,
  COL_X: [6, 66, 126], NUM_W: 13, PASSO_X: 8, RAIO: 2.8
};
export const LETRAS = 'ABCDE';
export const MAX_QUESTOES = L.LINHAS * L.COL_X.length;

export function posBolinha(q, k) {
  const col = Math.floor(q / L.LINHAS), lin = q % L.LINHAS;
  return { x: L.COL_X[col] + L.NUM_W + k * L.PASSO_X, y: L.Y0 + lin * L.PASSO_Y };
}
export const posBit = (b) => ({ x: L.ID_X0 + b * L.ID_PASSO, y: L.ID_Y });

// ---------- código da folha: 16 bits avaliação + 12 bits aluno + 12 bits conferência ----------
const conferencia = (cod, i) => ((cod * 7919 + i * 104729 + 1445) ^ (cod >> 3) ^ (i << 1)) & 0xfff;
export function codificar(cod, i) {
  const bits = [];
  const put = (v, n) => { for (let k = n - 1; k >= 0; k--) bits.push((v >> k) & 1); };
  put(cod & 0xffff, 16); put(i & 0xfff, 12); put(conferencia(cod & 0xffff, i & 0xfff), 12);
  return bits;
}
export function decodificar(bits) {
  const get = (a, n) => bits.slice(a, a + n).reduce((v, b) => (v << 1) | b, 0);
  const cod = get(0, 16), i = get(16, 12), c = get(28, 12);
  return c === conferencia(cod, i) ? { cod, i } : null;
}

// ---------- imagem ----------
function cinza(img) {
  const { data, width, height } = img;
  const g = new Float32Array(width * height);
  for (let p = 0, q = 0; p < g.length; p++, q += 4) g[p] = 0.299 * data[q] + 0.587 * data[q + 1] + 0.114 * data[q + 2];
  return { g, w: width, h: height };
}
function reduzir(G, maxLado) {
  const f = Math.min(1, maxLado / Math.max(G.w, G.h));
  if (f === 1) return { ...G, f: 1 };
  const w = Math.round(G.w * f), h = Math.round(G.h * f), g = new Float32Array(w * h);
  const inv = 1 / f;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // média de um bloco (evita perder o quadrado em fotos grandes)
    const x0 = Math.floor(x * inv), y0 = Math.floor(y * inv), x1 = Math.min(G.w, Math.floor((x + 1) * inv)), y1 = Math.min(G.h, Math.floor((y + 1) * inv));
    let s = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += G.g[yy * G.w + xx]; n++; }
    g[y * w + x] = n ? s / n : 255;
  }
  return { g, w, h, f };
}
// binarização adaptativa (Bradley): escuro se bem abaixo da média da vizinhança
function binarizar(G) {
  const { g, w, h } = G;
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
  const r = Math.max(8, Math.round(Math.max(w, h) / 16)), b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
      const soma = I[yb * (w + 1) + xb] - I[ya * (w + 1) + xb] - I[yb * (w + 1) + xa] + I[ya * (w + 1) + xa];
      const media = soma / ((xb - xa) * (yb - ya));
      b[y * w + x] = g[y * w + x] < media * 0.72 && g[y * w + x] < 175 ? 1 : 0;
    }
  }
  return b;
}
// manchas escuras quase quadradas e bem cheias = candidatas a quadrado do canto
function candidatos(b, w, h) {
  const rot = new Int32Array(w * h), pilha = new Int32Array(w * h), lista = [];
  let id = 0;
  for (let p = 0; p < b.length; p++) {
    if (!b[p] || rot[p]) continue;
    id++; let topo = 0, n = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    pilha[topo++] = p; rot[p] = id;
    while (topo) {
      const q = pilha[--topo], x = q % w, y = (q - x) / w;
      n++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && b[q - 1] && !rot[q - 1]) { rot[q - 1] = id; pilha[topo++] = q - 1; }
      if (x < w - 1 && b[q + 1] && !rot[q + 1]) { rot[q + 1] = id; pilha[topo++] = q + 1; }
      if (y > 0 && b[q - w] && !rot[q - w]) { rot[q - w] = id; pilha[topo++] = q - w; }
      if (y < h - 1 && b[q + w] && !rot[q + w]) { rot[q + w] = id; pilha[topo++] = q + w; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < 7 || bh < 7) continue;
    const asp = bw / bh, cheio = n / (bw * bh);
    if (asp < 0.5 || asp > 2 || cheio < 0.5) continue;
    if (bw > w / 5 || bh > h / 5) continue;
    lista.push({ x: sx / n, y: sy / n, area: n });
  }
  lista.sort((a, b2) => b2.area - a.area);
  return lista.slice(0, 18);
}
// homografia: leva (X,Y) em mm da folha para (x,y) em pixels da foto
function homografia(src, dst) {
  const A = [], B = [];
  for (let k = 0; k < 4; k++) {
    const [X, Y] = src[k], [x, y] = dst[k];
    A.push([X, Y, 1, 0, 0, 0, -X * x, -Y * x]); B.push(x);
    A.push([0, 0, 0, X, Y, 1, -X * y, -Y * y]); B.push(y);
  }
  for (let c = 0; c < 8; c++) {   // eliminação de Gauss
    let m = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]]; [B[c], B[m]] = [B[m], B[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; B[r] -= f * B[c]; }
  }
  const h = B.map((v, i) => v / A[i][i]);
  return (X, Y) => { const d = h[6] * X + h[7] * Y + 1; return [(h[0] * X + h[1] * Y + h[2]) / d, (h[3] * X + h[4] * Y + h[5]) / d]; };
}
function quadrilateros(c) {
  const out = [];
  const n = c.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let d = b + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
    const p = [c[a], c[b], c[d], c[e]];
    const areas = p.map(x => x.area); if (Math.max(...areas) / Math.min(...areas) > 3) continue;
    const s = p.slice().sort((u, v) => u.y - v.y);
    const [tl, tr] = s.slice(0, 2).sort((u, v) => u.x - v.x), [bl, br] = s.slice(2).sort((u, v) => u.x - v.x);
    const dist = (u, v) => Math.hypot(u.x - v.x, u.y - v.y);
    const topo = dist(tl, tr), base = dist(bl, br), esq = dist(tl, bl), dir = dist(tr, br);
    if (topo / base > 1.8 || base / topo > 1.8 || esq / dir > 1.8 || dir / esq > 1.8) continue;
    const prop = (topo + base) / (esq + dir) / (L.W / L.H);
    if ((prop < 0.6 || prop > 1.6) && (1 / prop < 0.6 || 1 / prop > 1.6)) continue;
    // a área dos quadrados tem que combinar com o tamanho da folha (8 mm num quadro de 180 mm)
    const ladoMarca = Math.sqrt(areas.reduce((x, y) => x + y, 0) / 4), escala = (topo + base + esq + dir) / 2 / (L.W + L.H);
    const razao = ladoMarca / (escala * L.MARCA); if (razao < 0.55 || razao > 1.6) continue;
    const area2 = Math.abs((tr.x - tl.x) * (bl.y - tl.y) - (bl.x - tl.x) * (tr.y - tl.y)) + Math.abs((br.x - tr.x) * (bl.y - tr.y) - (bl.x - tr.x) * (br.y - tr.y));
    out.push({ pts: [tl, tr, br, bl], area: area2 });
  }
  return out.sort((u, v) => v.area - u.area).slice(0, 12);
}
function amostra(G, H, X, Y, raio) {
  // média do cinza num círculo de raio (mm), por amostragem 5x5
  let s = 0, n = 0;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    if (i * i + j * j > 5) continue;
    const [x, y] = H(X + i * raio / 2, Y + j * raio / 2);
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= G.w - 1 || yi >= G.h - 1) return null;
    const fx = x - xi, fy = y - yi, p = yi * G.w + xi;
    s += G.g[p] * (1 - fx) * (1 - fy) + G.g[p + 1] * fx * (1 - fy) + G.g[p + G.w] * (1 - fx) * fy + G.g[p + G.w + 1] * fx * fy; n++;
  }
  return s / n;
}
const mediana = (v) => { const a = v.filter(x => x !== null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

function lerCodigo(G, H) {
  const branco = mediana(Array.from({ length: L.ID_BITS + 1 }, (_, b) => amostra(G, H, L.ID_X0 + (b - 0.5) * L.ID_PASSO, L.ID_Y - 3.6, 0.8)));
  if (!branco) return null;
  const v = [];
  for (let b = 0; b < L.ID_BITS; b++) { const p = posBit(b), a = amostra(G, H, p.x, p.y, 1.1); if (a === null) return null; v.push(1 - a / branco); }
  return decodificar(v.map(x => (x > 0.42 ? 1 : 0)));
}

// Lê a folha. img: ImageData (ou {data,width,height}). nQuestoes/nAlt vêm da avaliação (opções.aoAcharCodigo).
// Retorna { cod, i, respostas:[…'A'|''|'*'], forca:[[…]], quad } ou null se não achou a folha.
export function lerFolha(img, { aoAcharCodigo, depurar } = {}) {
  const Gf = cinza(img);
  const G = reduzir(Gf, 1000);
  const b = binarizar(G);
  const cand = candidatos(b, G.w, G.h);
  const quads = cand.length < 4 ? [] : quadrilateros(cand);
  if (depurar) depurar({ w: G.w, h: G.h, candidatos: cand.map(c => [Math.round(c.x), Math.round(c.y), c.area]), quads: quads.length });
  if (cand.length < 4) return null;
  const mm = [[0, 0], [L.W, 0], [L.W, L.H], [0, L.H]];
  // a folha pode estar deitada ou de cabeça pra baixo: tenta os 4 giros (o código só confere no certo)
  const giros = quads.flatMap(q => [0, 1, 2, 3].map(k => ({ pts: [...q.pts.slice(k), ...q.pts.slice(0, k)] })));
  for (const q of giros) {
    const Hf = homografia(mm, q.pts.map(p => [p.x / G.f, p.y / G.f]));
    if (!Hf) continue;
    const id = lerCodigo(Gf, Hf);
    if (!id) continue;
    const info = aoAcharCodigo ? aoAcharCodigo(id) : { nQuestoes: MAX_QUESTOES, nAlt: 5 };
    if (!info) return { cod: id.cod, i: id.i, outra: true, quad: q.pts.map(p => [p.x / G.f, p.y / G.f]) };
    const { nQuestoes, nAlt } = info;
    const respostas = [], forca = [];
    for (let k = 0; k < nQuestoes; k++) {
      const brancos = [], cheios = [];
      for (let a = 0; a < nAlt; a++) {
        const p = posBolinha(k, a);
        cheios.push(amostra(Gf, Hf, p.x, p.y, L.RAIO * 0.55));
        brancos.push(amostra(Gf, Hf, p.x + L.PASSO_X / 2, p.y, 0.7));
      }
      const br = mediana(brancos) || 255;
      const v = cheios.map(c => (c === null ? 0 : Math.max(0, 1 - c / br)));
      forca.push(v.map(x => Math.round(x * 100) / 100));
      const ord = v.map((x, a) => [x, a]).sort((x, y) => y[0] - x[0]);
      const marc = ord.filter(([x]) => x > 0.38);
      if (!marc.length) respostas.push('');
      else if (marc.length === 1 || (ord[0][0] - ord[1][0] > 0.28 && ord[1][0] < 0.5)) respostas.push(LETRAS[ord[0][1]]);
      else respostas.push('*');   // duas ou mais marcadas
    }
    return { cod: id.cod, i: id.i, respostas, forca, quad: q.pts.map(p => [p.x / G.f, p.y / G.f]) };
  }
  return null;
}
