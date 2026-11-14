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

// Tira as imagens do Word (.docx) ANTES de mandar pro servidor: cada imagem vira [[IMAGEM n]] no texto,
// exatamente onde estava, e o arquivo fica leve (Word cheio de imagem passava do limite de envio).
// Devolve { arquivo, imagens: [{ n, blob, nome }], ignoradas } — "ignoradas" são desenhos/equações em
// formato que o navegador não abre (EMF/WMF), que já ficavam de fora antes.
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
  const imagens = [], porArquivo = new Map(), partes = [];
  let ignoradas = 0, ultimo = 0;
  const RE = /<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>|<w:drawing\b[\s\S]*?<\/w:drawing>|<w:pict\b[\s\S]*?<\/w:pict>|<w:object\b[\s\S]*?<\/w:object>/g;
  for (const m of doc.matchAll(RE)) {
    const bloco = m[0];
    // AlternateContent: o Word grava a imagem 2 vezes (nova + compatível); usa só a 1ª
    const parte = bloco.startsWith('<mc:') ? ((/<mc:Choice\b[\s\S]*?<\/mc:Choice>/.exec(bloco) || [bloco])[0]) : bloco;
    const rids = idsDeImagem(parte).filter(r => alvo[r]);
    if (!rids.length) continue;   // caixa de texto, forma sem figura: fica como está
    partes.push(doc.slice(ultimo, m.index));
    ultimo = m.index + bloco.length;
    const marcas = [];
    for (const rid of rids) {
      const caminho = ('word/' + alvo[rid]).replace(/\/\.\//g, '/');
      const f = zip.file(caminho);
      const ext = (caminho.split('.').pop() || '').toLowerCase();
      if (!f || !MIME_EXT[ext]) { ignoradas++; continue; }
      let n = porArquivo.get(caminho);
      if (!n) {
        n = imagens.length + 1;
        imagens.push({ n, blob: new Blob([await f.async('uint8array')], { type: MIME_EXT[ext] }), nome: `imagem-${n}.${ext}` });
        porArquivo.set(caminho, n);
      }
      marcas.push(`[[IMAGEM ${n}]]`);
    }
    partes.push(marcas.length ? `<w:t xml:space="preserve">${marcas.join(' ')}</w:t>` : '');
  }
  if (!imagens.length && !ignoradas) return nada;
  zip.file('word/document.xml', partes.join('') + doc.slice(ultimo));
  porArquivo.forEach((_, caminho) => zip.remove(caminho));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { arquivo: new File([blob], arquivo.name, { type: arquivo.type }), imagens, ignoradas };
}

// Depois da leitura: cada questão fica com as SUAS imagens (renumeradas 1, 2... dentro dela). Imagem
// que caiu numa alternativa vai pro fim do enunciado (alternativa da prova é só texto).
export function distribuirImagens(questoes, enviadas) {
  return questoes.map(q => {
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
