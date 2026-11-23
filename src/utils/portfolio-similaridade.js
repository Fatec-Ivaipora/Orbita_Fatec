// Portfólio Reflexivo — similaridade entre as produções da MESMA atividade (23/11/2026)
// Determinístico (sem IA): compara sequências de 8 palavras iguais entre cada par de portfólios.
// Rigor EQUILIBRADO, como pede o documento da coordenação:
//   - ignora a seção de referências (citações com referência formal);
//   - ignora trechos que aparecem em muitos portfólios da turma (ex.: objetivos copiados do plano de ensino,
//     nomes de programas do SUS, rotina protocolar da UBS, modelo de capa) — isso não é cópia entre colegas;
//   - só aponta trechos contínuos longos (frases/parágrafos), não termos soltos.
// A gravidade é INDICATIVA; a decisão é sempre do professor supervisor.

const K = 8;                 // tamanho da sequência comparada (palavras)
const MIN_TRECHO = 20;       // trecho contínuo mínimo para aparecer (palavras)

function cortarReferencias(texto) {
    const re = /\n\s*(refer[eê]ncias(\s+bibliogr[aá]ficas)?|bibliografia)\s*:?\s*\n/gi;
    let m, ultimo = -1;
    while ((m = re.exec(texto))) ultimo = m.index;
    // só corta se a seção estiver na metade final (evita cortar um sumário no início)
    return ultimo > texto.length * 0.5 ? texto.slice(0, ultimo) : texto;
}

function palavras(texto) {
    const limpo = cortarReferencias(String(texto || '').replace(/\[\[p\.\d+\]\]/g, ' '));
    const orig = limpo.split(/\s+/).filter(Boolean);
    const out = [];
    orig.forEach(w => {
        const n = w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (n) out.push({ n, o: w });
    });
    return out;
}

function shingles(ws) {
    const s = new Map(); // chave → primeira posição
    for (let i = 0; i + K <= ws.length; i++) {
        const key = ws.slice(i, i + K).map(x => x.n).join(' ');
        if (!s.has(key)) s.set(key, i);
    }
    return s;
}

// trechos contínuos de A cobertos por sequências compartilhadas com B
function trechos(wsA, shA, comuns) {
    const coberto = new Uint8Array(wsA.length);
    for (let i = 0; i + K <= wsA.length; i++) {
        const key = wsA.slice(i, i + K).map(x => x.n).join(' ');
        if (comuns.has(key)) for (let j = i; j < i + K; j++) coberto[j] = 1;
    }
    const out = [];
    let ini = -1;
    for (let i = 0; i <= wsA.length; i++) {
        if (i < wsA.length && coberto[i]) { if (ini < 0) ini = i; }
        else if (ini >= 0) { const len = i - ini; if (len >= MIN_TRECHO) out.push({ ini, len }); ini = -1; }
    }
    const total = coberto.reduce((a, b) => a + b, 0);
    return { out, total };
}

function gravidade(prop, maior) {
    if (prop >= 0.3) return 'ALTA';
    if (prop >= 0.1 || maior >= 60) return 'MEDIA';
    if (maior >= MIN_TRECHO) return 'BAIXA';
    return null;
}

/**
 * docs: [{ id, nome, texto }]
 * → { pares: [{ a, b, nomeA, nomeB, palavrasComuns, propA, propB, maiorTrecho, gravidade, trechos: [{ texto, palavras }] }],
 *     ignoradosComuns, analisados }
 */
function analisar(docs) {
    const base = docs.map(d => {
        const ws = palavras(d.texto);
        return { id: d.id, nome: d.nome, ws, sh: shingles(ws) };
    }).filter(d => d.ws.length >= 50);

    // frequência de cada sequência na turma — o que aparece em muitos portfólios é material comum
    const freq = new Map();
    base.forEach(d => d.sh.forEach((_, key) => freq.set(key, (freq.get(key) || 0) + 1)));
    const limiteComum = Math.max(3, Math.ceil(base.length * 0.25));
    let ignoradosComuns = 0;
    freq.forEach(v => { if (v >= limiteComum) ignoradosComuns++; });

    // índice invertido: sequência (não comum) → docs
    const idx = new Map();
    base.forEach((d, i) => d.sh.forEach((_, key) => {
        if (freq.get(key) >= limiteComum || freq.get(key) < 2) return;
        if (!idx.has(key)) idx.set(key, []);
        idx.get(key).push(i);
    }));
    const parComuns = new Map(); // "i|j" → Set(keys)
    idx.forEach((lista, key) => {
        for (let x = 0; x < lista.length; x++) for (let y = x + 1; y < lista.length; y++) {
            const p = `${lista[x]}|${lista[y]}`;
            if (!parComuns.has(p)) parComuns.set(p, new Set());
            parComuns.get(p).add(key);
        }
    });

    const pares = [];
    parComuns.forEach((keys, p) => {
        const [i, j] = p.split('|').map(Number);
        const A = base[i], B = base[j];
        const ta = trechos(A.ws, A.sh, keys);
        const tb = trechos(B.ws, B.sh, keys);
        const maior = Math.max(0, ...ta.out.map(t => t.len));
        const propA = ta.total / A.ws.length, propB = tb.total / B.ws.length;
        const g = gravidade(Math.max(propA, propB), maior);
        if (!g) return;
        pares.push({
            a: A.id, b: B.id, nomeA: A.nome, nomeB: B.nome,
            palavrasComuns: ta.total,
            propA: Math.round(propA * 1000) / 10, propB: Math.round(propB * 1000) / 10,
            maiorTrecho: maior, gravidade: g,
            trechos: ta.out.sort((x, y) => y.len - x.len).slice(0, 5).map(t => ({
                palavras: t.len,
                texto: A.ws.slice(t.ini, t.ini + Math.min(t.len, 120)).map(w => w.o).join(' ') + (t.len > 120 ? ' […]' : '')
            }))
        });
    });
    const ordem = { ALTA: 0, MEDIA: 1, BAIXA: 2 };
    pares.sort((x, y) => ordem[x.gravidade] - ordem[y.gravidade] || y.palavrasComuns - x.palavrasComuns);
    return { pares, ignoradosComuns, analisados: base.length, semTexto: docs.length - base.length, limiteComum };
}

module.exports = { analisar };
