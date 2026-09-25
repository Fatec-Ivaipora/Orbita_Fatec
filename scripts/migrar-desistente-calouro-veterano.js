// Migração única (25/09): "Desistente" vira "Desistente — Calouro" (período 1º)
// ou "Desistente — Veterano" (qualquer outro período) nos alunos do sistema
// (`matriculas_alunos`). O histórico da planilha (`matriculas_historico`) não
// é tocado — lá o "Desistente" continua e é separado pelo período na contagem.
//
//   node scripts/migrar-desistente-calouro-veterano.js            (dry-run)
//   node scripts/migrar-desistente-calouro-veterano.js --commit   (grava)

const { db } = require('../src/firebase');

const COMMIT = process.argv.includes('--commit');

async function main() {
    const snap = await db.collection('matriculas_alunos').where('situacao', '==', 'Desistente').get();
    const resumo = {};
    const lote = db.batch();
    snap.forEach(doc => {
        const a = doc.data();
        const nova = (a.periodo || '').trim() === '1º' ? 'Desistente — Calouro' : 'Desistente — Veterano';
        const chave = `${a.modulo} ${a.semestre} → ${nova}`;
        resumo[chave] = (resumo[chave] || 0) + 1;
        lote.update(doc.ref, { situacao: nova, updatedAt: new Date().toISOString() });
    });

    console.log(`${snap.size} aluno(s) com "Desistente":`);
    Object.entries(resumo).sort().forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));

    if (!COMMIT) {
        console.log('\nDry-run: nada foi gravado. Rode com --commit pra gravar.');
        process.exit(0);
    }
    if (snap.size) await lote.commit();
    console.log(`\n${snap.size} aluno(s) atualizados.`);
    process.exit(0);
}

main().catch(err => { console.error('FALHOU:', err.message); process.exit(1); });
