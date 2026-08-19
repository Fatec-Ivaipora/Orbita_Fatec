// Migração única: lê "MATERIAIS ESTAGIO BIOMEDICINA.xlsx" (aba "Planilha1",
// formato item x fornecedor) e grava fornecedores + itens + cotações no
// módulo Financeiro → Licitação, curso Biomedicina, licitação já cadastrada
// "LICITAÇÃO - BIOMED" (semestre técnico "2026.2-BIO"). A planilha original
// NÃO é apagada.
//
// Duas diferenças em relação à migração de Medicina Veterinária:
//
// 1. Quando o fornecedor só preencheu o valor TOTAL (sem o unitário), a
//    cotação é reconstruída aqui mesmo (unitário = total ÷ quantidade) —
//    evita o mesmo problema que causou divergência na migração anterior.
// 2. A coluna de quantidade tem texto solto ("2 kits", "Conforme preparo",
//    "500 tubos") em vez de só número — o número inicial é extraído; quando
//    não há número (ex.: "Conforme meio"), assume quantidade 1 e guarda o
//    texto original como observação (linkReferencia) pra não perder contexto.
//
// Itens sem NENHUMA cotação (comum aqui — planilha marcada como "materiais
// com dificuldade de achar fornecedor") entram mesmo assim, pendentes — a
// tela de Licitação já mostra "FALTA LICITAÇÃO" sozinha pra qualquer item
// sem cotação, não precisa de nenhum campo extra pra isso.
//
// Dry-run por padrão — grava de verdade só com --commit:
//   node scripts/migrar-materiais-biomedicina.js            (dry-run)
//   node scripts/migrar-materiais-biomedicina.js --commit    (grava)

const XLSX = require('xlsx');
const { db } = require('../src/firebase');

const PLANILHA_PATH = 'C:/Users/metat/OneDrive/Documentos/CLAUDE/MATERIAIS ESTAGIO BIOMEDICINA.xlsx';
const SHEET_NAME = 'Planilha1';
const CURSO_NOME_ALVO = 'BIOMEDICINA';
const SEMESTRE = '2026.2-BIO'; // já cadastrado em financeiro_licitacoes: "LICITAÇÃO - BIOMED"
const COMMIT = process.argv.includes('--commit');

const COL_FORNECEDORES = 'financeiro_fornecedores';
const COL_ITENS = 'financeiro_itens';

const norm = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

function parseValor(raw) {
    if (raw === null || raw === undefined || raw === '') return NaN;
    const limpo = raw.toString().replace(/R\$/gi, '').replace(/\s/g, '').replace(/,/g, '');
    return parseFloat(limpo);
}

// Extrai o número inicial de textos como "2 kits", "500 tubos", "2,000",
// "Conforme preparo" (sem número — vira quantidade 1). Guarda o texto
// original quando ele carrega informação além do número puro.
function parseQuantidade(raw) {
    const textoCru = (raw || '').toString().trim();
    const semVirgula = textoCru.replace(/,/g, '');
    const m = semVirgula.match(/^(\d+(?:\.\d+)?)/);
    if (!m) return { valor: 1, textoOriginal: textoCru || null };
    const valor = parseFloat(m[1]);
    const restante = semVirgula.slice(m[1].length).trim();
    return { valor: valor > 0 ? valor : 1, textoOriginal: restante ? textoCru : null };
}

// Colunas de fornecedor não são fixas — cada par [unitário, total] começa
// onde tiver um texto de cabeçalho na linha de nomes de fornecedor.
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

// Reconstrói a cotação mesmo quando só um dos dois valores (unitário/total)
// foi preenchido — usa quantidade pra completar o outro. Sem isso, cotação
// só-com-total simplesmente desaparecia na migração (foi o que causou a
// divergência corrigida depois na Medicina Veterinária).
function resolverCotacaoVendor(row, slot, quantidade) {
    const unit = parseValor(row[slot.colUnitario]);
    const total = parseValor(row[slot.colUnitario + 1]);
    const temUnit = !isNaN(unit) && unit > 0;
    const temTotal = !isNaN(total) && total > 0;
    if (!temUnit && !temTotal) return null;
    if (temUnit && temTotal) return { valorUnitario: unit, valorTotal: Math.round(total * 100) / 100 };
    if (temUnit) return { valorUnitario: unit, valorTotal: Math.round(unit * quantidade * 100) / 100 };
    return { valorUnitario: Math.round((total / quantidade) * 100) / 100, valorTotal: Math.round(total * 100) / 100 };
}

async function main() {
    console.log(`Lendo planilha: ${PLANILHA_PATH}`);
    console.log(COMMIT ? '>>> MODO COMMIT — vai gravar no Firestore de produção.\n' : '>>> MODO DRY-RUN — só vai imprimir o resumo, nada será gravado.\n');

    const wb = XLSX.readFile(PLANILHA_PATH);
    const sheet = wb.Sheets[SHEET_NAME];
    if (!sheet) throw new Error(`Aba "${SHEET_NAME}" não encontrada. Abas disponíveis: ${wb.SheetNames.join(', ')}`);

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    const headerVendors = rows[1]; // linha 2 do Excel: nomes dos fornecedores
    const dataRows = rows.slice(3); // linha 4 do Excel em diante: dados
    const vendorSlots = mapearVendorSlots(headerVendors, 3);
    console.log(`Fornecedores encontrados na planilha (${vendorSlots.length}): ${vendorSlots.map(s => s.nome).join(', ')}`);

    console.log(`\nBuscando curso "${CURSO_NOME_ALVO}" em \`courses\`...`);
    const cursosSnap = await db.collection('courses').get();
    let curso = null;
    cursosSnap.forEach(d => { if (norm(d.data().name) === CURSO_NOME_ALVO) curso = { id: d.id, ...d.data() }; });
    if (!curso) throw new Error(`Curso "${CURSO_NOME_ALVO}" não encontrado em courses/.`);
    console.log(`Curso resolvido: ${curso.name} (${curso.id})`);

    console.log('\nConferindo se já existem itens nesse semestre/licitação...');
    const existentesSnap = await db.collection(COL_ITENS).where('semestre', '==', SEMESTRE).limit(1).get();
    if (!existentesSnap.empty) {
        console.log(`AVISO: já existem itens com semestre "${SEMESTRE}" — rodar este script de novo vai DUPLICAR itens. Confira antes de commitar.`);
    }

    console.log('\nBuscando fornecedores já cadastrados...');
    const fornecedoresSnap = await db.collection(COL_FORNECEDORES).get();
    const fornecedorPorNomeNorm = new Map();
    fornecedoresSnap.forEach(d => fornecedorPorNomeNorm.set(norm(d.data().nome), { id: d.id, nome: d.data().nome }));

    const fornecedoresReaproveitados = [];
    const fornecedoresNovos = [];
    const resolverFornecedor = (nomeOriginal) => {
        const chave = norm(nomeOriginal);
        const existente = fornecedorPorNomeNorm.get(chave);
        if (existente) {
            if (!fornecedoresReaproveitados.some(f => f.id === existente.id)) fornecedoresReaproveitados.push(existente);
            return existente;
        }
        const jaNaFila = fornecedoresNovos.find(f => norm(f.nomeFinal) === chave);
        if (jaNaFila) return { id: jaNaFila.ref.id, nome: jaNaFila.nomeFinal };
        const nomeFinal = norm(nomeOriginal);
        const ref = db.collection(COL_FORNECEDORES).doc();
        fornecedoresNovos.push({ nomeOriginalPlanilha: nomeOriginal, nomeFinal, ref });
        return { id: ref.id, nome: nomeFinal };
    };

    const itensParaGravar = [];
    let linhasSemItem = 0;
    let totalCotacoes = 0;
    let itensSemCotacao = 0;
    let itensComQuantidadeAproximada = 0;

    for (const row of dataRows) {
        const produtoOriginal = (row[2] || '').toString().trim();
        if (!produtoOriginal) { linhasSemItem++; continue; }

        const { valor: quantidade, textoOriginal: quantidadeTexto } = parseQuantidade(row[0]);
        if (quantidadeTexto) itensComQuantidadeAproximada++;
        const unidade = (row[1] || '').toString().trim().toUpperCase();

        const cotacoes = [];
        vendorSlots.forEach(slot => {
            const resultado = resolverCotacaoVendor(row, slot, quantidade);
            if (!resultado) return;
            const fornecedor = resolverFornecedor(slot.nome);
            cotacoes.push({ fornecedorId: fornecedor.id, fornecedorNome: fornecedor.nome, ...resultado });
            totalCotacoes++;
        });
        if (!cotacoes.length) itensSemCotacao++;

        itensParaGravar.push({
            cursoId: curso.id,
            curso: curso.name,
            produto: norm(produtoOriginal),
            quantidade,
            unidade,
            periodicidade: '',
            professor: '',
            // Guarda o texto original da quantidade (ex.: "Conforme preparo",
            // "5 frascos de cada") como observação — nada de "1" silencioso
            // escondendo que a quantidade real ainda depende de outra coisa.
            linkReferencia: quantidadeTexto ? `Qtd. na planilha: ${quantidadeTexto}` : '',
            status: 'pendente',
            cotacoes,
            semestre: SEMESTRE,
            createdAt: new Date().toISOString(),
            createdBy: 'migracao-materiais-biomedicina',
            updatedAt: new Date().toISOString()
        });
    }

    console.log('\n===== RESUMO DA MIGRAÇÃO =====');
    console.log(`Curso: ${curso.name} | Licitação/semestre: ${SEMESTRE}`);
    console.log(`Linhas sem item (puladas): ${linhasSemItem}`);
    console.log(`Itens prontos para gravar: ${itensParaGravar.length}`);
    console.log(`Cotações totais: ${totalCotacoes}`);
    console.log(`Itens SEM nenhuma cotação (vão aparecer como "FALTA LICITAÇÃO" na tela): ${itensSemCotacao}`);
    console.log(`Itens com quantidade em texto livre na planilha (guardado como observação): ${itensComQuantidadeAproximada}`);
    console.log(`\nFornecedores reaproveitados (${fornecedoresReaproveitados.length}): ${fornecedoresReaproveitados.map(f => f.nome).join(', ') || '(nenhum)'}`);
    console.log(`Fornecedores novos a criar (${fornecedoresNovos.length}): ${fornecedoresNovos.map(f => `"${f.nomeOriginalPlanilha.trim()}" -> ${f.nomeFinal}`).join(', ') || '(nenhum)'}`);

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
            createdBy: 'migracao-materiais-biomedicina'
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

    console.log('\nMigração concluída. Confira em Financeiro > Licitação (curso Biomedicina, licitação "LICITAÇÃO - BIOMED").');
}

main().catch(err => {
    console.error('Erro na migração:', err);
    process.exit(1);
});
