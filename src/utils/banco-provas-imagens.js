// ==========================================================================
// Imagens das questões do Banco de Provas (13/11/2026) — mesmo esquema do Banco MED
// (src/rotas/banco-med-avaliacoes.js): a imagem vai pro Firebase Storage por link assinado (o
// navegador faz o PUT direto, sem passar pelo limite de envio da Vercel) e a questão guarda só
// imagens: [{ caminho, nome, mimeType, tamanho }]. No texto da questão, [[IMAGEM 1]], [[IMAGEM 2]]...
// marcam ONDE cada imagem entra (na visualização e no Word da prova).
// Só PNG, JPG e GIF: são os formatos que o Word aceita dentro do .docx gerado.
// ==========================================================================
const { admin } = require('../firebase');

const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'orbita-fatecivp.firebasestorage.app';
const bucket = () => admin.storage().bucket(BUCKET);
const TIPOS = ['image/png', 'image/jpeg', 'image/gif'];
const MAX_BYTES = 10 * 1024 * 1024;
const PASTA = 'banco-provas/imagens/';
const MAX_POR_QUESTAO = 10;
const MARCA = /\[\[IMAGEM (\d{1,2})\]\]/g;

const nomeArquivo = (v) => String(v || 'imagem').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'imagem';

function falha(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// link pra subir UMA imagem (válido 15 min)
async function linkEnvio(body) {
    const mimeType = body && body.mimeType;
    const tamanho = Number(body && body.tamanho);
    if (!TIPOS.includes(mimeType)) throw falha('Use imagem PNG, JPG ou GIF.');
    if (!(tamanho > 0) || tamanho > MAX_BYTES) throw falha('Imagem muito grande (máx. 10 MB).');
    const caminho = `${PASTA}${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${nomeArquivo(body.nome)}`;
    const [url] = await bucket().file(caminho).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 15 * 60000, contentType: mimeType });
    return { url, caminho };
}

// confere no Storage o que o navegador diz ter enviado (só da pasta do Banco de Provas)
async function confirmar(lista) {
    const out = [];
    for (const it of (Array.isArray(lista) ? lista : []).slice(0, MAX_POR_QUESTAO)) {
        const caminho = String((it && it.caminho) || '');
        if (!caminho.startsWith(PASTA) || caminho.includes('..')) continue;
        const arq = bucket().file(caminho);
        const [existe] = await arq.exists();
        if (!existe) continue;
        const [meta] = await arq.getMetadata();
        const tamanho = Number(meta.size);
        if (!TIPOS.includes(meta.contentType) || tamanho > MAX_BYTES) { await arq.delete({ ignoreNotFound: true }); continue; }
        out.push({ caminho, nome: String(it.nome || caminho.split('/').pop()).slice(0, 120), mimeType: meta.contentType, tamanho });
    }
    return out;
}

async function comLinks(imagens, minutos = 60) {
    return Promise.all((imagens || []).map(async im => {
        try {
            const [url] = await bucket().file(im.caminho).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + minutos * 60000 });
            return { ...im, url };
        } catch (e) { return { ...im, url: null }; }
    }));
}

async function baixar(imagens) {
    return Promise.all((imagens || []).map(async im => {
        try { const [buf] = await bucket().file(im.caminho).download(); return { ...im, buffer: buf }; }
        catch (e) { return { ...im, buffer: null }; }
    }));
}

async function apagar(imagens) {
    await Promise.all((imagens || []).map(im => bucket().file(im.caminho).delete({ ignoreNotFound: true }).catch(() => null)));
}

// largura x altura em pixels (PNG, GIF e JPEG), sem biblioteca
function dimensoes(buf) {
    try {
        if (!buf || buf.length < 24) return null;
        if (buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
        if (buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            let i = 2;
            while (i < buf.length - 9) {
                if (buf[i] !== 0xff) { i++; continue; }
                const marca = buf[i + 1];
                if (marca >= 0xc0 && marca <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marca)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
                i += 2 + buf.readUInt16BE(i + 2);
            }
        }
    } catch (e) { /* formato inesperado */ }
    return null;
}

// texto -> pedaços na ordem: { texto } ou { imagem: índice (0-based) }
function pedacos(texto) {
    const out = [];
    let ultimo = 0;
    const s = String(texto ?? '');
    for (const m of s.matchAll(MARCA)) {
        if (m.index > ultimo) out.push({ texto: s.slice(ultimo, m.index) });
        out.push({ imagem: Number(m[1]) - 1 });
        ultimo = m.index + m[0].length;
    }
    if (ultimo < s.length) out.push({ texto: s.slice(ultimo) });
    return out;
}

module.exports = { linkEnvio, confirmar, comLinks, baixar, apagar, dimensoes, pedacos, MARCA, TIPOS };
