// Grava nomeNorm (nome sem acento/maiúsculo) em todas as matrículas e lista duplicidades por semestre.
// Uso: node scripts/matriculas-nome-norm.js            (só lista, não grava)
//      node scripts/matriculas-nome-norm.js --gravar   (grava nomeNorm onde falta/está diferente)
// Base da regra "uma pessoa = uma matrícula por semestre" (src/utils/matriculas-duplicidade.js, 09/11/2026).
require('dotenv').config({ quiet: true });
const { db } = require('../src/firebase');
const { nomeNorm } = require('../src/utils/matriculas-duplicidade');

(async () => {
    const gravar = process.argv.includes('--gravar');
    const snap = await db.collection('matriculas_alunos').get();
    const porSem = new Map();
    const atualizar = [];
    snap.docs.forEach(d => {
        const x = d.data(), n = nomeNorm(x.nome);
        if (x.nomeNorm !== n) atualizar.push({ ref: d.ref, n });
        if (!porSem.has(x.semestre)) porSem.set(x.semestre, []);
        porSem.get(x.semestre).push({ id: d.id, n, ...x });
    });
    console.log(`Matrículas: ${snap.size} | sem nomeNorm (ou diferente): ${atualizar.length}`);
    const linha = (x) => `${x.nome} | ${x.modulo === 'medicina' ? 'MEDICINA' : x.curso} ${x.periodo || ''} | ${x.situacao}${x.eduboxCodmat ? ' | Edubox ' + x.eduboxCodmat : ''} | id ${x.id}`;
    for (const sem of [...porSem.keys()].sort()) {
        const l = porSem.get(sem);
        const grupos = new Map();
        l.forEach(x => { if (!grupos.has(x.n)) grupos.set(x.n, []); grupos.get(x.n).push(x); });
        const dup = [...grupos.values()].filter(g => g.length > 1);
        // suspeitas: mesmo primeiro e último nome, nomes diferentes
        const partes = (n) => n.split(' ').filter(w => w.length > 2 && !['DOS', 'DAS', 'DES'].includes(w));
        const chaveFL = new Map();
        [...grupos.keys()].forEach(n => { const p = partes(n); if (p.length < 2) return; const k = p[0] + ' ' + p[p.length - 1]; if (!chaveFL.has(k)) chaveFL.set(k, []); chaveFL.get(k).push(n); });
        const susp = [...chaveFL.values()].filter(v => v.length > 1);
        console.log(`\n=== ${sem}: ${l.length} matrículas | DUPLICADAS: ${dup.length} | suspeitas (mesmo 1º e último nome): ${susp.length}`);
        dup.forEach(g => { console.log('  DUPLICADA:'); g.forEach(x => console.log('     ' + linha(x))); });
        susp.forEach(v => { console.log('  suspeita:'); v.forEach(n => grupos.get(n).forEach(x => console.log('     ' + linha(x)))); });
    }
    if (gravar && atualizar.length) {
        for (let i = 0; i < atualizar.length; i += 400) {
            const b = db.batch();
            atualizar.slice(i, i + 400).forEach(a => b.update(a.ref, { nomeNorm: a.n }));
            await b.commit();
        }
        console.log(`\nGravado nomeNorm em ${atualizar.length} matrícula(s).`);
    } else if (!gravar) console.log('\n(só listei — nada gravado; use --gravar pra gravar o nomeNorm)');
    process.exit(0);
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
