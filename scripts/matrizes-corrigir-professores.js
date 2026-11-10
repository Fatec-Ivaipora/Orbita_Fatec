// Troca o nome do professor digitado nos horários das Matrizes pelo nome completo do Edubox, quando o nome
// bate com UM professor só (mesma regra da tela: 1º nome + outros nomes ou o começo; tolerante a 1–2 letras
// de erro). Ambíguos e não achados ficam como estão (o coordenador escolhe na tela). 09/11/2026.
// Uso: node scripts/matrizes-corrigir-professores.js           (simula)
//      node scripts/matrizes-corrigir-professores.js --gravar  (grava)
require('dotenv').config({ quiet: true });
const { db } = require('../src/firebase');
const { relay } = require('../src/utils/edubox-relay');
const { formatosEdubox } = require('../src/utils/matrizes-montar');

const normT = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tituloCaso = (s) => s.toLowerCase().replace(/(^|\s)([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E|Em)\b/g, x => x.toLowerCase());
const contratar = (p) => !String(p || '').trim() || /contrat|a definir|indefinid/i.test(p);
function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}

(async () => {
    const gravar = process.argv.includes('--gravar');
    const sems = ['2027.1', '2026.2', '2026.1', '2025.2'].flatMap(formatosEdubox);
    const r = await relay(`/automacao-ava/titulacoes?semestres=${encodeURIComponent(sems.join(','))}`, { timeoutMs: 45000 });
    const idx = [...new Map((r.professores || []).map(p => [normT(p.nome), p])).values()].map(p => ({ nome: p.nome, toks: normT(p.nome).split(' ') }));
    const candidatos = (d) => {
        const tk = normT(d).split(' ').filter(Boolean);
        if (!tk.length) return [];
        const ex = idx.filter(t => t.toks[0].startsWith(tk[0]) && tk.slice(1).every(w => t.toks.slice(1).some(x => x.startsWith(w))));
        if (ex.length) return ex;
        const tol = (w) => (w.length >= 6 ? 2 : 1);
        const perto = (x, w) => x.startsWith(w) || lev(x, w) <= tol(w) || (w.length < x.length && lev(x.slice(0, w.length), w) <= tol(w) - 1);
        return idx.filter(t => perto(t.toks[0], tk[0]) && tk.slice(1).every(w => t.toks.slice(1).some(x => perto(x, w))));
    };
    const snap = await db.collection('matrizes_grade').get();
    const trocas = new Map(), sobra = new Map();
    const docsAlterar = [];
    snap.forEach(d => {
        const aloc = d.data().alocacoes || {};
        let mudou = false;
        const nova = {};
        Object.entries(aloc).forEach(([k, a]) => {
            nova[k] = { ...a, aulas: (a.aulas || []).map(au => {
                if (contratar(au.professor)) return au;
                const c = candidatos(au.professor);
                if (c.length !== 1) { const s = `${d.data().semestre} | ${au.professor} | ${c.length ? 'ambíguo: ' + c.map(x => tituloCaso(x.nome)).join(' / ') : 'não achado'}`; sobra.set(s, (sobra.get(s) || 0) + 1); return au; }
                const certo = tituloCaso(c[0].nome);
                if (au.professor === certo) return au;
                trocas.set(`${au.professor} → ${certo}`, (trocas.get(`${au.professor} → ${certo}`) || 0) + 1);
                mudou = true;
                return { ...au, professor: certo };
            }) };
        });
        if (mudou) docsAlterar.push({ ref: d.ref, alocacoes: nova });
    });
    console.log(`Trocas (${trocas.size} nomes, ${[...trocas.values()].reduce((a, b) => a + b, 0)} aulas, ${docsAlterar.length} documento(s)):`);
    [...trocas.entries()].sort().forEach(([k, n]) => console.log(`  ${k}  (${n})`));
    console.log(`\nFicam pro coordenador (${sobra.size}):`);
    [...sobra.keys()].sort().forEach(k => console.log('  ' + k));
    if (gravar) {
        for (const d of docsAlterar) await d.ref.update({ alocacoes: d.alocacoes, professoresCorrigidosEm: new Date().toISOString() });
        console.log(`\nGravado em ${docsAlterar.length} documento(s).`);
    } else console.log('\n(simulação — nada gravado; use --gravar)');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
