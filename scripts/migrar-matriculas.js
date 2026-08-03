// Migração única: lê as 4 abas "Matriz Fatec/Medicina 2026.1/2026.2" da
// planilha geral de alunos e grava em `matriculas_alunos` no módulo
// Financeiro → Relatório Matrículas do Órbita. A planilha original NÃO é
// apagada nem alterada.
//
// Por padrão roda em modo DRY-RUN (só imprime o resumo, não grava nada) —
// escreve na base de produção real, então passe --commit quando já tiver
// revisado o resumo e quiser gravar de verdade:
//   node scripts/migrar-matriculas.js            (dry-run)
//   node scripts/migrar-matriculas.js --commit    (grava)

const XLSX = require('xlsx');
const { db } = require('../src/firebase');

const PLANILHA_PATH = 'C:/Users/metat/OneDrive/Documentos/CLAUDE/PLANILHA GERAL DE ALUNOS - sistema.xlsx';
const COMMIT = process.argv.includes('--commit');

const COL_ALUNOS = 'matriculas_alunos';

const ABAS = [
    { sheet: 'Matriz Fatec 2026.1', modulo: 'fatec', semestre: '2026.1' },
    { sheet: 'Matriz Fatec 2026.2', modulo: 'fatec', semestre: '2026.2' },
    { sheet: 'Matriz Medicina 2026.1', modulo: 'medicina', semestre: '2026.1' },
    { sheet: 'Matriz Medicina 2026.2', modulo: 'medicina', semestre: '2026.2' }
];

// Colunas fixas por posição (não pelo texto do cabeçalho — a planilha tem
// cabeçalho corrompido em vários pontos, ex.: coluna de período às vezes
// aparece com o valor "1º"/"2º" no lugar do rótulo "PERÍODO").
const COL = { nome: 0, curso: 1, periodo: 2, cidade: 3, planoConfissao: 4, situacao: 5, telefone: 6, observacoes: 7 };

const norm = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

// O nome do curso na planilha nem sempre bate 100% com o cadastrado em
// `courses` (acento, abreviação) — resolvido aqui, sem tocar no cadastro de
// cursos em si (que também é usado pelo módulo Licitação).
const CURSO_ALIASES = {
    'ARQUITETURA': 'ARQUITETURA URB.',
    'CIÊNCIAS CONTÁBEIS': 'CONTÁBEIS',
    'ENGENHARIA CIVIL': 'ENGENHARIA CÍVIL',
    'MEDICINA VETERINARIA': 'MEDICINA VETERINÁRIA'
};
function nomeCursoParaBusca(nomeOriginal) {
    const chave = norm(nomeOriginal);
    return CURSO_ALIASES[chave] || nomeOriginal;
}

// Normalização usada tanto nos valores conhecidos (definidos abaixo) quanto
// nos valores crus da planilha — remove travessão/hífen variados, colapsa
// espaço e tira o "sufixo de semestre" (" 2026.1", ".2026.1", "-2026.2"...)
// que é exatamente a bagunça que motivou o campo Situação/Plano ser um select
// fixo no sistema novo, sem semestre embutido no valor.
function chaveComparacao(texto) {
    let t = (texto || '').toString().replace(/[–—]/g, '-').trim().replace(/\s+/g, ' ');
    t = t.replace(/[\s.\-]*\d{4}[.\/]\d\s*$/, '').trim();
    return t.toUpperCase();
}

function construirMapa(paresRaw) {
    const mapa = new Map();
    paresRaw.forEach(([raw, canonico]) => mapa.set(chaveComparacao(raw), canonico));
    return mapa;
}

const MAPA_SITUACAO = construirMapa([
    ['Rematrícula Assinada', 'Rematrícula Assinada'],
    ['Matrícula Nova - Assinada', 'Matrícula Nova - Assinada'],
    ['Matrícula Nova – Assinada', 'Matrícula Nova - Assinada'],
    ['Matrícula Nova', 'Matrícula Nova'],
    ['Cancelou', 'Cancelou'],
    ['Cancelado', 'Cancelou'],
    ['Trancou', 'Trancou'],
    ['1ª Evasão', '1ª Evasão'],
    ['2ª Evasão', '2ª Evasão'],
    ['Retorno', 'Retorno'],
    ['Mudança Curso', 'Mudança de Curso'],
    ['Mudança de Curso', 'Mudança de Curso'],
    ['Desistente', 'Desistente'],
    ['Pendência Financeira', 'Pendência Financeira'],
    ['Não Assinou', 'Não Assinou'],
    ['Transferiu', 'Transferência'],
    ['Transferência', 'Transferência'],
    ['Transferido', 'Transferência'],
    ['Reprovado', 'Reprovado'],
    ['Reprovou', 'Reprovado'],
    ['Retido', 'Reprovado'],
    ['Formando', 'Formando'],
    ['Formandos', 'Formando']
]);

const MAPA_PLANO = construirMapa([
    ['Não', 'Não'],
    ['Nao', 'Não'],
    ['Sim', 'Sim'],
    ['PROUNI Integral', 'PROUNI Integral'],
    ['PROUNI Parcial', 'PROUNI Parcial'],
    ['PROUNI A.A Integral', 'PROUNI Integral (Anos Anteriores)'],
    ['PROUNI A.A Parcial', 'PROUNI Parcial (Anos Anteriores)'],
    ['Pravaler', 'Pravaler']
]);

function normalizarSituacao(valorOriginal) {
    return MAPA_SITUACAO.get(chaveComparacao(valorOriginal)) || null;
}
function normalizarPlano(valorOriginal) {
    if (!valorOriginal || !valorOriginal.toString().trim()) return 'Não';
    return MAPA_PLANO.get(chaveComparacao(valorOriginal)) || null;
}

async function main() {
    console.log(`Lendo planilha: ${PLANILHA_PATH}`);
    console.log(COMMIT ? '>>> MODO COMMIT — vai gravar no Firestore de produção.\n' : '>>> MODO DRY-RUN — só vai imprimir o resumo, nada será gravado.\n');

    const wb = XLSX.readFile(PLANILHA_PATH);

    console.log('Buscando cursos cadastrados em `courses`...');
    const cursosSnap = await db.collection('courses').get();
    const cursoPorNome = {};
    cursosSnap.forEach(d => { cursoPorNome[norm(d.data().name)] = { id: d.id, ...d.data() }; });

    const docsParaGravar = [];
    const resumo = []; // { aba, modulo, semestre, lidos, ok, revisao, avisos }

    for (const aba of ABAS) {
        const sheet = wb.Sheets[aba.sheet];
        if (!sheet) {
            resumo.push({ aba: aba.sheet, modulo: aba.modulo, semestre: aba.semestre, lidos: 0, ok: 0, revisao: 0, avisos: [`Aba "${aba.sheet}" não encontrada na planilha.`] });
            continue;
        }
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
        const dataRows = rows.slice(1);

        let lidos = 0, ok = 0, revisao = 0;
        const avisos = [];
        const cursosNaoEncontrados = new Set();

        for (const row of dataRows) {
            const nome = (row[COL.nome] || '').toString().trim();
            if (!nome) continue; // linha vazia (sobra de formatação da planilha)
            lidos++;

            let cursoId = null, cursoNome = 'Medicina';
            if (aba.modulo === 'fatec') {
                const cursoOriginal = (row[COL.curso] || '').toString().trim();
                const curso = cursoPorNome[norm(nomeCursoParaBusca(cursoOriginal))];
                if (!curso) {
                    cursosNaoEncontrados.add(cursoOriginal || '(vazio)');
                    continue; // sem curso válido não dá pra gravar — entra no aviso, não na revisão manual
                }
                cursoId = curso.id;
                cursoNome = curso.name;
            }

            const situacaoOriginal = (row[COL.situacao] || '').toString().trim();
            const planoOriginal = (row[COL.planoConfissao] || '').toString().trim();
            const situacaoNormalizada = normalizarSituacao(situacaoOriginal);
            const planoNormalizado = normalizarPlano(planoOriginal);
            const precisaRevisar = !situacaoNormalizada || !planoNormalizado;
            if (precisaRevisar) revisao++; else ok++;

            docsParaGravar.push({
                modulo: aba.modulo,
                cursoId,
                curso: cursoNome,
                periodo: (row[COL.periodo] || '').toString().trim(),
                nome,
                cidade: (row[COL.cidade] || '').toString().trim(),
                telefone: (row[COL.telefone] || '').toString().trim(),
                situacao: situacaoNormalizada, // null quando não bateu com nenhum mapeamento
                planoConfissao: planoNormalizado,
                observacoes: (row[COL.observacoes] || '').toString().trim(),
                semestre: aba.semestre,
                revisarManualmente: precisaRevisar,
                situacaoOriginalPlanilha: situacaoOriginal || null,
                planoOriginalPlanilha: planoOriginal || null,
                createdAt: new Date().toISOString(),
                createdBy: 'migracao-matriculas',
                updatedAt: new Date().toISOString()
            });
        }

        if (cursosNaoEncontrados.size) {
            avisos.push(`Curso(s) não encontrado(s) em \`courses\` (linhas puladas, não migradas): ${[...cursosNaoEncontrados].join(', ')}`);
        }
        resumo.push({ aba: aba.sheet, modulo: aba.modulo, semestre: aba.semestre, lidos, ok, revisao, avisos });
    }

    console.log('===== RESUMO DA MIGRAÇÃO =====');
    resumo.forEach(r => {
        console.log(`\n- ${r.aba} (módulo ${r.modulo}, semestre ${r.semestre})`);
        console.log(`  Linhas lidas: ${r.lidos} | OK (situação e plano reconhecidos): ${r.ok} | Foram para revisão manual: ${r.revisao}`);
        r.avisos.forEach(a => console.log(`  Aviso: ${a}`));
    });
    console.log(`\nTotal de registros prontos para gravar: ${docsParaGravar.length}`);
    console.log(`Total pendente de revisão manual (situação/plano fora do padrão): ${docsParaGravar.filter(d => d.revisarManualmente).length}`);

    if (!COMMIT) {
        console.log('\nDry-run concluído — nada foi gravado. Revise o resumo acima e rode com --commit pra gravar de verdade.');
        return;
    }

    console.log(`\nGravando ${docsParaGravar.length} registros em \`${COL_ALUNOS}\`...`);
    for (let i = 0; i < docsParaGravar.length; i += 400) {
        const chunk = docsParaGravar.slice(i, i + 400);
        const batch = db.batch();
        chunk.forEach(dados => batch.set(db.collection(COL_ALUNOS).doc(), dados));
        await batch.commit();
        console.log(`Gravados ${Math.min(i + 400, docsParaGravar.length)}/${docsParaGravar.length}...`);
    }
    console.log('\nMigração concluída. Revise os alunos marcados "revisar" na tela Financeiro > Relatório Matrículas.');
}

main().catch(err => {
    console.error('Erro na migração:', err);
    process.exit(1);
});
