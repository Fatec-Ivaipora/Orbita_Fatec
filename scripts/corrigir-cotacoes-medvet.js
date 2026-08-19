// Corrige os 12 itens da LIC.MED-VET (Medicina Veterinária) identificados na
// auditoria: a migração original só reconhece uma cotação quando a célula de
// "valor unitário" está preenchida — quando o fornecedor só escreveu o valor
// TOTAL (comum em equipamento grande, orçamento fechado), essa cotação nunca
// entrou no sistema. Aqui a gente repõe essas cotações usando
// unitário = total ÷ quantidade (não copia o total cru — pra item com
// quantidade > 1 isso dobraria o valor errado).
//
// Um item (KIT SONDA ENDO TRAQUEAL, linha 60) tem um problema diferente: erro
// de digitação na própria planilha (unitário 6,06 não bate com o total 60,63
// pro mesmo fornecedor) — aqui a cotação já existe, só corrige o valor.
//
// Todo item tocado recebe `precisaConferencia: true` + `motivoConferencia`
// (explicando o que foi reconstruído) — pra aparecer com um aviso na tela de
// Licitação e o financeiro conferir contra a planilha antes de fechar,
// nenhum item é fechado automaticamente por este script.
//
// Dry-run por padrão — grava de verdade só com --commit:
//   node scripts/corrigir-cotacoes-medvet.js            (dry-run)
//   node scripts/corrigir-cotacoes-medvet.js --commit    (grava)

const { db } = require('../src/firebase');
const COMMIT = process.argv.includes('--commit');
const COL_ITENS = 'financeiro_itens';
const COL_FORNECEDORES = 'financeiro_fornecedores';
const norm = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

// docId: já identificado na auditoria (auditoria-medvet.html), casando
// produto+quantidade+conjunto de cotações contra a linha correspondente da
// planilha "ORÇAMENTO MEDICINA VETERINÁRIA (1).xlsx".
const CORRECOES = [
    { docId: 'li783RRWmgSUjzXKYWtj', produto: 'LIXEIRA COM PEDAL 100 LITROS', quantidade: 2, tipo: 'adicionar', fornecedorNome: 'XP SCIENTIFIC SOLUTION', total: 399.00 },
    { docId: '43X3OFM9sDIGC38qfXMS', produto: 'KIT SONDA ENDO TRAQUEAL', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'MERCADO LIVRE', total: 60.63 },
    { docId: 'X7pAJydds6kFg2s3Lrzo', produto: 'RAIO-X DIGITAL', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'XP SCIENTIFIC SOLUTION', total: 59600.00 },
    { docId: 'UrhvSA0MY9K8uSPzTGqI', produto: 'GELADEIRA', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'MAGAZINE LUIZA', total: 2202.93 },
    { docId: 'kEhWEHLeAPTQz1SCOUzr', produto: 'MICROSCÓPIO BINOCULAR', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'XP SCIENTIFIC SOLUTION', total: 1900.00 },
    { docId: 'SYL28YDLo1IjP8FTOVFk', produto: 'ANALISADOR HEMATOLÓGICO', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'XP SCIENTIFIC SOLUTION', total: 59900.00 },
    { docId: 'vZCcJkFGJ5OKsVMZI2G8', produto: 'ANALISADOR BIOQUÍMICO', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'XP SCIENTIFIC SOLUTION', total: 29600.00 },
    { docId: '3amK1r8t3xRIL1SYFs53', produto: 'CAMERA DE VÍDEO', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'MERCADO LIVRE', total: 3882.08 },
    { docId: 'yaDteMPMbaWCHc2ZopuP', produto: 'BRAÇO ARTICULADO PARA CAMERA', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'MERCADO LIVRE', total: 254.62 },
    { docId: 'AS760oGs6D2GDPwlRXMc', produto: 'KIT SONDA ENDO TRAQUEAL', quantidade: 1, tipo: 'corrigir', fornecedorNome: 'MERCADO LIVRE', total: 60.63 },
    { docId: 'AmY7xvlZ0wXVkVtuDMeP', produto: 'AUTOCLAVE', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'XP SCIENTIFIC SOLUTION', total: 16000.00 },
    { docId: 'Fshki5EUl6M02Hwm6gwM', produto: 'FREEZER', quantidade: 1, tipo: 'adicionar', fornecedorNome: 'MAGAZINE LUIZA', total: 3179.00 }
];

async function main() {
    console.log(COMMIT ? '>>> MODO COMMIT — vai gravar no Firestore de produção.\n' : '>>> MODO DRY-RUN — só vai imprimir o resumo, nada será gravado.\n');

    console.log('Buscando fornecedores cadastrados...');
    const fornecedoresSnap = await db.collection(COL_FORNECEDORES).get();
    const idPorNome = new Map();
    fornecedoresSnap.forEach(d => idPorNome.set(norm(d.data().nome), d.id));

    const operacoes = [];
    for (const c of CORRECOES) {
        const docSnap = await db.collection(COL_ITENS).doc(c.docId).get();
        if (!docSnap.exists) {
            console.log(`AVISO: doc ${c.docId} (${c.produto}) não encontrado — pulando.`);
            continue;
        }
        const item = docSnap.data();
        const fornecedorId = idPorNome.get(norm(c.fornecedorNome));
        if (!fornecedorId) {
            console.log(`AVISO: fornecedor "${c.fornecedorNome}" não encontrado — pulando ${c.produto}.`);
            continue;
        }

        const valorUnitario = Math.round((c.total / c.quantidade) * 100) / 100;
        const valorTotal = Math.round(c.total * 100) / 100;
        const cotacoesAtuais = item.cotacoes || [];
        let novasCotacoes;
        let motivo;

        if (c.tipo === 'adicionar') {
            novasCotacoes = [...cotacoesAtuais, {
                fornecedorId, fornecedorNome: norm(c.fornecedorNome), valorUnitario, valorTotal
            }];
            motivo = `Cotação da ${norm(c.fornecedorNome)} (R$ ${valorTotal.toFixed(2)}) não entrou na migração original — a planilha só tinha o valor total preenchido, sem o unitário. Reconstruída como total ÷ quantidade. Confira contra a planilha antes de fechar.`;
        } else {
            novasCotacoes = cotacoesAtuais.map(cot =>
                norm(cot.fornecedorNome) === norm(c.fornecedorNome)
                    ? { ...cot, valorUnitario, valorTotal }
                    : cot
            );
            motivo = `Valor da cotação da ${norm(c.fornecedorNome)} corrigido de R$ ${(cotacoesAtuais.find(cot => norm(cot.fornecedorNome) === norm(c.fornecedorNome))?.valorTotal ?? 0).toFixed(2)} para R$ ${valorTotal.toFixed(2)} — o unitário digitado na planilha original não batia com o total dela. Confira contra a planilha antes de fechar.`;
        }

        operacoes.push({ docId: c.docId, produto: c.produto, tipo: c.tipo, fornecedorNome: norm(c.fornecedorNome), valorUnitario, valorTotal, novasCotacoes, motivo });
    }

    console.log('\n===== RESUMO =====');
    operacoes.forEach(op => {
        console.log(`[${op.tipo === 'adicionar' ? 'ADICIONAR' : 'CORRIGIR '}] ${op.produto} — ${op.fornecedorNome}: unitário R$ ${op.valorUnitario.toFixed(2)} / total R$ ${op.valorTotal.toFixed(2)}`);
    });
    console.log(`\nItens que serão marcados com "precisaConferencia": ${operacoes.length}`);

    if (!COMMIT) {
        console.log('\nDry-run concluído — nada foi gravado. Revise o resumo acima e rode com --commit pra gravar de verdade.');
        return;
    }

    console.log('\nGravando correções...');
    const batch = db.batch();
    operacoes.forEach(op => {
        batch.update(db.collection(COL_ITENS).doc(op.docId), {
            cotacoes: op.novasCotacoes,
            precisaConferencia: true,
            motivoConferencia: op.motivo,
            updatedAt: new Date().toISOString()
        });
    });
    await batch.commit();
    console.log(`Gravado. ${operacoes.length} itens corrigidos e marcados para conferência.`);
}

main().catch(err => {
    console.error('Erro:', err);
    process.exit(1);
});
