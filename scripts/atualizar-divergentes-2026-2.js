// Aplica no Firestore só as mudanças reais encontradas pelo diff (scripts/diff-matriculas-2026-2.js)
// entre o sistema e a planilha nova, pro semestre 2026.2 — atualiza apenas os
// campos que divergem em cada doc já existente (mantém o mesmo ID, não recria
// nada, não mexe em quem já está igual). Não mexe nos casos "só na planilha",
// "só no sistema" nem duplicados — esses ficam de fora até decisão manual.
//
//   node scripts/atualizar-divergentes-2026-2.js            (dry-run)
//   node scripts/atualizar-divergentes-2026-2.js --commit    (grava)

const fs = require('fs');
const path = require('path');
const { db } = require('../src/firebase');

const DIFF_PATH = path.join(__dirname, '..', '..', 'diff-matriculas-2026-2-resultado.json');
const COL_ALUNOS = 'matriculas_alunos';
const COMMIT = process.argv.includes('--commit');

async function main() {
    const { divergentes } = JSON.parse(fs.readFileSync(DIFF_PATH, 'utf8'));
    console.log(`Divergências a aplicar: ${divergentes.length}`);
    console.log(COMMIT ? '>>> MODO COMMIT — vai gravar no Firestore de produção.\n' : '>>> MODO DRY-RUN — só vai imprimir, nada será gravado.\n');

    for (const d of divergentes) {
        const updates = {};
        d.camposDiferentes.forEach(campo => { updates[campo] = d.planilha[campo]; });
        if (updates.situacao !== undefined) updates.situacaoOriginalPlanilha = d.planilha.situacaoOriginalPlanilha;
        updates.updatedAt = new Date().toISOString();
        updates.updatedBy = 'atualizacao-planilha-nova-2026.2';

        console.log(`${d.sistema.nome} (${d.sistema.curso}) [${d.sistema.id}]`);
        d.camposDiferentes.forEach(c => console.log(`   ${c}: "${d.sistema[c] || ''}" -> "${d.planilha[c] || ''}"`));

        if (COMMIT) {
            await db.collection(COL_ALUNOS).doc(d.sistema.id).update(updates);
        }
    }

    console.log(COMMIT ? `\nAtualizados ${divergentes.length} registros.` : `\nDry-run concluído. Rode com --commit pra gravar de verdade.`);
}

main().catch(err => { console.error('Erro:', err); process.exit(1); });
