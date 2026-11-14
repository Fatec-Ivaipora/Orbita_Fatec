// Imagens das questões do Banco de Provas (13/11/2026) — mesmo caminho do Banco MED: a imagem vai
// direto do navegador pro Firebase Storage (link assinado) e a questão guarda só a referência. No texto,
// [[IMAGEM 1]], [[IMAGEM 2]]... marcam onde cada imagem entra na prova (ver src/utils/banco-provas-imagens.js).

const TIPOS = ['image/png', 'image/jpeg', 'image/gif'];
const MAX_BYTES = 10 * 1024 * 1024;
const MIME_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
export const MARCA = /\[\[IMAGEM (\d{1,2})\]\]/g;

// WEBP/BMP (o navegador abre, o Word da prova não aceita) viram PNG
async function emFormatoAceito(blob) {
  if (TIPOS.includes(blob.type)) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return await new Promise(r => c.toBlob(r, 'image/png'));
  } catch (e) { return null; }
}

// sobe UMA imagem e devolve { caminho, nome, url } (url local, só pra mostrar na tela)
export async function enviarImagem(apiFetch, blob, nome) {
  const img = await emFormatoAceito(blob);
  if (!img) throw new Error(`"${nome}" não é uma imagem que dá para usar. Use PNG, JPG ou GIF.`);
  if (img.size > MAX_BYTES) throw new Error(`A imagem "${nome}" passa de 10 MB.`);
  const envio = await apiFetch('/banco-provas/imagens/envio', { method: 'POST', body: JSON.stringify({ nome, mimeType: img.type, tamanho: img.size }) });
  const r = await fetch(envio.url, { method: 'PUT', headers: { 'Content-Type': img.type }, body: img });
  if (!r.ok) throw new Error(`Não consegui enviar a imagem "${nome}". Tente de novo.`);
  return { caminho: envio.caminho, nome: String(nome).replace(/\.[^.]+$/, ''), url: URL.createObjectURL(img) };
}

const idsDeImagem = (xml) => [...new Set([...xml.matchAll(/\br:(?:embed|id)="([^"]+)"/g)].map(m => m[1]))];
const CM = 360000;   // EMU por centímetro

// posição e tamanho de um desenho do Word (em EMU)
function infoDesenho(xml) {
  const h = /<wp:positionH\b[^>]*relativeFrom="(\w+)"[^>]*>\s*<wp:posOffset>(-?\d+)</.exec(xml);
  const v = /<wp:positionV\b[^>]*relativeFrom="(\w+)"[^>]*>\s*<wp:posOffset>(-?\d+)</.exec(xml);
  const e = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml);
  return { flutuante: /<wp:anchor\b/.test(xml), h: h && { rel: h[1], off: +h[2] }, v: v && { rel: v[1], off: +v[2] }, cx: e ? +e[1] : 0, cy: e ? +e[2] : 0 };
}

// peças de um grupo de figuras ("Agrupar" no Word): posição de cada uma dentro do grupo, em EMU
function pecasDoGrupo(xml, info) {
  const g = /<wpg:grpSpPr>[\s\S]*?<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/.exec(xml);
  if (!g) return null;
  // sem chOff o Word está dizendo que a origem é 0,0
  const chOff = /<a:chOff x="(-?\d+)" y="(-?\d+)"/.exec(g[1]) || [null, '0', '0'], chExt = /<a:chExt cx="(\d+)" cy="(\d+)"/.exec(g[1]);
  if (!chExt || !+chExt[1] || !+chExt[2]) return null;
  const sx = info.cx / +chExt[1], sy = info.cy / +chExt[2];
  const pecas = [...xml.matchAll(/<pic:pic\b[\s\S]*?<\/pic:pic>/g)].map(([p]) => {
    const rid = (/r:embed="([^"]+)"/.exec(p) || [])[1];
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(p), e = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(p);
    return rid && off && e ? { rid, x: (+off[1] - +chOff[1]) * sx, y: (+off[2] - +chOff[2]) * sy, cx: +e[1] * sx, cy: +e[2] * sy } : null;
  }).filter(Boolean);
  return pecas.length >= 2 ? pecas : null;
}

// junta as camadas ({ blob, x, y, cx, cy } em EMU) numa imagem PNG só, cada uma no seu lugar
async function comporImagem(camadas) {
  const bmps = await Promise.all(camadas.map(c => createImageBitmap(c.blob)));
  const base = camadas.reduce((a, b) => (a.cx * a.cy >= b.cx * b.cy ? a : b));
  const bb = bmps[camadas.indexOf(base)];
  const x0 = Math.min(...camadas.map(c => c.x)), y0 = Math.min(...camadas.map(c => c.y));
  const x1 = Math.max(...camadas.map(c => c.x + c.cx)), y1 = Math.max(...camadas.map(c => c.y + c.cy));
  const px = Math.min(bb.width / base.cx, 2400 / (x1 - x0), 2400 / (y1 - y0));   // pixels por EMU
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round((x1 - x0) * px));
  cv.height = Math.max(1, Math.round((y1 - y0) * px));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  camadas.forEach((c, i) => ctx.drawImage(bmps[i], (c.x - x0) * px, (c.y - y0) * px, c.cx * px, c.cy * px));
  return new Promise(r => cv.toBlob(r, 'image/png'));
}

// Tira as imagens do Word (.docx) ANTES de mandar pro servidor: cada imagem vira [[IMAGEM n]] no texto,
// exatamente onde estava, e o arquivo fica leve (Word cheio de imagem passava do limite de envio).
// Figura montada no Word (grupo: radiografia + números por cima, 13/11/2026) vira UMA imagem, com as peças no
// lugar; figurinha solta flutuando em cima dela, no mesmo parágrafo, entra junto.
// Devolve { arquivo, imagens: [{ n, blob, nome, flutuante }], ignoradas } — "ignoradas" são desenhos/equações
// em formato que o navegador não abre (EMF/WMF), que já ficavam de fora antes.
export async function separarImagensDoDocx(arquivo) {
  const nada = { arquivo, imagens: [], ignoradas: 0 };
  if (!window.JSZip || !/\.docx$/i.test(arquivo.name)) return nada;
  let zip;
  try { zip = await window.JSZip.loadAsync(arquivo); } catch (e) { return nada; }
  const docF = zip.file('word/document.xml'), relF = zip.file('word/_rels/document.xml.rels');
  if (!docF || !relF) return nada;
  const doc = await docF.async('string');
  const rels = await relF.async('string');
  const alvo = {};
  for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(tag), t = /\bTarget="([^"]+)"/.exec(tag), tipo = /\bType="([^"]+)"/.exec(tag);
    if (id && t && tipo && /\/image$/.test(tipo[1]) && !/TargetMode="External"/.test(tag)) alvo[id[1]] = t[1];
  }
  const caminhoDe = (rid) => ('word/' + alvo[rid]).replace(/\/\.\//g, '/');
  const extDe = (c) => (c.split('.').pop() || '').toLowerCase();
  const blobDe = async (rid) => {
    const c = caminhoDe(rid), f = zip.file(c), ext = extDe(c);
    return f && MIME_EXT[ext] ? new Blob([await f.async('uint8array')], { type: MIME_EXT[ext] }) : null;
  };

  // 1) todos os desenhos com figura, com o parágrafo em que estão
  const RE = /<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>|<w:drawing\b[\s\S]*?<\/w:drawing>|<w:pict\b[\s\S]*?<\/w:pict>|<w:object\b[\s\S]*?<\/w:object>/g;
  const blocos = [];
  for (const m of doc.matchAll(RE)) {
    const bloco = m[0];
    // AlternateContent: o Word grava a imagem 2 vezes (nova + compatível); usa só a 1ª
    const parte = bloco.startsWith('<mc:') ? ((/<mc:Choice\b[\s\S]*?<\/mc:Choice>/.exec(bloco) || [bloco])[0]) : bloco;
    const rids = idsDeImagem(parte).filter(r => alvo[r]);
    if (!rids.length) continue;   // caixa de texto, forma sem figura: fica como está
    const antes = doc.slice(0, m.index);
    const paragrafo = Math.max(antes.lastIndexOf('<w:p>'), antes.lastIndexOf('<w:p '));
    const info = infoDesenho(parte);
    blocos.push({ inicio: m.index, fim: m.index + bloco.length, rids, info, paragrafo, pecas: pecasDoGrupo(parte, info), usado: false });
  }

  const imagens = [], porArquivo = new Map(), trocas = new Map();
  let ignoradas = 0;
  const novaImagem = (blob, ext, flutuante) => {
    const n = imagens.length + 1;
    imagens.push({ n, blob, nome: 'imagem-' + n + '.' + ext, flutuante });
    return n;
  };

  // 2) grupos de figuras: uma imagem só (+ figurinhas soltas por cima, no mesmo parágrafo)
  if (typeof createImageBitmap === 'function') {
    for (const b of blocos.filter(x => x.pecas)) {
      try {
        const camadas = [];
        for (const p of b.pecas) { const blob = await blobDe(p.rid); if (blob) camadas.push({ blob, x: p.x, y: p.y, cx: p.cx, cy: p.cy }); }
        if (camadas.length < 2) continue;
        const juntos = [];
        if (b.info.flutuante && b.info.h && b.info.v) {
          for (const o of blocos) {
            if (o === b || o.usado || o.pecas || o.paragrafo !== b.paragrafo || !o.info.flutuante || !o.info.h || !o.info.v) continue;
            if (o.info.h.rel !== b.info.h.rel || o.info.v.rel !== b.info.v.rel || o.info.cx > 2 * CM || o.info.cy > 2 * CM) continue;
            const x = o.info.h.off - b.info.h.off, y = o.info.v.off - b.info.v.off;
            if (x < -CM || y < -CM || x > b.info.cx + CM || y > b.info.cy + CM) continue;
            const blob = await blobDe(o.rids[0]);
            if (!blob) continue;
            camadas.push({ blob, x, y, cx: o.info.cx, cy: o.info.cy });
            juntos.push(o);
          }
        }
        const png = await comporImagem(camadas);
        if (!png) continue;
        const n = novaImagem(png, 'png', b.info.flutuante);
        b.usado = true;
        trocas.set(b, '[[IMAGEM ' + n + ']]');
        juntos.forEach(o => { o.usado = true; trocas.set(o, ''); o.rids.forEach(r => porArquivo.set(caminhoDe(r), n)); });
        b.pecas.forEach(p => porArquivo.set(caminhoDe(p.rid), n));
      } catch (e) { /* sem montar: as peças entram uma a uma, como antes */ }
    }
  }

  // 3) o resto: cada figura vira uma imagem
  for (const b of blocos) {
    if (b.usado) continue;
    // figurinha flutuante menor que 1 cm que não entrou em grupo nenhum é sobra de edição (quadradinho em
    // branco na margem do simulado de Biomedicina): sai do texto sem virar imagem
    if (b.info.flutuante && b.info.cx && b.info.cx < CM && b.info.cy < CM) { trocas.set(b, ''); continue; }
    const marcas = [];
    for (const rid of b.rids) {
      const caminho = caminhoDe(rid), ext = extDe(caminho), f = zip.file(caminho);
      if (!f || !MIME_EXT[ext]) { ignoradas++; continue; }
      let n = porArquivo.get(caminho);
      if (!n) {
        n = novaImagem(new Blob([await f.async('uint8array')], { type: MIME_EXT[ext] }), ext, b.info.flutuante);
        porArquivo.set(caminho, n);
      }
      marcas.push('[[IMAGEM ' + n + ']]');
    }
    trocas.set(b, marcas.join(' '));
  }
  if (!imagens.length && !ignoradas) return nada;

  let novoDoc = '', ultimo = 0;
  for (const b of blocos) {
    novoDoc += doc.slice(ultimo, b.inicio);
    const t = trocas.get(b) || '';
    if (t) novoDoc += '<w:t xml:space="preserve">' + t + '</w:t>';
    ultimo = b.fim;
  }
  zip.file('word/document.xml', novoDoc + doc.slice(ultimo));
  porArquivo.forEach((_, caminho) => zip.remove(caminho));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { arquivo: new File([blob], arquivo.name, { type: arquivo.type }), imagens, ignoradas };
}

// Figura FLUTUANTE fica presa (ancorada) a um parágrafo que às vezes já é da questão seguinte, embora apareça
// na página junto da anterior (13/11/2026, 8º período da Biomedicina: a radiografia da 24 estava ancorada na
// 25). Se a questão onde ela caiu não pede imagem e a anterior pede ("Observe a imagem a seguir") e não tem
// nenhuma, a figura vai para a anterior.
const PEDE_IMAGEM = /\b(?:observe|analise|veja|considere|a partir d[ao]|com base n[ao])\b[^.?!]{0,40}\b(?:imagem|figura|gr[áa]fico|esquema|radiografia|ilustra[çc][ãa]o)\b|\b(?:imagem|figura|gr[áa]fico|esquema|radiografia|ilustra[çc][ãa]o)\s+(?:a seguir|abaixo|acima|ao lado)\b/i;
export function moverFlutuantes(questoes, enviadas) {
  const qs = questoes.map(q => ({ ...q, alternativas: q.alternativas ? [...q.alternativas] : q.alternativas }));
  const marcasDe = (q) => [String(q.enunciado || ''), ...(q.alternativas || []).map(String)].join('\n').match(MARCA) || [];
  for (let i = 1; i < qs.length; i++) {
    const q = qs[i], ant = qs[i - 1];
    const marcas = marcasDe(q);
    if (!marcas.length || marcasDe(ant).length || ant.erro || q.erro) continue;
    if (!marcas.every(m => (enviadas.get(Number(/\d+/.exec(m)[0])) || {}).flutuante)) continue;
    if (PEDE_IMAGEM.test(q.enunciado || '') || !PEDE_IMAGEM.test(ant.enunciado || '')) continue;
    q.enunciado = String(q.enunciado || '').replace(MARCA, '').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
    if (q.alternativas) q.alternativas = q.alternativas.map(a => String(a).replace(MARCA, '').trim());
    ant.enunciado = String(ant.enunciado || '') + '\n' + marcas.join('\n');
  }
  return qs;
}

// Depois da leitura: cada questão fica com as SUAS imagens (renumeradas 1, 2... dentro dela). Imagem
// que caiu numa alternativa vai pro fim do enunciado (alternativa da prova é só texto).
export function distribuirImagens(questoes, enviadas) {
  return moverFlutuantes(questoes, enviadas).map(q => {
    const usadas = [];
    const trocar = (txt) => String(txt || '').replace(MARCA, (_, n) => {
      const meta = enviadas.get(Number(n));
      if (!meta) return '';
      let i = usadas.indexOf(meta);
      if (i < 0) { usadas.push(meta); i = usadas.length - 1; }
      return `[[IMAGEM ${i + 1}]]`;
    });
    let enunciado = trocar(q.enunciado);
    const alternativas = (q.alternativas || []).map(a => {
      const marcas = String(a || '').match(MARCA) || [];
      if (marcas.length) enunciado += '\n' + marcas.map(trocar).join('\n');
      return String(a || '').replace(MARCA, '').trim();
    });
    return { ...q, enunciado, alternativas: q.alternativas ? alternativas : q.alternativas, imagens: usadas.map(({ caminho, nome }) => ({ caminho, nome })) };
  });
}

// Tirou a imagem k (0-based): some a marcação dela e as seguintes descem um número
export function tirarMarcacao(texto, k) {
  return String(texto || '').replace(/[ \t]*\[\[IMAGEM (\d{1,2})\]\][ \t]*\n?/g, (todo, n) => {
    const i = Number(n) - 1;
    if (i === k) return '';
    return i > k ? todo.replace(`[[IMAGEM ${n}]]`, `[[IMAGEM ${i}]]`) : todo;
  });
}
