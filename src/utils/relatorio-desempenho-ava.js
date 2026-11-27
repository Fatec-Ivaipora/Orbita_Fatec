// ================================================================
//  ÓRBITA — RELATÓRIO DESEMPENHO: estatísticas trazidas do AVA pelo agente (27/11/2026)
//  Antes só dava para subir à mão o CSV de "Estatísticas do questionário" do AVA. Agora o agente do banco do AVA
//  (scripts/ava-banco-med-agente.js), depois de ler os Resultados de uma prova FECHADA (Aplicação de Provas MED),
//  baixa o mesmo CSV ("relatório completo") do questionário e grava o relatório aqui — o mesmo formato que a rota
//  POST /api/relatorio-desempenho grava (src/rotas/relatorio-desempenho.js usa o montarResumo daqui).
//  Documento: banco_med_relatorios/ava__<id da prova> (o mesmo id a cada leitura: atualiza, não duplica).
// ================================================================
const { parseEstatisticas, analisar, calibracao } = require('./parseEstatisticasAva');

const COL = 'banco_med_relatorios';
const MAX_DOC_BYTES = 950000;

// O resumo é o que a listagem mostra — guardado pronto no documento pra listar sem ler as questões
function montarResumo(analise) {
    return {
        total: analise.resumo.total,
        contagens: analise.resumo.contagens,
        discriminacaoMedia: analise.resumo.discriminacaoMedia,
        facilidadeMedia: analise.resumo.facilidadeMedia,
        boasOuExcelentes: analise.resumo.boasOuExcelentes,
        paraRevisar: analise.resumo.paraRevisar,
        comAlternativas: analise.resumo.comAlternativas,
        porSituacao: analise.resumo.porSituacao,
        faceis: analise.resumo.faceis
    };
}

async function lerCalibracaoDoBanco(db) {
    const s = await db.collection('banco_med_config').doc('desempenho').get();
    return calibracao(s.exists ? s.data().calibracao : null);
}

// "📝 Prova · 2º Bimestre" → "Prova · 2º Bimestre"
const semEmoji = (s) => String(s || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, '').replace(/\s+/g, ' ').trim();
const ETAPA = { b1: '1º bimestre', b2: '2º bimestre', sub: '2ª chamada', exame: 'Exame' };

// csvTexto: o CSV do AVA; prova: med_aplicacao_provas; r: o resultado do AVA (cmid, curso, quiz)
// → { id, doc } (não grava)
async function montarDoAva(db, csvTexto, prova, r) {
    const texto = String(csvTexto || '');
    if (/^\s*</.test(texto)) throw new Error('o AVA não devolveu o CSV das estatísticas (veio uma página): o papel de integração precisa de mod/quiz:viewreports, ou o questionário ainda não tem tentativas');
    const nomeArquivo = `${r.curso || prova.disciplina} - ${semEmoji(r.quiz)} (AVA).csv`;
    const lido = await Promise.resolve(parseEstatisticas(Buffer.from(texto, 'utf8'), nomeArquivo));
    if (!lido.questoes || !lido.questoes.length) throw new Error('o CSV das estatísticas veio sem questões');
    const analise = analisar(lido.questoes, await lerCalibracaoDoBanco(db));
    const meta = lido.meta || {};
    const agora = new Date().toISOString();
    const id = `ava__${prova.id}`;
    const atual = await db.collection(COL).doc(id).get();
    const doc = {
        titulo: semEmoji(r.quiz) || meta.titulo || 'Prova',
        cursoTurma: r.curso || meta.cursoTurma || '',
        disciplina: prova.disciplina || '',
        disciplinaId: null,
        periodo: prova.periodo || null,
        semestre: prova.semestre || '',
        turma: prova.turma || '',
        professor: (atual.exists && atual.data().professor) || '',
        aplicacao: prova.data || meta.aplicacao || '',
        encerramento: meta.encerramento || '',
        etapa: ETAPA[prova.etapa] || prova.etapa || '',
        nAlunos: meta.nAlunos !== undefined ? meta.nAlunos : null,
        notaMedia: meta.notaMedia !== undefined ? meta.notaMedia : null,
        desvioPadrao: meta.desvioPadrao !== undefined ? meta.desvioPadrao : null,
        consistenciaInterna: meta.consistenciaInterna !== undefined ? meta.consistenciaInterna : null,
        questoes: analise.questoes,
        resumo: montarResumo(analise),
        avisos: lido.avisos || [],
        nomeArquivo: nomeArquivo.slice(0, 180),
        origem: 'agente-ava', provaId: prova.id, cmid: r.cmid || null, lidoDoAvaEm: agora,
        criadoPor: (atual.exists && atual.data().criadoPor) || 'agente-ava',
        criadoPorNome: (atual.exists && atual.data().criadoPorNome) || 'Agente do AVA',
        createdAt: (atual.exists && atual.data().createdAt) || agora,
        updatedAt: agora
    };
    // o que a coordenação corrigiu no cabeçalho (professor, título…) não é apagado na releitura
    if (atual.exists) ['titulo', 'cursoTurma', 'disciplina', 'periodo', 'semestre', 'turma', 'professor'].forEach(k => {
        if (atual.data().cabecalhoEditadoEm && atual.data()[k]) doc[k] = atual.data()[k];
    });
    const tamanho = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (tamanho > MAX_DOC_BYTES) throw new Error(`relatório grande demais para o Firestore (${Math.round(tamanho / 1024)} KB)`);
    return { id, doc, existia: atual.exists };
}

module.exports = { COL, MAX_DOC_BYTES, montarResumo, montarDoAva, semEmoji };
