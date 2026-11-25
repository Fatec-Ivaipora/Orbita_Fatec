// ==========================================================================
// Moodle XML de uma avaliação finalizada do Banco MED, montado no SERVIDOR/script (25/11/2026).
// Mesmo resultado do botão "Baixar para o AVA" (banco-med-fatec/avaliacoes.js → prepararParaXml + baixarXml):
// todas as questões da prova na ordem, imagens do enunciado e do feedback vindas do Storage em tamanho original,
// nome no AVA "[2ºB 1ªCH 01] …" e a pasta Disciplina / semestre / bimestre / chamada.
// Usado pela importação automática no banco do AVA (scripts/banco-med-ava-fila.js). Não marca exportação.
// ==========================================================================
const { db, admin } = require('../firebase');
const { gerarMoodleXml } = require('./moodleXml');

const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'orbita-fatecivp.firebasestorage.app';
const bucket = () => admin.storage().bucket(BUCKET);
const USO_PROVA = { c1: '1ª chamada', c2: '2ª chamada', exame: 'Exame semestral', dp: 'Dependência', adp: 'Adaptação' };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const nomeSeguro = (n) => String(n || 'imagem').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'imagem';
const pastaProva = (av) => (av.tipo === 'exame' ? ['Exame semestral'] : [`${av.bimestre}º Bimestre`, `${av.chamada}ª chamada`]);
const pastaDaAvaliacao = (av) => [av.disciplina, av.semestre, ...pastaProva(av)].map(x => String(x).replace(/\//g, '-'));
const prefixoDaAvaliacao = (av) => (av.tipo === 'exame' ? 'EXAME' : `${av.bimestre}ºB ${av.chamada === 2 ? '2ª' : '1ª'}CH`);

async function base64DoStorage(caminho) {
    const [buf] = await bucket().file(caminho).download();
    return buf.toString('base64');
}

async function lerQuestoesNaOrdem(av) {
    const ids = av.questoesIds || [];
    if (!ids.length) return [];
    const docs = await db.getAll(...ids.map(id => db.collection('banco_med_questoes').doc(id)));
    return docs.filter(d => d.exists).map(d => ({ id: d.id, ...d.data() }));
}

// igual a prepararParaXml() da tela
async function prepararQuestao(q, i, prefixo = 'q') {
    const arquivos = [];
    for (const [j, im] of (q.imagens || []).entries()) {
        if (!im || !im.caminho) continue;
        arquivos.push({ nome: `${prefixo}${i + 1}-${j + 1}-${nomeSeguro(im.nome)}`, base64: await base64DoStorage(im.caminho) });
    }
    const arquivosFeedback = [];
    for (const [j, im] of (q.imagensFeedback || []).entries()) {
        if (!im || !im.caminho) continue;
        arquivosFeedback.push({ nome: `${prefixo}${i + 1}-feedback-${j + 1}-${nomeSeguro(im.nome)}`, base64: await base64DoStorage(im.caminho) });
    }
    const imgs = arquivos.map(a => `<p><img src="@@PLUGINFILE@@/${a.nome}" alt="Imagem da questão ${i + 1}"></p>`).join('\n');
    const perg = q.pergunta ? `<p><strong>${esc(q.pergunta)}</strong></p>` : '';
    const enunciadoHtml = (q.casoClinico || q.pergunta) ? [q.casoClinico, imgs, perg].filter(Boolean).join('\n') : [q.enunciadoHtml, imgs].filter(Boolean).join('\n');
    const justificativa = [q.justificativa, ...arquivosFeedback.map(a => `<p><img src="@@PLUGINFILE@@/${a.nome}" alt="Feedback da questão ${i + 1}"></p>`)].filter(Boolean).join('\n');
    // imagem antiga (campo imagem.dataUrl) só quando a questão não tem as novas
    const temAntiga = !!(q.imagem && q.imagem.dataUrl) && !(q.imagens || []).length;
    return {
        id: q.id, titulo: q.titulo, tipoMoodle: q.tipoMoodle, casoClinico: q.casoClinico || '', pergunta: q.pergunta || '', alternativas: q.alternativas || [], fonte: q.fonte || '',
        dificuldade: q.dificuldade, elaboradoPor: q.elaboradoPor || q.professorNome || '',
        enunciadoHtml, arquivos, justificativa, arquivosFeedback, provaRotulo: USO_PROVA[q.usoProva || 'c1'] || '',
        imagem: temAntiga ? { nome: `q${i + 1}-${nomeSeguro(q.imagem.nome)}`, dataUrl: q.imagem.dataUrl } : null
    };
}

// → { xml, n, pasta: [disciplina, semestre, ...], nomeArquivo }
// ids (opcional): só essas questões (ex.: a parte de um professor). O número no AVA é sempre a posição na prova,
// então partes enviadas em dias diferentes não repetem número.
async function montarXmlDaAvaliacao(av, ids = null) {
    const so = ids ? new Set(ids) : null;
    const todas = await lerQuestoesNaOrdem(av);
    const pos = new Map((av.questoesIds || []).map((id, i) => [id, i]));
    const questoes = todas.filter(q => !so || so.has(q.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id));
    const prontas = [];
    for (const q of questoes) prontas.push({ ...(await prepararQuestao(q, pos.get(q.id))), numero: pos.get(q.id) + 1 });
    const prefixo = prefixoDaAvaliacao(av);
    const pasta = pastaDaAvaliacao(av);
    const xml = gerarMoodleXml(pasta.join('/'), prontas.map(q => ({ ...q, prefixoAva: prefixo, numeroAva: q.numero })));
    const nome = `${av.sigla || av.disciplina} ${av.semestre} ${av.tipo === 'exame' ? 'exame' : `${av.bimestre}o bim ${av.chamada}a chamada`}`.replace(/[^a-zA-Z0-9._ -]/g, '_');
    return { xml, n: prontas.length, pasta, nomeArquivo: `${nome}.xml` };
}

module.exports = { montarXmlDaAvaliacao, pastaDaAvaliacao, prefixoDaAvaliacao };
