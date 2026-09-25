// Carga do HISTÓRICO de matrículas (2023.1 → 2025.2) a partir das abas
// "Matriz" da PLANILHA GERAL DE ALUNOS, para a coleção `matriculas_historico`.
//
// IMPORTANTE — o que este script grava e o que ele NÃO grava:
// Ele lê os ~7.400 alunos das abas antigas só para CONTAR, e grava apenas os
// totais apurados: 9 documentos, um por módulo+semestre, com as mesmas quebras
// que o relatório usa (por curso × situação, por situação, por plano).
// Nome, cidade, telefone e observação NÃO saem da planilha. Anos fechados
// entram aqui para comparação de números; guardar dado pessoal de aluno que
// ninguém mais gerencia seria carregar risco sem ganho.
// Aluno de verdade continua só em `matriculas_alunos`, nos semestres que o
// setor opera hoje (2026.1 e 2026.2, carregados pelo migrar-matriculas.js).
//
// O id de cada documento é fixo (`fatec_2023.1`, `medicina_2025.2`, ...), então
// rodar duas vezes REESCREVE o mesmo documento em vez de duplicar.
//
//   node scripts/importar-historico-matriculas.js                 (dry-run)
//   node scripts/importar-historico-matriculas.js --detalhe       (mostra os números)
//   node scripts/importar-historico-matriculas.js --commit        (grava)
//   node scripts/importar-historico-matriculas.js --so-quebras    (grava SÓ as
//        quebras calouro/veterano por curso nos documentos que já existem,
//        com update — não toca em total/situações/plano) (25/09)
//
// A planilha original NÃO é alterada.

const XLSX = require('xlsx');
const { db } = require('../src/firebase');

// Caminho da planilha: o padrão é onde ela costuma ficar, mas dá pra apontar
// outro arquivo sem editar o script:
//   node scripts/importar-historico-matriculas.js --planilha="D:/outro/arquivo.xlsx"
const PLANILHA_PADRAO = 'C:/Users/metat/OneDrive/Documentos/CLAUDE/PLANILHA GERAL DE ALUNOS - NOVA.xlsx';
const argPlanilha = process.argv.find(a => a.startsWith('--planilha='));
const PLANILHA_PATH = argPlanilha ? argPlanilha.slice('--planilha='.length) : PLANILHA_PADRAO;

const COMMIT = process.argv.includes('--commit');
const DETALHE = process.argv.includes('--detalhe');
const SO_QUEBRAS = process.argv.includes('--so-quebras');

const COL_HISTORICO = 'matriculas_historico';
const COL_CONFIG = 'matriculas_config';
const DOC_SEMESTRES = 'semestres';

// 2022.2 ficou de fora a pedido do usuário (22/09) — a carga vai de 2023.1 a
// 2025.2. 2026.1 e 2026.2 também não entram: são os semestres vivos, com aluno
// de verdade em `matriculas_alunos`.
const ABAS = [
    { sheet: 'Matriz 2023.1', modulo: 'fatec', semestre: '2023.1' },
    { sheet: 'Matriz 2023.2', modulo: 'fatec', semestre: '2023.2' },
    { sheet: 'Matriz 2024.1', modulo: 'fatec', semestre: '2024.1' },
    { sheet: 'Matriz 2024.2', modulo: 'fatec', semestre: '2024.2' },
    { sheet: 'Matriz Medicina 2024.2', modulo: 'medicina', semestre: '2024.2' },
    { sheet: 'Matriz 2025.1', modulo: 'fatec', semestre: '2025.1' },
    { sheet: 'Matriz Medicina 2025.1', modulo: 'medicina', semestre: '2025.1' },
    { sheet: 'Matriz 2025.2', modulo: 'fatec', semestre: '2025.2' },
    { sheet: 'Matriz Medicina 2025.2', modulo: 'medicina', semestre: '2025.2' }
];

// Colunas por posição, não pelo texto do cabeçalho: em "Matriz 2023.2" e
// "Matriz 2024.1" a 1ª célula do cabeçalho foi apagada, e na de 2023.2 ela
// ainda foi sobrescrita com dados de aluno. A ORDEM das colunas, essa sim, é
// igual nas 9 abas do escopo. (A de 2022.2, fora do escopo, tem TELEFONE e
// OBSERVAÇÕES trocados — se um dia entrar, precisa de um mapa próprio.)
const COL = { nome: 0, curso: 1, periodo: 2, cidade: 3, planoConfissao: 4, situacao: 5, telefone: 6, observacoes: 7 };

const norm = (s) => (s || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();

// O nome do curso na planilha nem sempre bate com o cadastrado em `courses`.
const CURSO_ALIASES = {
    'ARQUITETURA': 'ARQUITETURA URB.',
    'CIÊNCIAS CONTÁBEIS': 'CONTÁBEIS',
    'ENGENHARIA CIVIL': 'ENGENHARIA CÍVIL',
    'MEDICINA VETERINARIA': 'MEDICINA VETERINÁRIA'
};
function nomeCursoParaBusca(nomeOriginal) {
    return CURSO_ALIASES[norm(nomeOriginal)] || nomeOriginal;
}

// Tira o semestre grudado no valor (" 2025.1", ".2026.1", "2022/2") e
// uniformiza travessão/espaço — a bagunça que motivou Situação e Plano
// virarem select fixo no sistema novo.
function chaveComparacao(texto) {
    let t = (texto || '').toString().replace(/[–—]/g, '-').trim().replace(/\s+/g, ' ');
    t = t.replace(/[\s.\-]*\d{4}[.\/]\d\s*$/, '').trim();
    return t.toUpperCase();
}

function construirMapa(pares) {
    const mapa = new Map();
    pares.forEach(([bruto, canonico]) => mapa.set(chaveComparacao(bruto), canonico));
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
    ['Mudança Curso', 'Mudança de Curso'],
    ['Mudança de Curso', 'Mudança de Curso'],
    ['Desistente', 'Desistente'],
    ['Pendência Financeira', 'Pendência Financeira'],
    ['Não Assinou', 'Não Assinou'],
    ['Transferiu', 'Transferência'],
    ['Transferência', 'Transferência'],
    ['Transferencia', 'Transferência'],
    ['Transferido', 'Transferência'],
    ['Reprovado', 'Reprovado'],
    ['Reprovou', 'Reprovado'],
    ['Retido', 'Reprovado'],
    ['Formando', 'Formando'],
    ['Formandos', 'Formando'],
    ['Retorno', 'Matrícula Nova - Retorno']
]);

const MAPA_PLANO = construirMapa([
    ['Não', 'Não'],
    ['Nao', 'Não'],
    ['Naõ', 'Não'],
    ['Sim', 'Sim'],
    ['PROUNI Integral', 'PROUNI Integral'],
    ['PROUNI Parcial', 'PROUNI Parcial'],
    ['Pravaler', 'Pravaler'],
    ['PROUNI A.A Integral', 'PROUNI Integral (Anos Anteriores)'],
    ['PROUNI A.A. Integral', 'PROUNI Integral (Anos Anteriores)'],
    ['PROUNI Integral A.A', 'PROUNI Integral (Anos Anteriores)'],
    ['PROUNI A.A Parcial', 'PROUNI Parcial (Anos Anteriores)'],
    ['PROUNI A.A. Parcial', 'PROUNI Parcial (Anos Anteriores)'],
    ['PROUNI Parcial A.A', 'PROUNI Parcial (Anos Anteriores)'],
    // Resolvidos cruzando a mesma pessoa nos outros anos da planilha (22/09):
    // "BOLSA INTEGRAL" é como a planilha chamava, de 2024.1 a 2025.2, a aluna
    // que em 2026.1/2026.2 já aparece no sistema como "PROUNI A.A INTEGRAL".
    ['Bolsa Integral', 'PROUNI Integral (Anos Anteriores)'],
    // Bolsa cancelada de quem evadiu no mesmo semestre: o plano era PROUNI
    // Parcial, e o cancelamento já está contado na situação "1ª Evasão".
    ['PROUNI Parcial - Cancelado', 'PROUNI Parcial']
]);

const normalizarSituacao = (b) => MAPA_SITUACAO.get(chaveComparacao(b)) || null;
const normalizarPlano = (b) => (!b || !b.toString().trim()) ? 'Não' : (MAPA_PLANO.get(chaveComparacao(b)) || null);

async function main() {
    console.log(`Planilha: ${PLANILHA_PATH}`);
    console.log(COMMIT
        ? '>>> MODO COMMIT — vai gravar no Firestore de produção.\n'
        : '>>> MODO DRY-RUN — nada será gravado.\n');

    if (!require('fs').existsSync(PLANILHA_PATH)) {
        console.error(`\nNão achei a planilha em:\n  ${PLANILHA_PATH}\n` +
                      `Aponte o caminho certo com --planilha="C:/.../arquivo.xlsx".`);
        process.exit(1);
    }
    const wb = XLSX.readFile(PLANILHA_PATH);

    console.log('Lendo cursos cadastrados em `courses`...');
    const cursosSnap = await db.collection('courses').get();
    const cursoPorNome = {};
    cursosSnap.forEach(d => { cursoPorNome[norm(d.data().name)] = { id: d.id, ...d.data() }; });
    console.log(`  ${cursosSnap.size} cursos.\n`);

    const documentos = [];
    const avisos = [];

    for (const aba of ABAS) {
        const sheet = wb.Sheets[aba.sheet];
        if (!sheet) { avisos.push(`Aba "${aba.sheet}" não encontrada.`); continue; }
        const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }).slice(1);

        const porCursoSituacao = {};
        const porSituacaoTotal = {};
        const porPlano = {};
        // Cancelou/Trancou por tipo (calouro = período 1º, veterano = resto)
        // — a situação sozinha não separa isso (mesmo problema do sistema
        // vivo), mas na Matriz o período de cada aluno tá preservado, então dá
        // pra cruzar aqui na importação (pedido 22/09).
        let cancelouCalouro = 0, cancelouVeterano = 0, trancouCalouro = 0, trancouVeterano = 0;
        let desistenteCalouro = 0, desistenteVeterano = 0;
        // Por curso: sem isso a coluna "Calouros captados" do ranking por curso
        // não fecha com o card do semestre (25/09).
        const cancelouCalouroPorCurso = {}, desistenteCalouroPorCurso = {};
        let total = 0, fantasmas = 0;

        for (const linha of linhas) {
            const nome = (linha[COL.nome] || '').toString().trim();
            if (!nome) continue;
            if (['ALUNO', 'NOME', 'NOME DO ALUNO', 'TOTAL'].includes(norm(nome))) continue;

            // Linha fantasma: só o nome preenchido, todo o resto vazio (sobra de
            // duplicação na planilha). Contar isso inflaria o total.
            const temDado = [COL.curso, COL.periodo, COL.cidade, COL.planoConfissao, COL.situacao, COL.telefone]
                .some(i => (linha[i] || '').toString().trim());
            if (!temDado) { fantasmas++; continue; }

            const cursoBruto = (linha[COL.curso] || '').toString().trim();
            const situacao = normalizarSituacao(linha[COL.situacao]);
            const plano = normalizarPlano(linha[COL.planoConfissao]);
            const periodo = (linha[COL.periodo] || '').toString().trim();

            if (!situacao) avisos.push(`[${aba.sheet}] situação não mapeada: "${linha[COL.situacao]}"`);
            if (!plano) avisos.push(`[${aba.sheet}] plano não mapeado: "${linha[COL.planoConfissao]}"`);

            let curso;
            if (aba.modulo === 'medicina') {
                curso = 'Medicina';
            } else {
                const doc = cursoPorNome[norm(nomeCursoParaBusca(cursoBruto))];
                curso = doc ? doc.name : (cursoBruto || '—');
                if (!doc) avisos.push(`[${aba.sheet}] curso fora do cadastro: "${cursoBruto}"`);
            }

            const sit = situacao || (linha[COL.situacao] || '').toString().trim() || '(sem situação)';
            const pl = plano || (linha[COL.planoConfissao] || '').toString().trim() || 'Não';

            total++;
            if (!porCursoSituacao[curso]) porCursoSituacao[curso] = {};
            porCursoSituacao[curso][sit] = (porCursoSituacao[curso][sit] || 0) + 1;
            porSituacaoTotal[sit] = (porSituacaoTotal[sit] || 0) + 1;
            porPlano[pl] = (porPlano[pl] || 0) + 1;

            if (sit === 'Cancelou') {
                periodo === '1º' ? cancelouCalouro++ : cancelouVeterano++;
                if (periodo === '1º') cancelouCalouroPorCurso[curso] = (cancelouCalouroPorCurso[curso] || 0) + 1;
            }
            if (sit === 'Trancou') { periodo === '1º' ? trancouCalouro++ : trancouVeterano++; }
            if (sit === 'Desistente') {
                periodo === '1º' ? desistenteCalouro++ : desistenteVeterano++;
                if (periodo === '1º') desistenteCalouroPorCurso[curso] = (desistenteCalouroPorCurso[curso] || 0) + 1;
            }
        }

        documentos.push({
            id: `${aba.modulo}_${aba.semestre}`,
            fantasmas,
            dados: {
                modulo: aba.modulo,
                semestre: aba.semestre,
                total,
                cursos: Object.keys(porCursoSituacao).sort((a, b) => a.localeCompare(b)),
                porCursoSituacao,
                porSituacaoTotal,
                porPlano,
                cancelouCalouro,
                cancelouVeterano,
                trancouCalouro,
                trancouVeterano,
                desistenteCalouro,
                desistenteVeterano,
                cancelouCalouroPorCurso,
                desistenteCalouroPorCurso,
                // Procedência: deixa explícito que veio da planilha antiga e que
                // não existe aluno por trás desses números dentro do sistema.
                origem: 'planilha-historica',
                arquivoOrigem: PLANILHA_PATH.split(/[\\/]/).pop(),
                importadoEm: new Date().toISOString()
            }
        });
    }

    console.log('='.repeat(78));
    console.log('RESUMO — um documento por módulo + semestre, só com contagens');
    console.log('='.repeat(78));
    let soma = 0;
    for (const d of documentos) {
        const bytes = Buffer.byteLength(JSON.stringify(d.dados), 'utf8');
        console.log(
            `  ${d.id.padEnd(18)} total=${String(d.dados.total).padStart(5)}` +
            `  cursos=${String(d.dados.cursos.length).padStart(2)}` +
            `  situações=${String(Object.keys(d.dados.porSituacaoTotal).length).padStart(2)}` +
            `  ${(bytes / 1024).toFixed(1)} KB` +
            `${d.fantasmas ? `  linhas vazias ignoradas=${d.fantasmas}` : ''}`
        );
        soma += d.dados.total;
    }
    console.log('-'.repeat(78));
    console.log(`  ${documentos.length} documentos · ${soma} alunos contados · nenhum nome gravado`);

    const unicos = [...new Set(avisos)];
    if (unicos.length) {
        console.log(`\nAVISOS (${unicos.length}):`);
        unicos.slice(0, 20).forEach(a => console.log('  ' + a));
    }

    if (DETALHE) {
        console.log('\n' + '='.repeat(78));
        for (const d of documentos) {
            console.log(`\n${d.id} — total ${d.dados.total}`);
            console.log('  por situação:', JSON.stringify(d.dados.porSituacaoTotal));
            console.log('  por plano   :', JSON.stringify(d.dados.porPlano));
        }
    }

    if (SO_QUEBRAS) {
        // Confere antes de gravar: o total e o cancelouCalouro recalculados
        // precisam bater com o que já está no banco — se não baterem, a
        // planilha mudou desde a importação e não é seguro misturar.
        console.log('\nConferindo com o que já está gravado...');
        const QUEBRAS = ['cancelouCalouroPorCurso', 'desistenteCalouroPorCurso', 'desistenteCalouro', 'desistenteVeterano'];
        const atualizacoes = [];
        for (const d of documentos) {
            const atual = await db.collection(COL_HISTORICO).doc(d.id).get();
            if (!atual.exists) { console.log(`  ${d.id}: não existe no banco — pulado`); continue; }
            const a = atual.data();
            const somaPorCurso = Object.values(d.dados.cancelouCalouroPorCurso).reduce((x, y) => x + y, 0);
            const ok = a.total === d.dados.total && (a.cancelouCalouro || 0) === d.dados.cancelouCalouro
                && somaPorCurso === d.dados.cancelouCalouro;
            console.log(`  ${d.id.padEnd(18)} total ${a.total}→${d.dados.total}  cancelouCalouro ${a.cancelouCalouro || 0}→${d.dados.cancelouCalouro} (por curso soma ${somaPorCurso})  desistente calouro ${d.dados.desistenteCalouro}/veterano ${d.dados.desistenteVeterano}  ${ok ? 'OK' : 'DIVERGE'}`);
            if (!ok) { console.error('\nDivergência com o banco — nada foi gravado.'); process.exit(1); }
            const campos = {};
            QUEBRAS.forEach(k => { campos[k] = d.dados[k]; });
            atualizacoes.push([d.id, campos]);
        }
        if (!COMMIT) {
            console.log('\nDry-run: nada foi gravado. Rode com --so-quebras --commit pra gravar só essas quebras.');
            process.exit(0);
        }
        const loteQ = db.batch();
        atualizacoes.forEach(([id, campos]) => loteQ.update(db.collection(COL_HISTORICO).doc(id), campos));
        await loteQ.commit();
        console.log(`\n${atualizacoes.length} documentos atualizados (só as quebras por curso).`);
        process.exit(0);
    }

    if (!COMMIT) {
        console.log('\nDry-run: nada foi gravado. Rode com --commit quando o resumo estiver certo.');
        console.log('Dica: --detalhe mostra os números de cada semestre antes de gravar.');
        process.exit(0);
    }

    console.log('\nGravando...');
    const lote = db.batch();
    documentos.forEach(d => lote.set(db.collection(COL_HISTORICO).doc(d.id), d.dados));
    await lote.commit();
    console.log(`  ${documentos.length} documentos gravados em ${COL_HISTORICO}.`);

    // Sem isso os semestres históricos não aparecem no seletor da tela.
    const semestresNovos = [...new Set(ABAS.map(a => a.semestre))];
    const cfgRef = db.collection(COL_CONFIG).doc(DOC_SEMESTRES);
    const cfg = await cfgRef.get();
    const lista = [...new Set([
        ...(cfg.exists && Array.isArray(cfg.data().lista) ? cfg.data().lista : []),
        ...semestresNovos
    ])].sort();
    await cfgRef.set({ lista }, { merge: true });
    console.log(`Semestres disponíveis agora: ${lista.join(', ')}`);

    console.log('\nPronto.');
    process.exit(0);
}

main().catch(err => {
    console.error('\nFALHOU:', err.message);
    process.exit(1);
});
