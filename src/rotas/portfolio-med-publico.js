// Portfólio MED — LINK DO PROFESSOR (27/11/2026), sem login: o token do link é a autorização (igual aos links das UAs do
// EAD em src/rotas/automacao-ava.js). O professor corretor vê SÓ os portfólios distribuídos para ele no semestre do link,
// corrige pela mesma matriz e envia um de cada vez. A nota de corte aparece para ele (é o ponto de partida), nunca para o
// aluno. Montado em /api/portfolio-publico (fora de /api/portfolio-med, que exige login).
const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const ava = require('../utils/ava-ws');
const { interno } = require('./portfolio-med');
const { gravarCorrecao, referenciaCobrada, lerTurma, COL_ATIV, COL_ENT, COL_TXT, COL_LINKS, falha, erro } = interno;

const TOKEN_RE = /^[A-Za-z0-9_-]{24,48}$/;
async function linkDo(token) {
    if (!TOKEN_RE.test(String(token || ''))) throw falha(404, 'Link inválido. Confira se copiou o endereço inteiro.');
    const s = await db.collection(COL_LINKS).doc(String(token)).get();
    if (!s.exists || s.data().ativo === false) throw falha(404, 'Link não encontrado ou desativado. Peça um novo à coordenação de Medicina.');
    return s.data();
}
async function entregaDoLink(l, id) {
    const s = await db.collection(COL_ENT).doc(String(id)).get();
    if (!s.exists) throw falha(404, 'Portfólio não encontrado.');
    const e = { id: s.id, ...s.data() };
    if (e.corretorUid !== l.uid) throw falha(403, 'Este portfólio não está distribuído para você.');
    const a = await db.collection(COL_ATIV).doc(e.atividadeId).get();
    if (!a.exists || a.data().semestre !== l.semestre) throw falha(404, 'Portfólio de outro semestre.');
    return { entrega: e, atividade: { id: a.id, ...a.data() } };
}
const turmaPublica = (t) => ({ turma: t.turma, periodo: t.periodo || null, semestre: t.semestre, componente: t.componente || '', tema: t.tema || '',
    questaoNorteadora: t.questaoNorteadora || '', objetivos: t.objetivos || [], instrucoes: t.instrucoes || [] });
const resumoEntrega = (e) => ({ id: e.id, nome: e.nome, status: e.status || 'pendente', nota: e.resultado ? e.resultado.nota : null, corrigidoEm: e.corrigidoEm || null, semTexto: !!e.semTexto });

// GET /:token — os portfólios do professor, por atividade
router.get('/:token', async (req, res) => {
    try {
        const l = await linkDo(req.params.token);
        const s = await db.collection(COL_ENT).where('corretorUid', '==', l.uid).get();
        const porAtiv = new Map();
        for (const d of s.docs) {
            const e = { id: d.id, ...d.data() };
            if (!porAtiv.has(e.atividadeId)) {
                const a = await db.collection(COL_ATIV).doc(e.atividadeId).get();
                if (!a.exists || a.data().semestre !== l.semestre) { porAtiv.set(e.atividadeId, null); continue; }
                const t = await lerTurma(a.data().turmaId);
                porAtiv.set(e.atividadeId, { id: a.id, titulo: a.data().titulo, valorDisciplina: a.data().valorDisciplina || 3, turma: t.turma, periodo: t.periodo || null, tema: t.tema || '', entregas: [] });
            }
            const g = porAtiv.get(e.atividadeId);
            if (g) g.entregas.push(resumoEntrega(e));
        }
        const atividades = [...porAtiv.values()].filter(Boolean).map(g => ({ ...g, entregas: g.entregas.sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR')) }))
            .sort((x, y) => String(x.turma).localeCompare(String(y.turma)) || x.titulo.localeCompare(y.titulo));
        res.json({ professor: l.nome, semestre: l.semestre, atividades });
    } catch (e) { erro(res, e); }
});

// GET /:token/entregas/:id — tudo para corrigir: texto, matriz da turma, o que é cobrado e a nota de corte
router.get('/:token/entregas/:id', async (req, res) => {
    try {
        const l = await linkDo(req.params.token);
        const { entrega, atividade } = await entregaDoLink(l, req.params.id);
        const turma = await lerTurma(atividade.turmaId);
        const t = await db.collection(COL_TXT).doc(entrega.id).get();
        res.json({
            entrega: { ...resumoEntrega(entrega), arquivos: entrega.arquivos || [], avaArquivos: (entrega.avaArquivos || []).map(a => ({ caminho: a.caminho, nome: a.nome })),
                paginas: entrega.paginas || 0, palavras: entrega.palavras || 0, avaliacao: entrega.avaliacao || null, resultado: entrega.resultado || null,
                referencia: referenciaCobrada(entrega.referencia, (turma.objetivos || []).length, atividade.matrizCobrar || null) || null },
            atividade: { id: atividade.id, titulo: atividade.titulo, valorDisciplina: atividade.valorDisciplina || 3, matrizCobrar: atividade.matrizCobrar || null },
            turma: turmaPublica(turma),
            texto: t.exists ? t.data().texto || '' : ''
        });
    } catch (e) { erro(res, e); }
});

// GET /:token/entregas/:id/arquivo?c=<caminho> — o arquivo original que o aluno mandou no AVA
router.get('/:token/entregas/:id/arquivo', async (req, res) => {
    try {
        const l = await linkDo(req.params.token);
        const { entrega } = await entregaDoLink(l, req.params.id);
        const caminho = String(req.query.c || '');
        if (!(entrega.avaArquivos || []).some(a => a.caminho === caminho)) throw falha(404, 'Arquivo não encontrado neste portfólio.');
        const { tipo, bytes } = await ava.baixarArquivo(caminho);
        res.set('Content-Type', tipo);
        res.set('Cache-Control', 'private, no-store');
        res.send(bytes);
    } catch (e) { erro(res, e); }
});

// PUT /:token/entregas/:id { avaliacao, finalizar } — salva o rascunho ou ENVIA a correção (enviada fica travada)
router.put('/:token/entregas/:id', async (req, res) => {
    try {
        const l = await linkDo(req.params.token);
        const { entrega, atividade } = await entregaDoLink(l, req.params.id);
        if (entrega.status === 'finalizada') throw falha(409, 'Esta correção já foi enviada. Se precisar mudar, peça à coordenação de Medicina para reabrir.');
        const turma = await lerTurma(atividade.turmaId);
        const r = await gravarCorrecao(entrega, turma, req.body || {}, { nome: l.nome, uid: l.uid, via: 'link' });
        res.json({ status: r.status, nota: r.resultado.nota, message: r.status === 'finalizada' ? 'Correção enviada. Obrigado!' : 'Rascunho salvo.' });
    } catch (e) { erro(res, e); }
});

module.exports = router;
