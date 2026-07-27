// Migração única: lê a planilha de cotações de compras (compras.xlsx, uma aba
// por curso) e grava fornecedores + itens + cotações no módulo Financeiro →
// Licitação do Órbita. A planilha original NÃO é apagada.
// Rodar uma única vez: node scripts/migrar-compras-licitacao.js

const XLSX = require('xlsx');
const { db } = require('../src/firebase');

const PLANILHA_PATH = 'C:/Users/metat/OneDrive/Documentos/CLAUDE/compras.xlsx';

const COL_FORNECEDORES = 'financeiro_fornecedores';
const COL_ITENS = 'financeiro_itens';

// Aba da planilha -> nome oficial do curso em `courses` (precisa bater exatamente,
// case-insensitive/trim, com o campo `name` já cadastrado).
const ABA_PARA_CURSO = {
    'AGRONOMIA': 'AGRONOMIA',
    'MED VET': 'MEDICINA VETERINÁRIA',
    'BIOMED': 'BIOMEDICINA',
    'FISIO': 'FISIOTERAPIA',
    'MEDICINA': 'MEDICINA',
    'ENFERMAGEM': 'ENFERMAGEM',
    'PSICOLOGIA': 'PSICOLOGIA' // a aba real tem espaço extra no nome, tratado com trim abaixo
};

const norm = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

const ALIASES = {
    qtd: /^QTD/,
    und: /^UND/,
    periodicidade: /^PERIODICIDADE/,
    professor: /^PROFESSOR/,
    produto: /^PRODUTO/,
    chegou: /^CHEGOU/,
    link: /^LINK/
};

function mapearColunasFixas(headerRow) {
    const cols = {};
    headerRow.forEach((cell, i) => {
        const h = norm(cell);
        if (!h) return;
        for (const [campo, regex] of Object.entries(ALIASES)) {
            if (regex.test(h) && cols[campo] === undefined) cols[campo] = i;
        }
    });
    return cols;
}

// Colunas restantes (fora das fixas) viram pares [valorUnitario, valorTotal(ignorado)]
// por fornecedor. O nome do fornecedor é o texto do cabeçalho da 1ª coluna do par.
function mapearVendorSlots(headerRow, colsFixas) {
    const usadas = new Set(Object.values(colsFixas));
    const slots = [];
    let i = 0;
    while (i < headerRow.length) {
        if (usadas.has(i)) { i++; continue; }
        const h = (headerRow[i] || '').toString().trim();
        if (!h) { i++; continue; }
        slots.push({ nome: h, colUnitario: i });
        i += 2; // pula a coluna de total (não confiamos nela, recalculamos)
    }
    return slots;
}

function parseNumero(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(',', '.'));
    return n;
}

// Fornecedores dedup por nome normalizado, reaproveitados entre todos os cursos.
const fornecedoresPorNomeNormalizado = new Map(); // norm(nome) -> { id, nome }

async function obterOuCriarFornecedor(nomeOriginal, batchState) {
    const key = norm(nomeOriginal);
    if (fornecedoresPorNomeNormalizado.has(key)) return fornecedoresPorNomeNormalizado.get(key);

    const nome = nomeOriginal.trim();
    const docRef = db.collection(COL_FORNECEDORES).doc();
    const registro = { id: docRef.id, nome };
    fornecedoresPorNomeNormalizado.set(key, registro);
    batchState.novosFornecedores.push({ ref: docRef, nome });
    return registro;
}

// Unidades de peso/volume "puras" (sem embalagem/contagem, ex.: "g", "kg", "ml")
// indicam que o preço cotado é do PACOTE inteiro, não por grama/ml — senão o
// total sai inflado (ex.: "500 g" de um reagente virando "500 vezes o preço
// do pacote"). Detectado empiricamente: casos assim tinham QTD>=10 e o preço
// batia com o pacote inteiro, não com preço por unidade de peso.
const UNIDADES_PESO_PURAS = ['g', 'gr', 'grama', 'gramas', 'ml', 'l', 'kg', 'mg'];

function corrigirQuantidadePeso(quantidade, unidade) {
    const unidadeNorm = (unidade || '').trim().toLowerCase();
    if (quantidade >= 10 && UNIDADES_PESO_PURAS.includes(unidadeNorm)) {
        return { quantidade: 1, unidade: `${quantidade} ${unidade.trim()}` };
    }
    return { quantidade, unidade };
}

function processarLinhaGenerica(row, colsFixas, vendorSlots, cursoId, cursoNome, fornecedoresParaCriar) {
    const produtoIdx = colsFixas.produto;
    if (produtoIdx === undefined) return null;
    const produto = (row[produtoIdx] || '').toString().trim();
    if (!produto) return null;

    const qtdBruta = colsFixas.qtd !== undefined ? parseNumero(row[colsFixas.qtd]) : NaN;
    const qtdOriginal = !isNaN(qtdBruta) && qtdBruta > 0 ? qtdBruta : 1;
    const unidadeOriginal = colsFixas.und !== undefined ? (row[colsFixas.und] || '').toString().trim() : '';
    const { quantidade, unidade } = corrigirQuantidadePeso(qtdOriginal, unidadeOriginal);

    const cotacoesPorFornecedor = new Map(); // fornecedorNomeNorm -> {nome, valorUnitario}
    vendorSlots.forEach(slot => {
        const valor = parseNumero(row[slot.colUnitario]);
        if (isNaN(valor) || valor <= 0) return;
        const key = norm(slot.nome);
        const atual = cotacoesPorFornecedor.get(key);
        if (!atual || valor < atual.valorUnitario) {
            cotacoesPorFornecedor.set(key, { nome: slot.nome, valorUnitario: valor });
        }
        fornecedoresParaCriar.add(slot.nome);
    });

    const chegouRaw = colsFixas.chegou !== undefined ? row[colsFixas.chegou] : '';
    const status = (chegouRaw && String(chegouRaw).trim()) ? 'chegou' : 'pendente';

    return {
        cursoId,
        curso: cursoNome,
        produto,
        quantidade,
        unidade,
        periodicidade: colsFixas.periodicidade !== undefined ? (row[colsFixas.periodicidade] || '').toString().trim() : '',
        professor: colsFixas.professor !== undefined ? (row[colsFixas.professor] || '').toString().trim() : '',
        linkReferencia: colsFixas.link !== undefined ? (row[colsFixas.link] || '').toString().trim() : '',
        status,
        cotacoesBrutas: [...cotacoesPorFornecedor.values()] // resolvido pra fornecedorId depois
    };
}

// PSICOLOGIA tem estrutura própria: categoria+subitem, "UND" é texto descritivo
// (ex. "1 kit c/10"), link vem antes do preço, fornecedor único (SAPIENS).
function processarLinhaPsicologia(row, cursoId, cursoNome, fornecedoresParaCriar) {
    const categoria = (row[0] || '').toString().trim();
    const subitem = (row[1] || '').toString().trim();
    if (!categoria && !subitem) return null;
    const produto = [categoria, subitem].filter(Boolean).join(' — ');
    if (!produto) return null;

    const undTexto = (row[2] || '').toString().trim();
    const qtdBruta = parseNumero(row[2]);
    const quantidade = !isNaN(qtdBruta) && qtdBruta > 0 ? qtdBruta : 1;

    const link = (row[4] || '').toString().trim();
    const valor = parseNumero(row[5]);

    const cotacoesBrutas = [];
    if (!isNaN(valor) && valor > 0) {
        cotacoesBrutas.push({ nome: 'SAPIENS', valorUnitario: valor });
        fornecedoresParaCriar.add('SAPIENS');
    }

    return {
        cursoId,
        curso: cursoNome,
        produto,
        quantidade,
        unidade: undTexto,
        periodicidade: '',
        professor: '',
        linkReferencia: link,
        status: 'pendente',
        cotacoesBrutas
    };
}

async function main() {
    console.log(`Lendo planilha: ${PLANILHA_PATH}`);
    const wb = XLSX.readFile(PLANILHA_PATH);

    console.log('Buscando cursos cadastrados...');
    const cursosSnap = await db.collection('courses').get();
    const cursoPorNome = {};
    cursosSnap.forEach(d => { cursoPorNome[norm(d.data().name)] = { id: d.id, ...d.data() }; });

    const resumo = { cursos: {}, avisos: [] };
    const itensParaGravar = [];
    const fornecedoresParaCriar = new Set();

    for (const sheetName of wb.SheetNames) {
        const abaKey = sheetName.trim().toUpperCase();
        const cursoNomeAlvo = ABA_PARA_CURSO[abaKey];
        if (!cursoNomeAlvo) {
            console.log(`Ignorando aba "${sheetName}" (não mapeada para nenhum curso).`);
            continue;
        }
        const curso = cursoPorNome[norm(cursoNomeAlvo)];
        if (!curso) {
            resumo.avisos.push(`Curso "${cursoNomeAlvo}" (aba "${sheetName}") não encontrado em courses/ — aba pulada.`);
            continue;
        }

        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (!rows.length) continue;

        const header = rows[0];
        const dataRows = rows.slice(1);
        let criados = 0, pulados = 0;

        if (abaKey === 'PSICOLOGIA') {
            for (const row of dataRows) {
                const item = processarLinhaPsicologia(row, curso.id, curso.name, fornecedoresParaCriar);
                if (item) { itensParaGravar.push(item); criados++; } else pulados++;
            }
        } else {
            const colsFixas = mapearColunasFixas(header);
            const vendorSlots = mapearVendorSlots(header, colsFixas);
            for (const row of dataRows) {
                const item = processarLinhaGenerica(row, colsFixas, vendorSlots, curso.id, curso.name, fornecedoresParaCriar);
                if (item) { itensParaGravar.push(item); criados++; } else pulados++;
            }
        }

        resumo.cursos[curso.name] = { itens: criados, linhasPuladas: pulados };
        console.log(`Aba "${sheetName}" -> curso "${curso.name}": ${criados} itens, ${pulados} linhas puladas.`);
    }

    // Cria fornecedores únicos (dedup por nome normalizado)
    console.log(`\nCriando ${fornecedoresParaCriar.size} fornecedores únicos...`);
    const batchState = { novosFornecedores: [] };
    for (const nome of fornecedoresParaCriar) {
        await obterOuCriarFornecedor(nome, batchState);
    }
    for (let i = 0; i < batchState.novosFornecedores.length; i += 400) {
        const chunk = batchState.novosFornecedores.slice(i, i + 400);
        const batch = db.batch();
        chunk.forEach(f => batch.set(f.ref, {
            nome: f.nome,
            createdAt: new Date().toISOString(),
            createdBy: 'migracao-compras-licitacao'
        }));
        await batch.commit();
    }
    console.log(`${fornecedoresParaCriar.size} fornecedores gravados.`);

    // Resolve cotacoesBrutas -> cotacoes (com fornecedorId) e grava itens em lotes
    console.log(`\nGravando ${itensParaGravar.length} itens...`);
    let totalCotacoes = 0;
    const docsParaGravar = itensParaGravar.map(item => {
        const cotacoes = item.cotacoesBrutas.map(c => {
            const forn = fornecedoresPorNomeNormalizado.get(norm(c.nome));
            totalCotacoes++;
            return {
                fornecedorId: forn.id,
                fornecedorNome: forn.nome,
                valorUnitario: c.valorUnitario,
                valorTotal: Math.round(c.valorUnitario * item.quantidade * 100) / 100
            };
        });
        const now = new Date().toISOString();
        return {
            cursoId: item.cursoId,
            curso: item.curso,
            produto: item.produto,
            quantidade: item.quantidade,
            unidade: item.unidade,
            periodicidade: item.periodicidade,
            professor: item.professor,
            linkReferencia: item.linkReferencia,
            status: item.status,
            cotacoes,
            createdAt: now,
            createdBy: 'migracao-compras-licitacao',
            updatedAt: now
        };
    });

    for (let i = 0; i < docsParaGravar.length; i += 400) {
        const chunk = docsParaGravar.slice(i, i + 400);
        const batch = db.batch();
        chunk.forEach(dados => batch.set(db.collection(COL_ITENS).doc(), dados));
        await batch.commit();
        console.log(`Gravados ${Math.min(i + 400, docsParaGravar.length)}/${docsParaGravar.length} itens...`);
    }

    console.log('\n===== RESUMO DA MIGRAÇÃO =====');
    Object.entries(resumo.cursos).forEach(([curso, r]) => {
        console.log(`- ${curso}: ${r.itens} itens importados, ${r.linhasPuladas} linhas puladas`);
    });
    console.log(`Fornecedores únicos: ${fornecedoresParaCriar.size}`);
    console.log(`Cotações totais: ${totalCotacoes}`);
    if (resumo.avisos.length) {
        console.log('\nAvisos:');
        resumo.avisos.forEach(a => console.log(`- ${a}`));
    }
    console.log('\nMigração concluída. Revise os dados na tela Financeiro > Licitação.');
}

main().catch(err => {
    console.error('Erro na migração:', err);
    process.exit(1);
});
