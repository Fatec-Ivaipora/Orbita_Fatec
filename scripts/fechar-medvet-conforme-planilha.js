// Fecha os itens da licitação LIC.MED-VET (Medicina Veterinária) exatamente
// como a planilha "ORÇAMENTO MEDICINA VETERINÁRIA (1).xlsx" já decidiu — o
// vencedor de cada item não é sempre a cotação mais barata, é o que está
// destacado com a cor daquele fornecedor na planilha (ver legenda nas
// linhas 87-89 da aba "Inventário Geral"). O total dessa decisão bate
// exatamente com o "TOTAL" da planilha: R$ 439.193,97.
//
// Dry-run por padrão — grava de verdade só com --commit:
//   node scripts/fechar-medvet-conforme-planilha.js            (dry-run)
//   node scripts/fechar-medvet-conforme-planilha.js --commit    (grava)

const XLSX = require('xlsx');
const { db } = require('../src/firebase');

const PLANILHA_PATH = 'C:/Users/metat/OneDrive/Documentos/CLAUDE/ORÇAMENTO MEDICINA VETERINÁRIA (1).xlsx';
const SHEET_NAME = 'Inventário Geral';
const SEMESTRE = 'LIC.MED-VET';
const COMMIT = process.argv.includes('--commit');

const COL_ITENS = 'financeiro_itens';
const norm = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

function parseValor(raw) {
    if (raw === null || raw === undefined || raw === '') return NaN;
    const limpo = raw.toString().replace(/R\$/gi, '').replace(/\s/g, '').replace(/,/g, '');
    return parseFloat(limpo);
}

function mapearVendorSlots(headerRow, primeiraColuna) {
    const slots = [];
    let i = primeiraColuna;
    while (i < headerRow.length) {
        const h = (headerRow[i] || '').toString().trim();
        if (!h) { i++; continue; }
        slots.push({ nome: h, colUnitario: i });
        i += 2;
    }
    return slots;
}

function fillKey(cell) {
    if (!cell || !cell.s || !cell.s.fgColor) return null;
    const fg = cell.s.fgColor;
    if (fg.theme === 0) return null;
    return JSON.stringify({ theme: fg.theme, tint: fg.tint, rgb: fg.rgb });
}

async function main() {
    console.log(`Lendo planilha: ${PLANILHA_PATH}`);
    console.log(COMMIT ? '>>> MODO COMMIT — vai gravar fechamento no Firestore de produção.\n' : '>>> MODO DRY-RUN — só vai imprimir o resumo, nada será gravado.\n');

    const wb = XLSX.readFile(PLANILHA_PATH, { cellStyles: true });
    const sheet = wb.Sheets[SHEET_NAME];
    if (!sheet) throw new Error(`Aba "${SHEET_NAME}" não encontrada.`);

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const header = rows[0];
    const vendorSlots = mapearVendorSlots(header, 3); // colU (D,F,H,J,L,N,P,R) por vendor

    // Legenda de cor -> fornecedor, lida da tabela-resumo no rodapé da aba
    // (linha 88 em Excel = índice 87 no array de linhas, colunas F..L).
    const legendCols = ['F', 'G', 'H', 'I', 'J', 'K', 'L'];
    const colorToVendor = {};
    legendCols.forEach(c => {
        const cell = sheet[c + '88'];
        const key = fillKey(cell);
        if (key && cell.v) colorToVendor[key] = cell.v.toString().trim();
    });
    // Variante de azul observada na planilha pro mesmo fornecedor (AMA MEDICAL)
    // — cor ligeiramente diferente da usada na legenda, mas no mesmo produto.
    colorToVendor[JSON.stringify({ theme: 8, rgb: '4BACC6' })] = 'AMA MEDICAL';

    // Mapa nome-da-planilha -> nome-final-no-sistema (mesmo usado na migração
    // original, pra bater com o fornecedorNome já gravado nas cotações).
    const nomeVendorFinal = {};
    vendorSlots.forEach(s => { nomeVendorFinal[norm(s.nome)] = norm(s.nome); });
    // "XP SCIENTIFIC" (legenda, sem "SOLUTION") e "XP SCIENTIFIC SOLUTION"
    // (coluna real) são o mesmo fornecedor — a legenda abrevia o nome.
    nomeVendorFinal[norm('XP SCIENTIFIC')] = norm('XP SCIENTIFIC SOLUTION');

    const totalColsPorSlot = vendorSlots.map(s => ({ nome: s.nome, colTotal: s.colUnitario + 1 }));

    console.log('Buscando itens já cadastrados de LIC.MED-VET...');
    const snap = await db.collection(COL_ITENS).where('semestre', '==', SEMESTRE).get();
    const docsDisponiveis = snap.docs.map(d => ({ id: d.id, ref: d.ref, data: d.data(), usado: false }));
    console.log(`Itens no sistema: ${docsDisponiveis.length}`);

    const fechamentos = []; // { docId, produto, quantidade, fornecedorNome, valorFechado }
    const semDestaque = [];
    const semCorrespondencia = [];

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const produtoOriginal = (row[0] || '').toString().trim();
        if (!produtoOriginal) continue;

        const excelRow = r + 1; // header ocupa a linha 1 do Excel; rows[1] = linha 2
        const qtdBruta = parseFloat((row[1] || '').toString().replace(',', '.'));
        const quantidade = !isNaN(qtdBruta) && qtdBruta > 0 ? qtdBruta : 1;
        const produtoNorm = norm(produtoOriginal);

        // Recalcula as cotações da linha, igual à migração original, pra
        // formar a mesma "impressão digital" (produto+quantidade+cotações)
        // usada pra achar o doc certo no Firestore.
        const cotacoesLinha = [];
        vendorSlots.forEach(slot => {
            const valorUnitario = parseValor(row[slot.colUnitario]);
            if (isNaN(valorUnitario) || valorUnitario <= 0) return;
            cotacoesLinha.push({
                fornecedorNome: norm(slot.nome === 'XP SCIENTIFIC SOLUTION' ? slot.nome : slot.nome),
                valorTotal: Math.round(valorUnitario * quantidade * 100) / 100
            });
        });

        // Descobre qual fornecedor foi destacado (cor) nessa linha, olhando
        // a célula de TOTAL de cada slot de fornecedor.
        let vencedor = null;
        for (const slot of totalColsPorSlot) {
            const colLetra = XLSX.utils.encode_col(slot.colTotal);
            const cell = sheet[colLetra + excelRow];
            const key = fillKey(cell);
            if (key && colorToVendor[key] && cell.v) {
                vencedor = { fornecedorNome: colorToVendor[key], valorFechado: parseFloat(cell.v) };
                break;
            }
        }
        if (!vencedor) {
            semDestaque.push(`linha ${excelRow}: ${produtoOriginal}`);
            continue;
        }

        const fornecedorFinal = nomeVendorFinal[norm(vencedor.fornecedorNome)] || norm(vencedor.fornecedorNome);

        // Acha o doc no Firestore com o mesmo produto+quantidade+conjunto de
        // cotações, ainda não usado (produto repetido tem várias linhas —
        // "usado" evita casar duas linhas diferentes com o mesmo doc).
        const fingerprint = (data) => {
            const cots = (data.cotacoes || []).map(c => `${norm(c.fornecedorNome)}:${c.valorTotal}`).sort().join('|');
            return `${data.produto}::${data.quantidade}::${cots}`;
        };
        const fpLinha = `${produtoNorm}::${quantidade}::${cotacoesLinha.map(c => `${c.fornecedorNome}:${c.valorTotal}`).sort().join('|')}`;

        const candidato = docsDisponiveis.find(d => !d.usado && fingerprint(d.data) === fpLinha);
        if (!candidato) {
            semCorrespondencia.push(`linha ${excelRow}: ${produtoOriginal} (qtd ${quantidade}) — nenhum doc bate com essa combinação de cotações`);
            continue;
        }
        candidato.usado = true;

        fechamentos.push({
            docId: candidato.id,
            produto: produtoNorm,
            quantidade,
            fornecedorNome: fornecedorFinal,
            valorFechado: Math.round(vencedor.valorFechado * 100) / 100
        });
    }

    const totalFechamento = fechamentos.reduce((s, f) => s + f.valorFechado, 0);

    console.log('\n===== RESUMO =====');
    console.log(`Itens com destaque de cor na planilha: ${fechamentos.length + semCorrespondencia.length}`);
    console.log(`Itens sem nenhuma cor destacada (pulados): ${semDestaque.length}`);
    semDestaque.forEach(s => console.log('  - ' + s));
    console.log(`Itens SEM correspondência no Firestore (não serão fechados): ${semCorrespondencia.length}`);
    semCorrespondencia.forEach(s => console.log('  - ' + s));
    console.log(`\nItens que serão fechados: ${fechamentos.length}`);
    console.log(`Total do fechamento: R$ ${totalFechamento.toFixed(2)} (planilha: R$ 439.193,97)`);

    const porVendor = {};
    fechamentos.forEach(f => { porVendor[f.fornecedorNome] = (porVendor[f.fornecedorNome] || 0) + f.valorFechado; });
    console.log('\nPor fornecedor:');
    Object.entries(porVendor).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(25)} R$ ${v.toFixed(2)}`));

    if (!COMMIT) {
        console.log('\nDry-run concluído — nada foi gravado. Revise o resumo acima e rode com --commit pra gravar de verdade.');
        return;
    }

    console.log('\nBuscando fornecedores cadastrados para resolver os IDs...');
    const fornecedoresSnap = await db.collection('financeiro_fornecedores').get();
    const idPorNome = new Map();
    fornecedoresSnap.forEach(d => idPorNome.set(norm(d.data().nome), d.id));

    console.log(`Gravando fechamento de ${fechamentos.length} itens...`);
    for (let i = 0; i < fechamentos.length; i += 400) {
        const chunk = fechamentos.slice(i, i + 400);
        const batch = db.batch();
        chunk.forEach(f => {
            const fornecedorId = idPorNome.get(norm(f.fornecedorNome));
            if (!fornecedorId) throw new Error(`Fornecedor "${f.fornecedorNome}" não encontrado em financeiro_fornecedores.`);
            const docRef = db.collection(COL_ITENS).doc(f.docId);
            batch.update(docRef, {
                status: 'fechado',
                fornecedorFechadoId: fornecedorId,
                fornecedorFechadoNome: f.fornecedorNome,
                valorFechado: f.valorFechado,
                fechadoEm: new Date().toISOString(),
                fechadoPor: 'migracao-fechamento-medvet'
            });
        });
        await batch.commit();
        console.log(`Gravados ${Math.min(i + 400, fechamentos.length)}/${fechamentos.length}...`);
    }

    console.log('\nFechamento concluído. Confira em Financeiro > Licitação > Relatório (licitação LIC.MED-VET).');
}

main().catch(err => {
    console.error('Erro:', err);
    process.exit(1);
});
