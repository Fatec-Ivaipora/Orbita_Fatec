// Migração única: lê "ORÇAMENTO MEDICINA VETERINÁRIA (1).xlsx" (aba
// "Inventário Geral", formato item x fornecedor, mesmo estilo do
// compras.xlsx) e grava fornecedores + itens + cotações no módulo
// Financeiro → Licitação, curso Medicina Veterinária, rodada "LIC.MED-VET".
// A planilha original NÃO é apagada.
//
// Reaproveita fornecedor já cadastrado quando o nome bate (evita duplicar
// "Mogiglass"/"Mercado Livre"/"XP Scientific Solution" com um ID novo, o que
// separaria o histórico deles em dois registros diferentes no ranking).
//
// Dry-run por padrão — grava de verdade só com --commit:
//   node scripts/migrar-orcamento-medvet.js            (dry-run)
//   node scripts/migrar-orcamento-medvet.js --commit    (grava)

const XLSX = require('xlsx');
const { db } = require('../src/firebase');

const PLANILHA_PATH = 'C:/Users/metat/OneDrive/Documentos/CLAUDE/ORÇAMENTO MEDICINA VETERINÁRIA (1).xlsx';
const SHEET_NAME = 'Inventário Geral';
const CURSO_NOME_ALVO = 'MEDICINA VETERINÁRIA';
const SEMESTRE = 'LIC.MED-VET';
const COMMIT = process.argv.includes('--commit');

const COL_FORNECEDORES = 'financeiro_fornecedores';
const COL_ITENS = 'financeiro_itens';

const norm = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

function parseValor(raw) {
    if (raw === null || raw === undefined || raw === '') return NaN;
    const limpo = raw.toString().replace(/R\$/gi, '').replace(/\s/g, '').replace(/,/g, '');
    return parseFloat(limpo);
}

const UNIDADE_ALIASES = { UN: 'UN', UM: 'UN', KIT: 'KIT' };
function normalizarUnidade(raw) {
    const chave = norm(raw);
    return UNIDADE_ALIASES[chave] || chave;
}

// Colunas de fornecedor não são fixas (varia por planilha) — cada par
// [valorUnitario, valorTotal(ignorado, recalculado)] começa onde tiver um
// texto de cabeçalho; pula colunas sem cabeçalho até acabar a linha.
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

async function main() {
    console.log(`Lendo planilha: ${PLANILHA_PATH}`);
    console.log(COMMIT ? '>>> MODO COMMIT — vai gravar no Firestore de produção.\n' : '>>> MODO DRY-RUN — só vai imprimir o resumo, nada será gravado.\n');

    const wb = XLSX.readFile(PLANILHA_PATH);
    const sheet = wb.Sheets[SHEET_NAME];
    if (!sheet) throw new Error(`Aba "${SHEET_NAME}" não encontrada. Abas disponíveis: ${wb.SheetNames.join(', ')}`);

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const header = rows[0];
    const dataRows = rows.slice(1);
    const vendorSlots = mapearVendorSlots(header, 3);
    console.log(`Fornecedores encontrados na planilha (${vendorSlots.length}): ${vendorSlots.map(s => s.nome).join(', ')}`);

    console.log('\nBuscando curso "Medicina Veterinária" em `courses`...');
    const cursosSnap = await db.collection('courses').get();
    let curso = null;
    cursosSnap.forEach(d => { if (norm(d.data().name) === CURSO_NOME_ALVO) curso = { id: d.id, ...d.data() }; });
    if (!curso) throw new Error(`Curso "${CURSO_NOME_ALVO}" não encontrado em courses/.`);
    console.log(`Curso resolvido: ${curso.name} (${curso.id})`);

    console.log('\nBuscando fornecedores já cadastrados...');
    const fornecedoresSnap = await db.collection(COL_FORNECEDORES).get();
    const fornecedorPorNomeNorm = new Map(); // norm(nome) -> {id, nome}
    fornecedoresSnap.forEach(d => fornecedorPorNomeNorm.set(norm(d.data().nome), { id: d.id, nome: d.data().nome }));

    // `fornecedorPorNomeNorm` é o retrato do que JÁ existe no banco — nunca é
    // alterado depois (era esse o bug: mutar esse mapa ao criar um fornecedor
    // novo fazia a 2ª ocorrência do mesmo nome, em outra linha da planilha,
    // ser lida como "já existia" e entrar em duas listas do resumo ao mesmo
    // tempo). Fornecedor novo-nesta-migração é controlado só por
    // `fornecedoresNovos`, verificado à parte.
    const fornecedoresReaproveitados = [];
    const fornecedoresNovos = []; // { nomeOriginalPlanilha, nomeFinal, ref }
    const resolverFornecedor = (nomeOriginal) => {
        const chave = norm(nomeOriginal);
        const existente = fornecedorPorNomeNorm.get(chave);
        if (existente) {
            if (!fornecedoresReaproveitados.some(f => f.id === existente.id)) fornecedoresReaproveitados.push(existente);
            return existente;
        }
        const jaNaFila = fornecedoresNovos.find(f => norm(f.nomeFinal) === chave);
        if (jaNaFila) return { id: jaNaFila.ref.id, nome: jaNaFila.nomeFinal };
        const nomeFinal = norm(nomeOriginal); // mesmo padrão maiúsculo dos fornecedores já cadastrados
        const ref = db.collection(COL_FORNECEDORES).doc();
        fornecedoresNovos.push({ nomeOriginalPlanilha: nomeOriginal, nomeFinal, ref });
        return { id: ref.id, nome: nomeFinal };
    };

    const itensParaGravar = [];
    const avisos = [];
    let linhasSemItem = 0;
    let totalCotacoes = 0;

    for (const row of dataRows) {
        const produtoOriginal = (row[0] || '').toString().trim();
        if (!produtoOriginal) { linhasSemItem++; continue; }

        const qtdBruta = parseFloat((row[1] || '').toString().replace(',', '.'));
        const quantidade = !isNaN(qtdBruta) && qtdBruta > 0 ? qtdBruta : 1;
        const unidade = normalizarUnidade(row[2]);

        const cotacoes = [];
        vendorSlots.forEach(slot => {
            const valorUnitario = parseValor(row[slot.colUnitario]);
            if (isNaN(valorUnitario) || valorUnitario <= 0) return;
            const fornecedor = resolverFornecedor(slot.nome);
            cotacoes.push({
                fornecedorId: fornecedor.id,
                fornecedorNome: fornecedor.nome,
                valorUnitario,
                valorTotal: Math.round(valorUnitario * quantidade * 100) / 100
            });
            totalCotacoes++;
        });

        itensParaGravar.push({
            cursoId: curso.id,
            curso: curso.name,
            produto: norm(produtoOriginal),
            quantidade,
            unidade,
            periodicidade: '',
            professor: '',
            linkReferencia: '',
            status: 'pendente',
            cotacoes,
            semestre: SEMESTRE,
            createdAt: new Date().toISOString(),
            createdBy: 'migracao-orcamento-medvet',
            updatedAt: new Date().toISOString()
        });
    }

    console.log('\n===== RESUMO DA MIGRAÇÃO =====');
    console.log(`Curso: ${curso.name} | Semestre/rodada: ${SEMESTRE}`);
    console.log(`Linhas sem item (puladas): ${linhasSemItem}`);
    console.log(`Itens prontos para gravar: ${itensParaGravar.length}`);
    console.log(`Cotações totais: ${totalCotacoes}`);
    console.log(`Itens sem nenhuma cotação (cadastrados mesmo assim, pendente de preço): ${itensParaGravar.filter(i => i.cotacoes.length === 0).length}`);
    console.log(`\nFornecedores reaproveitados (${fornecedoresReaproveitados.length}): ${fornecedoresReaproveitados.map(f => f.nome).join(', ') || '(nenhum)'}`);
    console.log(`Fornecedores novos a criar (${fornecedoresNovos.length}): ${fornecedoresNovos.map(f => `"${f.nomeOriginalPlanilha.trim()}" -> ${f.nomeFinal}`).join(', ') || '(nenhum)'}`);
    avisos.forEach(a => console.log(`Aviso: ${a}`));

    if (!COMMIT) {
        console.log('\nDry-run concluído — nada foi gravado. Revise o resumo acima e rode com --commit pra gravar de verdade.');
        return;
    }

    if (fornecedoresNovos.length) {
        console.log(`\nCriando ${fornecedoresNovos.length} fornecedor(es) novo(s)...`);
        const batch = db.batch();
        fornecedoresNovos.forEach(f => batch.set(f.ref, {
            nome: f.nomeFinal,
            createdAt: new Date().toISOString(),
            createdBy: 'migracao-orcamento-medvet'
        }));
        await batch.commit();
    }

    console.log(`\nGravando ${itensParaGravar.length} itens...`);
    for (let i = 0; i < itensParaGravar.length; i += 400) {
        const chunk = itensParaGravar.slice(i, i + 400);
        const batch = db.batch();
        chunk.forEach(dados => batch.set(db.collection(COL_ITENS).doc(), dados));
        await batch.commit();
        console.log(`Gravados ${Math.min(i + 400, itensParaGravar.length)}/${itensParaGravar.length}...`);
    }

    console.log('\nMigração concluída. Confira em Financeiro > Licitação (curso Medicina Veterinária, semestre LIC.MED-VET).');
}

main().catch(err => {
    console.error('Erro na migração:', err);
    process.exit(1);
});
