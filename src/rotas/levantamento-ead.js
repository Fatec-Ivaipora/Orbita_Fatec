const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const eadAulas = require('./ead-aulas');

// ==========================================================================
// Levantamento EaD (Docência) — 23/11/2026. Tela do setor EAD (Carlos Durlo e tutores) para as disciplinas EAD
// do semestre: curso, período, disciplina, carga horária, dia, horário e professor que dá a aula.
//
// É a MESMA lista da Aulas EAD do T.I (coleção ead_aulas_disc, rotas em ead-aulas.js → rotasDisciplinas):
// o que o EAD muda aqui aparece na hora para o T.I, e vice-versa. Cada mudança feita aqui fica em
// ead_aulas_alteracoes; o T.I vê o aviso no Órbita e na Aulas EAD e marca como visto.
//
// Além da lista:
//   - Tutor de cada curso no semestre: o coordenador EAD (ead + users.chefeDeSetor) ou o ADM define.
//   - Relatório por curso e por professor, com a sala Zoom que o T.I deu ao professor (link, senha e senha de
//     anfitrião) e a mensagem pronta para mandar ao professor.
//   - Cronograma EaD de cada disciplina (datas das UAs pelo calendário das UAs, o mesmo da Aulas EAD),
//     com o fechamento das trilhas e os feriados do bimestre.
// Coleções: ead_aulas_disc · ead_aulas_semestre/{semestre} (calendario, salaDoProfessor, tutorDoCurso, cronograma)
//           · ead_aulas_salas (só leitura) · ead_aulas_alteracoes
// ==========================================================================
const MODULO = 'levantamento-ead';
const checkPermission = verifyToken.requireModulePermission(MODULO);
const { COL_SALAS, COL_DISC, COL_SEM, COL_ALT, SEMESTRE, agora, quemFez, texto, chaveProf, CURSO_DA_PLANILHA } = eadAulas.comum;

const ehCoordenadorEad = (req) => ['adm_l1', 'adm_l2'].includes(req.user.role) || (req.user.role === 'ead' && req.user.chefeDeSetor === true);
const soCoordenador = (req, res) => {
    if (ehCoordenadorEad(req)) return true;
    res.status(403).json({ error: 'Só o coordenador do EAD define isso.' }); return false;
};

async function registrar(req, alt) {
    await db.collection(COL_ALT).add({
        ...alt, origem: 'levantamento-ead', por: quemFez(req), porUid: req.user.uid, porRole: req.user.role, em: agora(), vistoPor: []
    });
}

// importar planilha, nova disciplina, editar, excluir (excluir só se o T.I ainda não marcou gravação)
eadAulas.rotasDisciplinas(router, checkPermission, { registrar, protegerGravacoes: true });

// Tutores do EAD (cargo ead, ativos) — pra escolher o tutor de cada curso
async function tutores() {
    const snap = await db.collection('users').where('role', '==', 'ead').get();
    return snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.ativo !== false)
        .map(u => ({ uid: u.uid, nome: u.name || u.email || '', coordenador: u.chefeDeSetor === true }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

// GET /?semestre= — disciplinas, sala Zoom de cada professor, tutores dos cursos, calendário e cronograma
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const semestre = req.query.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const [discSnap, salasSnap, cfgSnap, listaTutores] = await Promise.all([
            db.collection(COL_DISC).where('semestre', '==', semestre).get(),
            db.collection(COL_SALAS).get(),
            db.collection(COL_SEM).doc(semestre).get(),
            tutores()
        ]);
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        const salas = new Map(salasSnap.docs.map(d => [d.id, d.data()]));
        // sala de cada professor (chave = nome do professor normalizado, igual à Aulas EAD)
        const salaDoProfessor = {};
        Object.entries(cfg.salaDoProfessor || {}).forEach(([k, v]) => {
            const s = v && salas.get(v.salaId);
            if (s) salaDoProfessor[k] = { conta: s.conta || '', nome: s.nome || '', link: s.link || '', senha: s.senha || '', senhaAnfitriao: s.senhaAnfitriao || '' };
        });
        const disciplinas = discSnap.docs.map(d => {
            const x = d.data();
            const g = x.gravacoes || {};
            // 24/11/2026: data da UA ajustada pelo EAD (duas UAs no mesmo dia, reposição) — campo datasUa
            const datasManuais = {};
            Object.entries(x.datasUa || {}).forEach(([item, v]) => { if (v && v.data) datasManuais[item] = v.data; });
            return {
                id: d.id, cursoId: x.cursoId, cursoNome: x.cursoNome, periodo: x.periodo || '', nome: x.nome, ch: x.ch || null, qtd: x.qtd || ((Number(x.ch) || 0) >= 60 ? 12 : 6),
                dia: x.dia || '', horario: x.horario || '', professor: x.professor || '', obs: x.obs || '',
                temGravacao: Object.values(g).some(v => v && (v.gravou || v.baixou || v.youtube || v.ava)),
                datasManuais, updatedAt: x.updatedAt || x.createdAt || '', updatedBy: x.updatedBy || x.createdBy || ''
            };
        }).sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR') || String(a.periodo).localeCompare(String(b.periodo), 'pt-BR', { numeric: true }) || a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json({
            semestre, disciplinas, salaDoProfessor,
            cursos: CURSO_DA_PLANILHA.map(c => ({ id: c[1], nome: c[2] })),
            tutores: listaTutores,
            tutorDoCurso: cfg.tutorDoCurso || {},
            calendario: cfg.calendario || { inicio1: '', inicio2: '', semAula: [] },
            cronograma: cfg.cronograma || { fechamento: {}, feriados: {} },
            podeDefinirTutor: ehCoordenadorEad(req)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /semestre/:semestre/tutor { cursoId, uid } — uid vazio tira o tutor do curso
router.put('/semestre/:semestre/tutor', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soCoordenador(req, res)) return;
        const semestre = req.params.semestre;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const { cursoId, uid } = req.body || {};
        if (!CURSO_DA_PLANILHA.some(c => c[1] === cursoId)) return res.status(400).json({ error: 'Curso inválido.' });
        const ref = db.collection(COL_SEM).doc(semestre);
        const snap = await ref.get();
        const mapa = { ...((snap.exists && snap.data().tutorDoCurso) || {}) };
        if (uid) {
            const t = (await tutores()).find(x => x.uid === uid);
            if (!t) return res.status(400).json({ error: 'Escolha um tutor do EAD.' });
            mapa[cursoId] = { uid: t.uid, nome: t.nome, em: agora(), por: quemFez(req) };
        } else delete mapa[cursoId];
        await ref.set({ semestre }, { merge: true });
        await ref.update({ tutorDoCurso: mapa });
        res.json({ tutorDoCurso: mapa });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// PUT /semestre/:semestre/calendario { inicio1, inicio2, semAula:[{data, nome}], fechamento:{1:{data,hora},2:{data,hora}} }
// O início dos bimestres e os dias sem aula são os MESMOS da Aulas EAD (calendario); o nome do feriado e o
// fechamento das trilhas ficam em `cronograma` (a Aulas EAD regrava `calendario` inteiro, então o que é só do
// cronograma fica fora dele). Mudança no calendário avisa o T.I (muda as datas das UAs).
router.put('/semestre/:semestre/calendario', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soCoordenador(req, res)) return;
        const semestre = req.params.semestre;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
        const anoRuim = [b => b.inicio1, b => b.inicio2, b => ((b.fechamento || {})[1] || {}).data, b => ((b.fechamento || {})[2] || {}).data, ...(Array.isArray((req.body || {}).semAula) ? req.body.semAula : []).map(x => () => x && x.data)]
            .map(f => data(f(req.body || {}))).find(x => x && (x < '2020-01-01' || x > '2099-12-31'));
        if (anoRuim) return res.status(400).json({ error: `Data com ano errado: ${anoRuim.split('-').reverse().join('/')}. Confira o ano (4 dígitos).` });
        const hora = (v) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : '');
        const b = req.body || {};
        const sem = (Array.isArray(b.semAula) ? b.semAula : []).map(x => ({ data: data(x && x.data), nome: texto(x && x.nome, 80) })).filter(x => x.data);
        const calendario = { inicio1: data(b.inicio1), inicio2: data(b.inicio2), semAula: [...new Set(sem.map(x => x.data))].sort() };
        if (!calendario.inicio1) return res.status(400).json({ error: 'Informe o início do 1º bimestre.' });
        if (calendario.inicio2 && calendario.inicio2 <= calendario.inicio1) return res.status(400).json({ error: 'O 2º bimestre começa depois do 1º.' });
        const feriados = {};
        sem.forEach(x => { if (x.nome) feriados[x.data] = x.nome; });
        const fechamento = {};
        [1, 2].forEach(n => { const f = (b.fechamento || {})[n] || {}; if (data(f.data)) fechamento[n] = { data: data(f.data), hora: hora(f.hora) }; });
        const ref = db.collection(COL_SEM).doc(semestre);
        const antes = (await ref.get()).data() || {};
        await ref.set({ semestre }, { merge: true });
        await ref.update({ calendario, cronograma: { fechamento, feriados }, updatedAt: agora(), updatedBy: quemFez(req) });
        const a = antes.calendario || {};
        const mudancas = ['inicio1', 'inicio2'].filter(k => (a[k] || '') !== calendario[k]).map(k => ({ campo: k, de: a[k] || '', para: calendario[k] }));
        if ((a.semAula || []).join(',') !== calendario.semAula.join(',')) mudancas.push({ campo: 'semAula', de: (a.semAula || []).join(', '), para: calendario.semAula.join(', ') });
        if (mudancas.length) {
            try { await registrar(req, { semestre, acao: 'calendario', disciplina: 'Calendário das UAs', mudancas }); }
            catch (e) { console.error('levantamento-ead: registro do calendário falhou', e); }
        }
        res.json({ calendario, cronograma: { fechamento, feriados } });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// PUT /disciplinas/:id/data-ua { item: 'UA-03' | 'REV-1', data: 'AAAA-MM-DD' | '' (volta ao calendário) } — 24/11/2026
// O EAD (Carlos) define a data de uma UA quando foge do calendário: duas UAs no mesmo dia, reposição. Vale no
// cronograma e na Aulas EAD do T.I (que só acompanha). Fica registrado como mudança (aviso pro T.I depois do início).
router.put('/disciplinas/:id/data-ua', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_DISC).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        const x = snap.data();
        const { item } = req.body || {};
        const data = String((req.body || {}).data || '');
        const qtd = x.qtd || ((Number(x.ch) || 0) >= 60 ? 12 : 6);
        const def = eadAulas._interno.itensGravacao(qtd).find(i => i.id === item);
        if (!def) return res.status(400).json({ error: 'Unidade inválida.' });
        if (data && !/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ error: 'Data inválida.' });
        if (data && (data < '2020-01-01' || data > '2099-12-31')) return res.status(400).json({ error: `Data com ano errado: ${data.split('-').reverse().join('/')}. Confira o ano (4 dígitos).` });
        const datasUa = { ...(x.datasUa || {}) };
        const antes = (datasUa[item] && datasUa[item].data) || '';
        if (antes === data) return res.json({ datasUa });
        if (data) datasUa[item] = { data, em: agora(), por: quemFez(req) }; else delete datasUa[item];
        await ref.update({ datasUa, updatedAt: agora(), updatedBy: quemFez(req) });
        await registrar(req, { semestre: x.semestre, acao: 'alterada', discId: snap.id, curso: x.cursoNome, periodo: x.periodo, disciplina: x.nome,
            mudancas: [{ campo: `data da ${def.rotulo || item}`, de: antes || 'pelo calendário', para: data || 'pelo calendário' }] }).catch(e => console.error('levantamento-ead: registro falhou', e));
        res.json({ datasUa });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// POST /datas-ua/lote { semestre, ajustes: [{ discId, item, data }] } — 24/11/2026
// Mesma mudança de data em várias disciplinas de uma vez (ex.: toda a quarta 10/03 passa pra 11/03). A tela escolhe
// quais (todas as do dia ou só uma); aqui confere cada uma e grava. Um registro só de mudança, com a lista.
router.post('/datas-ua/lote', verifyToken, checkPermission, async (req, res) => {
    try {
        const { semestre } = req.body || {};
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const ajustes = (Array.isArray(req.body.ajustes) ? req.body.ajustes : []).slice(0, 400);
        if (!ajustes.length) return res.status(400).json({ error: 'Nada para ajustar.' });
        for (const a of ajustes) {
            const data = String((a && a.data) || '');
            if (data && (!/^\d{4}-\d{2}-\d{2}$/.test(data) || data < '2020-01-01' || data > '2099-12-31')) return res.status(400).json({ error: `Data inválida: ${data}. Confira o ano (4 dígitos).` });
        }
        const ids = [...new Set(ajustes.map(a => String(a.discId || '')))].filter(Boolean);
        const snaps = await Promise.all(ids.map(id => db.collection(COL_DISC).doc(id).get()));
        const porId = new Map(snaps.filter(s => s.exists && s.data().semestre === semestre).map(s => [s.id, s]));
        const novos = new Map(), itens = [];
        for (const a of ajustes) {
            const s = porId.get(String(a.discId));
            if (!s) continue;
            const x = s.data();
            const def = eadAulas._interno.itensGravacao(x.qtd || ((Number(x.ch) || 0) >= 60 ? 12 : 6)).find(i => i.id === a.item);
            if (!def) continue;
            const datasUa = novos.get(s.id) || { ...(x.datasUa || {}) };
            const antes = (datasUa[a.item] && datasUa[a.item].data) || '';
            const data = String(a.data || '');
            if (antes === data) continue;
            if (data) datasUa[a.item] = { data, em: agora(), por: quemFez(req) }; else delete datasUa[a.item];
            novos.set(s.id, datasUa);
            itens.push({ discId: s.id, curso: x.cursoNome, periodo: x.periodo, disciplina: x.nome, acao: 'alterada', mudancas: [{ campo: `data da ${def.rotulo}`, de: antes || 'pelo calendário', para: data || 'pelo calendário' }] });
        }
        if (!novos.size) return res.json({ alteradas: 0, datasUa: {}, message: 'Nada mudou.' });
        const batch = db.batch();
        novos.forEach((datasUa, id) => batch.update(db.collection(COL_DISC).doc(id), { datasUa, updatedAt: agora(), updatedBy: quemFez(req) }));
        await batch.commit();
        await registrar(req, itens.length === 1
            ? { semestre, ...itens[0] }
            : { semestre, acao: 'importacao', disciplina: `Data de UA ajustada em ${novos.size} disciplina(s)`, itens }).catch(e => console.error('levantamento-ead: registro falhou', e));
        res.json({ alteradas: novos.size, datasUa: Object.fromEntries(novos), message: `Data ajustada em ${novos.size} disciplina(s).` });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ------------------------------ Matrizes (coordenação) e nomes do Edubox — 23/11/2026 ------------------------------
// O coordenador de cada curso define professor, dia e hora de cada disciplina no Matrizes e Horários
// (matrizes_grade). Aqui o EAD vê o que a coordenação definiu para as disciplinas EAD e pode ACEITAR (preenche o
// formulário; quem salva é a pessoa). O nome do professor é conferido com o cadastro do Edubox (relay, o mesmo da
// titulação do Matrizes): "Luiz Fernando" → "Luiz Fernando Camargo".
const mz = require('./matrizes')._interno;
const DIA_MATRIZ = { seg: 'segunda', ter: 'terca', qua: 'quarta', qui: 'quinta', sex: 'sexta', sab: 'sabado' };
const horaTxt = (h) => { const [hh, mm] = String(h || '').split(':'); return !hh ? '' : (mm && mm !== '00' ? `${Number(hh)}h${mm}min` : `${Number(hh)}h`); };
const MINUSC = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
const nomeProprio = (s) => String(s || '').toLowerCase().split(/\s+/).filter(Boolean).map((w, i) => (i && MINUSC.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
// períodos de uma disciplina EAD ("6", "3 e 4", "1º e 2º"); sem número = todos ("TODOS")
const periodosDe = (p) => (String(p || '').match(/\d+/g) || []).map(Number);

// grafia "solta": Z→S, Y→I, PH→F, TH→T, letra dobrada → uma (só se o nome exato não achar)
const solto = (s) => mz.normNome(s).replace(/PH/g, 'F').replace(/TH/g, 'T').replace(/Z/g, 'S').replace(/Y/g, 'I').replace(/([A-Z])\1+/g, '$1');
async function professoresEdubox(semestre) {
    const lista = await mz.titulacoesEdubox(semestre); // [] se o Edubox não responder
    return lista.map(t => ({ ...t, toks: mz.normNome(t.nome).split(' '), toksSoltos: solto(t.nome).split(' ') }));
}
// nome digitado → { nome } (do Edubox, com maiúscula só no começo) | { status: 'nao-achou' | 'ambiguo' } | null (a contratar / vazio)
function nomeNoEdubox(lista, nome) {
    if (!lista.length || mz.ehContratar(nome)) return null;
    const limpo = String(nome).replace(/\(.*?\)/g, ' ');
    let a = mz.acharProfessor(lista, limpo);
    if (!a) {
        const b = mz.acharProfessor(lista.map(t => ({ ...t, toks: t.toksSoltos })), solto(limpo));
        if (b && !b.ambiguo) a = lista.find(t => t.nome === b.nome) || b;
        else if (b) a = b;
    }
    if (!a) return { status: 'nao-achou' };
    if (a.ambiguo) return { status: 'ambiguo' };
    return { nome: nomeProprio(a.nome) };
}

// GET /sugestoes?semestre= → { sugestoes: { discId: [{ dia, horario, professor, coordenador, em, turmas }] },
//                              professores: { "nome no levantamento": { nome } | { status } | null }, eduboxOk }
router.get('/sugestoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const semestre = req.query.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const [discSnap, gradeSnap, profs] = await Promise.all([
            db.collection(COL_DISC).where('semestre', '==', semestre).get(),
            db.collection('matrizes_grade').where('semestre', '==', semestre).get(),
            professoresEdubox(semestre)
        ]);
        const porCursoDisc = new Map(); // cursoId|NOME → [alocação]
        gradeSnap.docs.forEach(g => {
            const x = g.data();
            const cursoId = x.cursoId || g.id.split('__')[1];
            Object.values(x.alocacoes || {}).forEach(a => {
                const k = `${cursoId}|${mz.normNome(a.disciplina)}`;
                if (!porCursoDisc.has(k)) porCursoDisc.set(k, []);
                porCursoDisc.get(k).push(a);
            });
        });
        const cacheNome = new Map();
        const oficial = (nome) => { const k = mz.normNome(nome); if (!cacheNome.has(k)) cacheNome.set(k, nomeNoEdubox(profs, nome)); return cacheNome.get(k); };
        const sugestoes = {}, professores = {};
        discSnap.docs.forEach(d => {
            const x = d.data();
            if (x.professor && !(x.professor in professores)) professores[x.professor] = oficial(x.professor);
            const pers = periodosDe(x.periodo);
            const alocs = (porCursoDisc.get(`${x.cursoId}|${mz.normNome(x.nome)}`) || []).filter(a => !pers.length || pers.includes(Number(a.periodo)));
            const grupos = new Map();
            alocs.forEach(a => (a.aulas || []).forEach(au => {
                const ofi = oficial(au.professor);
                const professor = (ofi && ofi.nome) || String(au.professor || '').trim();
                const s = { dia: DIA_MATRIZ[au.dia] || '', horario: au.inicio && au.fim ? `${horaTxt(au.inicio)} - ${horaTxt(au.fim)}` : '', professor };
                const k = `${s.dia}|${s.horario}|${mz.normNome(s.professor)}`;
                if (!grupos.has(k)) grupos.set(k, { ...s, coordenador: (a.atualizadoPor && a.atualizadoPor.nome) || '', em: a.atualizadoEm || '', turmas: [] });
                const gr = grupos.get(k);
                if (a.turma && !gr.turmas.includes(a.turma)) gr.turmas.push(a.turma);
                if ((a.atualizadoEm || '') > gr.em) { gr.em = a.atualizadoEm; gr.coordenador = (a.atualizadoPor && a.atualizadoPor.nome) || gr.coordenador; }
            }));
            if (grupos.size) sugestoes[d.id] = [...grupos.values()];
        });
        res.json({ sugestoes, professores, eduboxOk: profs.length > 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /professores/renomear { semestre, trocas: [{ de, para }] } — corrige o nome do professor em todas as disciplinas
// EAD do semestre e leva junto a sala Zoom que o T.I deu (a sala é guardada pelo nome do professor).
router.post('/professores/renomear', verifyToken, checkPermission, async (req, res) => {
    try {
        const { semestre } = req.body || {};
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const trocas = (Array.isArray(req.body.trocas) ? req.body.trocas : []).slice(0, 200)
            .map(t => ({ de: texto(t && t.de, 120), para: texto(t && t.para, 120) })).filter(t => t.de && t.para && t.de !== t.para);
        if (!trocas.length) return res.status(400).json({ error: 'Nada para corrigir.' });
        const [discSnap, semSnap] = await Promise.all([db.collection(COL_DISC).where('semestre', '==', semestre).get(), db.collection(COL_SEM).doc(semestre).get()]);
        const salas = { ...((semSnap.exists && semSnap.data().salaDoProfessor) || {}) };
        let mudouSala = false, n = 0;
        const itens = [], avisosSala = [];
        const batch = db.batch();
        const qtd = (nome) => discSnap.docs.filter(d => d.data().professor === nome).length;
        trocas.forEach(t => {
            discSnap.docs.filter(d => d.data().professor === t.de).forEach(d => {
                const x = d.data();
                batch.update(d.ref, { professor: t.para, updatedAt: agora(), updatedBy: quemFez(req) });
                itens.push({ discId: d.id, curso: x.cursoNome, periodo: x.periodo, disciplina: x.nome, acao: 'alterada', mudancas: [{ campo: 'professor', de: t.de, para: t.para }] });
                n++;
            });
        });
        const paras = [...new Set(trocas.map(t => t.para))];
        paras.forEach(para => {
            const kPara = chaveProf(para);
            const des = trocas.filter(t => t.para === para && chaveProf(t.de) !== kPara).map(t => t.de);
            const comSala = des.filter(de => salas[chaveProf(de)]).sort((a, b) => qtd(b) - qtd(a));
            const fica = salas[kPara] || (comSala[0] ? salas[chaveProf(comSala[0])] : null);
            if (fica) {
                const outras = [...new Set(comSala.map(de => salas[chaveProf(de)].salaId).filter(id => id !== fica.salaId))];
                if (outras.length) avisosSala.push(para);
                salas[kPara] = { ...fica, professor: para };
            }
            des.forEach(de => { if (salas[chaveProf(de)]) { delete salas[chaveProf(de)]; mudouSala = true; } });
            if (fica) mudouSala = true;
        });
        if (!n) return res.status(400).json({ error: 'Nenhuma disciplina com esses nomes.' });
        if (mudouSala) batch.update(db.collection(COL_SEM).doc(semestre), { salaDoProfessor: salas }); // update troca o mapa inteiro (tira os nomes antigos)
        await batch.commit();
        await registrar(req, { semestre, acao: 'importacao', disciplina: `Nome de professor corrigido pelo Edubox em ${n} disciplina(s)`, itens: itens.slice(0, 200) }).catch(e => console.error('levantamento-ead: registro falhou', e));
        res.json({ alteradas: n, avisosSala, message: `Nome corrigido em ${n} disciplina(s).${avisosSala.length ? ` ${avisosSala.join(', ')} tinha(m) mais de uma sala Zoom: ficou uma só (a mesma em todos os dias). Avise o T.I.` : ''}` });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
module.exports._interno = { chaveProf };
