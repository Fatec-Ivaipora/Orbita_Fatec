// ================================================================
//  CALENDÁRIO ACADÊMICO (Docência, 23/11/2026)
//  O diretor acadêmico (Roni) e a ajudante dele (Thalia) montam o calendário do semestre no Órbita:
//  copiam um semestre anterior (carregado do Edubox por scripts/calendario-academico-importar.js) e só
//  ajustam. Ao PUBLICAR, os eventos aparecem na Agenda Interna (lidos na hora: editou aqui, muda lá) e no
//  site novo (GET /api/publico/calendario-academico, sem login, só o que está marcado "site").
//  Acesso: SÓ os usuários de USUARIOS_PERMITIDOS (nem outros ADM N1) — igual ao Financeiro Medicina.
// ================================================================
const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const C = require('../utils/calendarioAcademico');

const USUARIOS_PERMITIDOS = [
    'M5GxyogXA9d6aAIBOaKmU9Pjkwk1', // Roni — diretor acadêmico
    'WmDuym3nSRemrNVMZFrNvd8232I2', // Thalia — ajudante do diretor
    'rhQ6fe4HQfMOCCejry1sPx0hA1v1', // Paulo Henrique (TI / suporte)
    'rSw36LAa8fPI94aYFoVv7JggB6w2'  // Administrador (ADM geral)
];
const somentePermitidos = (req, res, next) => (USUARIOS_PERMITIDOS.includes(req.user && req.user.uid)
    ? next() : res.status(403).json({ error: 'O Calendário Acadêmico é restrito à Direção Acadêmica.' }));
const acesso = [verifyToken, somentePermitidos];

const COL_S = 'calendario_academico_semestres';
const COL_E = 'calendario_academico_eventos';
const SEMESTRE = /^\d{4}\.[12]$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const idSemestre = (semestre, calendario) => `${semestre}__${calendario}`;
const quemFez = (req) => req.user.name || req.user.email || req.user.uid;
const texto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
function erro(res, e) { console.error('[calendario-academico]', e); res.status(e.status || 500).json({ error: e.message || 'Erro no Calendário Acadêmico.' }); }
function falha(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
function validarSemCal(semestre, calendario) {
    if (!SEMESTRE.test(String(semestre || ''))) throw falha('Semestre inválido (ex.: 2027.1).');
    if (!C.CALENDARIOS[calendario]) throw falha('Calendário inválido (graduação ou medicina).');
}
function camposEvento(b) {
    const inicio = String(b.inicio || '').slice(0, 10), fim = String(b.fim || b.inicio || '').slice(0, 10);
    const titulo = texto(b.titulo, 160);
    if (!titulo) throw falha('Informe o nome do evento.');
    if (!DATA.test(inicio)) throw falha('Informe a data de início.');
    if (!DATA.test(fim) || fim < inicio) throw falha('A data de fim precisa ser igual ou depois do início.');
    const tipo = C.TIPOS[b.tipo] ? b.tipo : C.classificar(titulo, b.complemento);
    return { titulo, complemento: texto(b.complemento, 200), inicio, fim, tipo, naAgenda: b.naAgenda !== false, noSite: b.noSite !== undefined ? b.noSite !== false : C.TIPOS[tipo].site, observacao: texto(b.observacao, 500) };
}
async function lerSemestre(semestre, calendario) {
    const s = await db.collection(COL_S).doc(idSemestre(semestre, calendario)).get();
    return s.exists ? { id: s.id, ...s.data() } : null;
}
async function eventosDe(semestre, calendario) {
    const snap = await db.collection(COL_E).where('semestre', '==', semestre).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => e.calendario === calendario)
        .sort((a, b) => a.inicio.localeCompare(b.inicio) || a.titulo.localeCompare(b.titulo));
}
const comAvisos = (lista, sem) => lista.map(e => ({ ...e, avisos: C.avisos(e, lista, sem || {}) }));

// ---------- semestres ----------
router.get('/semestres', acesso, async (req, res) => {
    try {
        const [s, e] = await Promise.all([db.collection(COL_S).get(), db.collection(COL_E).select('semestre', 'calendario').get()]);
        const qtd = {}; e.docs.forEach(d => { const k = idSemestre(d.data().semestre, d.data().calendario); qtd[k] = (qtd[k] || 0) + 1; });
        res.json({ semestres: s.docs.map(d => ({ id: d.id, ...d.data(), eventos: qtd[d.id] || 0 })).sort((a, b) => b.semestre.localeCompare(a.semestre) || a.calendario.localeCompare(b.calendario)), tipos: C.TIPOS, calendarios: C.CALENDARIOS });
    } catch (e) { erro(res, e); }
});

router.get('/eventos', acesso, async (req, res) => {
    try {
        const { semestre, calendario } = req.query; validarSemCal(semestre, calendario);
        const sem = await lerSemestre(semestre, calendario);
        res.json({ semestre: sem, eventos: comAvisos(await eventosDe(semestre, calendario), sem) });
    } catch (e) { erro(res, e); }
});

// Copiar um semestre para outro (o novo começa no "Início do semestre letivo" informado)
router.post('/copiar', acesso, async (req, res) => {
    try {
        const { de, para, calendario, inicioNovo, substituir } = req.body || {};
        validarSemCal(de, calendario); validarSemCal(para, calendario);
        if (de === para) throw falha('Escolha semestres diferentes.');
        if (!DATA.test(String(inicioNovo || ''))) throw falha('Informe a data de início do semestre letivo novo.');
        const base = await lerSemestre(de, calendario);
        const eventosBase = await eventosDe(de, calendario);
        if (!eventosBase.length) throw falha(`O semestre ${de} não tem eventos para copiar.`);
        const inicioBase = (base && base.inicio) || (eventosBase.find(e => /INICIO DO SEMESTRE LETIVO/.test(C.sem(e.titulo))) || eventosBase[0]).inicio;
        const atuais = await eventosDe(para, calendario);
        if (atuais.length && !substituir) throw falha(`O semestre ${para} já tem ${atuais.length} evento(s). Marque "substituir" para apagar e copiar de novo.`, 409);
        const idx = (s) => Number(s.slice(0, 4)) * 2 + Number(s.slice(-1)) - 1;
        const novos = C.copiarEventos(eventosBase, { inicioBase, inicioNovo, anoNovo: Number(para.slice(0, 4)), semestresAFrente: idx(para) - idx(de) });
        const agora = new Date().toISOString(), quem = quemFez(req);
        const destino = await lerSemestre(para, calendario);
        const publicado = !!(destino && destino.status === 'publicado');
        const fimNovo = base && base.fim ? C.somaDias(base.fim, C.diasEntre(inicioBase, inicioNovo) - (C.diasEntre(inicioBase, inicioNovo) % 7)) : null;
        // lotes de até 400 gravações
        const ops = [];
        atuais.forEach(e => ops.push(b => b.delete(db.collection(COL_E).doc(e.id))));
        novos.forEach(e => { const ref = db.collection(COL_E).doc(); ops.push(b => b.set(ref, {
            semestre: para, calendario, titulo: e.titulo, complemento: e.complemento || '', inicio: e.inicio, fim: e.fim, tipo: e.tipo,
            naAgenda: e.naAgenda !== false, noSite: e.noSite !== false, observacao: e.observacao || '', publicado,
            conferir: true, regraCopia: e.regraCopia, origem: `cópia de ${de}`, criadoEm: agora, criadoPor: quem, atualizadoEm: agora, atualizadoPor: quem
        })); });
        for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
        await db.collection(COL_S).doc(idSemestre(para, calendario)).set({
            semestre: para, calendario, status: publicado ? 'publicado' : 'rascunho', inicio: inicioNovo, fim: fimNovo,
            copiadoDe: de, atualizadoEm: agora, atualizadoPor: quem, ...(destino ? {} : { criadoEm: agora, criadoPor: quem })
        }, { merge: true });
        res.json({ message: `${novos.length} eventos copiados de ${de} para ${para}. Confira as datas marcadas.`, copiados: novos.length });
    } catch (e) { erro(res, e); }
});

// Datas do semestre e publicar / voltar para rascunho
router.put('/semestres/:id', acesso, async (req, res) => {
    try {
        const [semestre, calendario] = String(req.params.id).split('__'); validarSemCal(semestre, calendario);
        const atual = await lerSemestre(semestre, calendario);
        const b = req.body || {};
        const upd = { semestre, calendario, atualizadoEm: new Date().toISOString(), atualizadoPor: quemFez(req) };
        if (b.inicio !== undefined) { if (b.inicio && !DATA.test(b.inicio)) throw falha('Data de início inválida.'); upd.inicio = b.inicio || null; }
        if (b.fim !== undefined) { if (b.fim && !DATA.test(b.fim)) throw falha('Data de fim inválida.'); upd.fim = b.fim || null; }
        // dias letivos: primeiro e último dia (vazio = automático) e meta do semestre
        for (const k of ['letivoDe', 'letivoAte']) if (b[k] !== undefined) { if (b[k] && !DATA.test(b[k])) throw falha('Data inválida.'); upd[k] = b[k] || null; }
        if (b.metaDias !== undefined) { const n = Number(b.metaDias); upd.metaDias = Number.isFinite(n) && n > 0 ? Math.round(n) : null; }
        let msg = 'Semestre atualizado.';
        if (b.status === 'publicado' || b.status === 'rascunho') {
            upd.status = b.status;
            if (b.status === 'publicado') { upd.publicadoEm = upd.atualizadoEm; upd.publicadoPor = upd.atualizadoPor; }
            const evs = await eventosDe(semestre, calendario);
            for (let i = 0; i < evs.length; i += 400) { const lote = db.batch(); evs.slice(i, i + 400).forEach(e => lote.update(db.collection(COL_E).doc(e.id), { publicado: b.status === 'publicado' })); await lote.commit(); }
            msg = b.status === 'publicado' ? `Publicado: ${evs.length} evento(s) já aparecem na Agenda Interna e no site.` : 'Voltou para rascunho: saiu da Agenda Interna e do site.';
        }
        await db.collection(COL_S).doc(idSemestre(semestre, calendario)).set({ ...(atual ? {} : { criadoEm: upd.atualizadoEm, criadoPor: upd.atualizadoPor, status: 'rascunho' }), ...upd }, { merge: true });
        res.json({ message: msg });
    } catch (e) { erro(res, e); }
});

// ---------- dias letivos (planilha "DIAS LETIVOS" da Direção): ano inteiro, os dois semestres ----------
router.get('/dias-letivos', acesso, async (req, res) => {
    try {
        const ano = Number(req.query.ano), calendario = req.query.calendario;
        if (!(ano >= 2020 && ano <= 2100)) throw falha('Ano inválido.');
        if (!C.CALENDARIOS[calendario]) throw falha('Calendário inválido.');
        const semestresAno = [`${ano}.1`, `${ano}.2`];
        const out = [];
        for (const s of semestresAno) {
            const sem = await lerSemestre(s, calendario);
            const evs = await eventosDe(s, calendario);
            if (!sem && !evs.length) { out.push({ semestre: s, existe: false }); continue; }
            const auto = C.limitesLetivos(evs);
            const de = (sem && sem.letivoDe) || auto.de, ate = (sem && sem.letivoAte) || auto.ate;
            out.push({ semestre: s, existe: true, id: idSemestre(s, calendario), status: sem && sem.status, auto, manual: { de: (sem && sem.letivoDe) || null, ate: (sem && sem.letivoAte) || null }, meta: (sem && sem.metaDias) || 120, ...C.diasLetivos(evs, de, ate) });
        }
        res.json({ ano, calendario, semestres: out });
    } catch (e) { erro(res, e); }
});

// ---------- eventos ----------
router.post('/eventos', acesso, async (req, res) => {
    try {
        const { semestre, calendario } = req.body || {}; validarSemCal(semestre, calendario);
        const c = camposEvento(req.body || {});
        const sem = await lerSemestre(semestre, calendario);
        const agora = new Date().toISOString(), quem = quemFez(req);
        if (!sem) await db.collection(COL_S).doc(idSemestre(semestre, calendario)).set({ semestre, calendario, status: 'rascunho', criadoEm: agora, criadoPor: quem, atualizadoEm: agora, atualizadoPor: quem });
        const ref = await db.collection(COL_E).add({ semestre, calendario, ...c, publicado: !!(sem && sem.status === 'publicado'), conferir: false, origem: 'manual', criadoEm: agora, criadoPor: quem, atualizadoEm: agora, atualizadoPor: quem });
        res.status(201).json({ id: ref.id, message: 'Evento incluído.' });
    } catch (e) { erro(res, e); }
});

router.put('/eventos/:id', acesso, async (req, res) => {
    try {
        const ref = db.collection(COL_E).doc(req.params.id);
        const s = await ref.get(); if (!s.exists) throw falha('Evento não encontrado.', 404);
        const b = req.body || {};
        // só "conferido" (tira o aviso da cópia) sem mexer no resto
        const upd = b.soConferir ? { conferir: false } : { ...camposEvento({ ...s.data(), ...b }), conferir: false };
        await ref.update({ ...upd, atualizadoEm: new Date().toISOString(), atualizadoPor: quemFez(req) });
        res.json({ message: b.soConferir ? 'Marcado como conferido.' : 'Evento salvo.' });
    } catch (e) { erro(res, e); }
});

router.delete('/eventos/:id', acesso, async (req, res) => {
    try {
        const ref = db.collection(COL_E).doc(req.params.id);
        if (!(await ref.get()).exists) throw falha('Evento não encontrado.', 404);
        await ref.delete();
        res.json({ message: 'Evento excluído.' });
    } catch (e) { erro(res, e); }
});

// ---------- leitura pública (site novo) e da Agenda Interna ----------
const semestresDoPeriodo = (de, ate) => {
    const out = new Set();
    for (const d of [de, ate]) { const [a, m] = d.split('-').map(Number); out.add(`${a}.${m <= 6 ? 1 : 2}`); }
    // eventos do fim do semestre podem estar no do lado
    [...out].forEach(s => { const [a, n] = s.split('.').map(Number); out.add(n === 1 ? `${a - 1}.2` : `${a}.1`); out.add(n === 1 ? `${a}.2` : `${a + 1}.1`); });
    return [...out];
};
async function eventosPublicados({ semestres, de, ate, calendario, site }) {
    const snap = await db.collection(COL_E).where('semestre', 'in', semestres.slice(0, 10)).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(e => e.publicado === true && (!calendario || e.calendario === calendario) && (site ? e.noSite !== false : e.naAgenda !== false))
        .filter(e => (!de || e.fim >= de) && (!ate || e.inicio <= ate))
        .sort((a, b) => a.inicio.localeCompare(b.inicio));
}
// Agenda Interna: eventos publicados no intervalo (dia inteiro)
async function eventosParaAgenda(de, ate) {
    const lista = await eventosPublicados({ semestres: semestresDoPeriodo(de, ate), de, ate, site: false });
    return lista.map(e => ({ id: e.id, titulo: e.titulo, complemento: e.complemento || '', inicio: e.inicio, fim: e.fim, tipo: e.tipo, calendario: e.calendario, rotuloTipo: (C.TIPOS[e.tipo] || C.TIPOS.outro).rotulo, rotuloCalendario: C.CALENDARIOS[e.calendario] }));
}
// GET /api/publico/calendario-academico?semestre=2027.1&calendario=graduacao — sem login, qualquer site
async function publico(req, res) {
    try {
        res.set('Cache-Control', 'public, max-age=300');
        const calendario = C.CALENDARIOS[req.query.calendario] ? req.query.calendario : null;
        let semestres;
        if (SEMESTRE.test(String(req.query.semestre || ''))) semestres = [req.query.semestre];
        else { const hoje = new Date().toISOString().slice(0, 10); semestres = semestresDoPeriodo(hoje, hoje); }
        const lista = await eventosPublicados({ semestres, calendario, site: true });
        res.json({
            atualizadoEm: new Date().toISOString(), tipos: Object.fromEntries(Object.entries(C.TIPOS).map(([k, v]) => [k, v.rotulo])), calendarios: C.CALENDARIOS,
            eventos: lista.map(e => ({ titulo: C.limpa(e.titulo), complemento: C.limpa(e.complemento), inicio: e.inicio, fim: e.fim, tipo: e.tipo, calendario: e.calendario, semestre: e.semestre }))
        });
    } catch (e) { erro(res, e); }
}

module.exports = router;
module.exports.publico = publico;
module.exports._interno = { eventosParaAgenda, USUARIOS_PERMITIDOS, COL_E, COL_S };
