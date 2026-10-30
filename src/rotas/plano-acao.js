const express = require('express');
const router = express.Router();
const { admin, db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// ==========================================
// PLANO DE AÇÃO DOS COORDENADORES (Docência, 21/10/2026) — pedido da Direção
// Acadêmica. As atividades do "Plano de Ação Coordenador e Administrativo"
// (diárias, semanais, mensais, bimestrais, semestrais, anuais) viram uma
// lista que o coordenador marca como feita; a Direção acompanha por
// coordenação o que foi feito e o que está atrasado.
//
// Diárias = obrigações fixas da rotina (atender aluno, recepção da noite...):
// aparecem só como referência, NÃO se marcam nem contam atraso (pedido
// 21/10/2026); no lugar, a agenda do dia traz os compromissos com data dos
// outros módulos (GET /agenda). Semanais = até sexta, mensais = até o
// último dia letivo do mês.
// Bimestrais/semestrais/anuais = prazos do calendário acadêmico do Edubox
// (scripts/plano-acao-importar.js) ou lançados pela Direção; sem prazo =
// pendência de data. A conta de "esperado x feito" é feita na tela
// (docencia/plano-acao/periodos.js) — aqui só guarda e devolve.
//
// Coleções:
//   plano_acao_atividades/{id}       catálogo (Direção edita)
//   plano_acao_semestres/{2026.2}    início/fim, dias sem aula, eventos, prazos
//   plano_acao_marcas/{uid}_{sem}_{AAAA-MM}  marcas do coordenador naquele mês:
//       marcas["{atividadeId}|{periodo}"] = { em, obs }
//   (um doc por coordenador por mês: o painel da Direção lê ~6 docs por
//   coordenador no semestre, em vez de um doc por marca)
// ==========================================
const checkPermission = verifyToken.requireModulePermission('plano-acao');
const COL_ATV = 'plano_acao_atividades';
const COL_SEM = 'plano_acao_semestres';
const COL_MARCAS = 'plano_acao_marcas';

const DIRECAO = ['adm_l1', 'adm_l2'];
const PERIODICIDADES = ['diario', 'semanal', 'mensal', 'bimestral', 'semestral', 'anual', 'a_definir'];
const RESPONSAVEIS = ['coordenador', 'administrativo', 'ambos'];

const ehDirecao = (req) => DIRECAO.includes(req.user.role);
const texto = (v, max = 200) => (v ?? '').toString().trim().slice(0, max);
const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const semestreValido = (v) => (/^\d{4}\.[12]$/.test(v || '') ? v : null);
const hojeLocal = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // Brasília
const quemFez = (req) => req.user.name || req.user.email || '';

function soDirecao(req, res) {
    if (ehDirecao(req)) return true;
    res.status(403).json({ error: 'Só a Direção Acadêmica pode fazer isso.' });
    return false;
}

// Coordenadores de curso = cargo coordenador ativo e com curso vinculado
// (fica de fora o usuário de teste e o da licitação, sem curso).
// Auxiliar de coordenação (users.auxiliarDe = uid do coordenador, 28/10/2026) tem o cargo de
// coordenador pra usar os mesmos módulos e cursos, mas não entra aqui: não recebe atividade nem plano.
async function coordenadores() {
    const snap = await db.collection('users').where('role', '==', 'coordenador').get();
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => u.ativo !== false && !u.auxiliarDe)
        .map(u => ({ uid: u.uid, nome: u.name || u.email, cursos: Array.isArray(u.cursos) && u.cursos.length ? u.cursos : (u.curso ? [u.curso] : []) }))
        .filter(u => u.cursos.length && !/teste/i.test(u.nome))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

async function atividades() {
    const snap = await db.collection(COL_ATV).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
}

function juntarMarcas(docs) {
    const marcas = {};
    docs.forEach(d => Object.assign(marcas, d.data().marcas || {}));
    return marcas;
}

// GET /semestres — semestres já carregados (do mais novo pro mais velho)
router.get('/semestres', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_SEM).select('inicio', 'fim').get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.id.localeCompare(a.id)));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /contexto?semestre= — tudo que a tela precisa pra montar a lista
router.get('/contexto', verifyToken, checkPermission, async (req, res) => {
    try {
        const sem = semestreValido(req.query.semestre);
        if (!sem) return res.status(400).json({ error: 'Escolha o semestre.' });
        const [lista, semDoc, coords] = await Promise.all([
            atividades(),
            db.collection(COL_SEM).doc(sem).get(),
            ehDirecao(req) ? coordenadores() : Promise.resolve(null)
        ]);
        res.json({
            direcao: ehDirecao(req),
            uid: req.user.uid,
            hoje: hojeLocal(),
            atividades: ehDirecao(req) ? lista : lista.filter(a => a.ativo !== false),
            semestre: semDoc.exists ? { id: semDoc.id, ...semDoc.data() } : null,
            coordenadores: coords
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /marcas?semestre=&uid= — marcas de um coordenador no semestre
// (coordenador só as dele; Direção de qualquer um)
router.get('/marcas', verifyToken, checkPermission, async (req, res) => {
    try {
        const sem = semestreValido(req.query.semestre);
        if (!sem) return res.status(400).json({ error: 'Escolha o semestre.' });
        const uid = req.query.uid || req.user.uid;
        if (uid !== req.user.uid && !ehDirecao(req)) return res.status(403).json({ error: 'Você só vê o seu plano de ação.' });
        const snap = await db.collection(COL_MARCAS).where('uid', '==', uid).where('semestre', '==', sem).get();
        res.json({ marcas: juntarMarcas(snap.docs) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /painel?semestre= — marcas de todos os coordenadores (Direção)
router.get('/painel', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const sem = semestreValido(req.query.semestre);
        if (!sem) return res.status(400).json({ error: 'Escolha o semestre.' });
        const snap = await db.collection(COL_MARCAS).where('semestre', '==', sem).get();
        const porUid = {};
        snap.docs.forEach(d => { const { uid } = d.data(); porUid[uid] = Object.assign(porUid[uid] || {}, d.data().marcas || {}); });
        res.json({ porUid });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /marcas { semestre, atividadeId, periodo, feito, obs } — o coordenador
// marca/desmarca uma atividade num período (dia, segunda da semana, mês ou
// data do prazo). Pode marcar período passado (fez e esqueceu de marcar),
// nunca futuro (diária/semanal/mensal).
router.put('/marcas', verifyToken, checkPermission, async (req, res) => {
    try {
        if (req.user.role !== 'coordenador') return res.status(403).json({ error: 'Só o coordenador marca as atividades do próprio plano.' });
        const sem = semestreValido(req.body.semestre);
        if (!sem) return res.status(400).json({ error: 'Semestre inválido.' });
        const atv = await db.collection(COL_ATV).doc(texto(req.body.atividadeId, 40)).get();
        if (!atv.exists) return res.status(404).json({ error: 'Atividade não encontrada.' });
        const { periodicidade } = atv.data();
        if (periodicidade === 'diario') return res.status(400).json({ error: 'Obrigação diária é rotina fixa: não precisa marcar.' });
        const periodo = texto(req.body.periodo, 10);
        const formatoOk = periodicidade === 'mensal' ? /^\d{4}-\d{2}$/.test(periodo) : !!data(periodo);
        if (!formatoOk) return res.status(400).json({ error: 'Período inválido.' });
        const hoje = hojeLocal();
        if (['diario', 'semanal', 'mensal'].includes(periodicidade) && periodo > hoje.slice(0, periodo.length)) {
            return res.status(400).json({ error: 'Não dá pra marcar um período que ainda não começou.' });
        }

        const ref = db.collection(COL_MARCAS).doc(`${req.user.uid}_${sem}_${periodo.slice(0, 7)}`);
        const chave = `${atv.id}|${periodo}`;
        if (req.body.feito) {
            const marca = { em: new Date().toISOString(), obs: texto(req.body.obs, 500) };
            await ref.set({ uid: req.user.uid, semestre: sem, mes: periodo.slice(0, 7), nome: quemFez(req), marcas: { [chave]: marca } }, { merge: true });
            res.json({ chave, marca });
        } else {
            await ref.update(new admin.firestore.FieldPath('marcas', chave), admin.firestore.FieldValue.delete()).catch(e => { if (e.code !== 5) throw e; });
            res.json({ chave, marca: null });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- agenda do coordenador (o Órbita interligado) ----------
// Compromissos de verdade do dia/semana, puxados dos outros módulos (pedido
// 21/10/2026: a rotina fixa não se marca; o que entra é o que tem data):
//   - Meu Espaço: atividade atribuída a ele (ex.: reunião marcada pelo Roni)
//   - Comercial: palestra/aulão em que ele é o palestrante — casado pelo NOME
//     cadastrado, igual ao Comercial x Matrículas — ou em que está envolvido
//   - Calendário acadêmico do Edubox: eventos gerais e os do curso dele
const normNome = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const LIGA = new Set(['DA', 'DE', 'DO', 'DAS', 'DOS', 'E', 'PROF', 'PROFA', 'PROFESSOR', 'PROFESSORA', 'DR', 'DRA', 'ME', 'MA', 'MS']);
const tokens = (s) => normNome(s).split(' ').filter(t => t.length > 1 && !LIGA.has(t));

// Nome cadastrado no Órbita x nome digitado no Comercial:
//   'sim'      primeiro nome + um sobrenome em comum ("VANESSA SILVA" x "Profª Vanessa da Silva")
//   'provavel' só o primeiro nome dá pra comparar ("Marlon"; ou o cadastro do
//              coordenador só tem "Patricia") — entra com aviso pra conferir
//   null       sobrenomes diferentes ("Vanessa Silva" x "Vanessa Gonçalves") ou outro nome
function mesmoNome(nomeCadastro, texto) {
    const c = tokens(nomeCadastro), t = tokens(texto);
    if (!c.length || !t.includes(c[0])) return null;
    if (c.slice(1).some(x => t.includes(x))) return 'sim';
    // palestrante "Raila e Bruno": várias pessoas, compara só os nomes soltos
    const soNome = t.length === 1 || c.length === 1;
    return soNome ? 'provavel' : null;
}

const CURSO_NOME = {
    agronegocio: 'Agronegócio', agronomia: 'Agronomia', 'arquitetura-urbanismo': 'Arquitetura e Urbanismo', biomedicina: 'Biomedicina',
    contabeis: 'Ciências Contábeis', direito: 'Direito', rh: 'Recursos Humanos', enfermagem: 'Enfermagem', 'engenharia-civil': 'Engenharia Civil',
    fisioterapia: 'Fisioterapia', 'gestao-comercial': 'Gestão Comercial', 'gestao-financeira': 'Gestão Financeira', logistica: 'Logística',
    medicina: 'Medicina', 'medicina-veterinaria': 'Medicina Veterinária', pedagogia: 'Pedagogia', psicologia: 'Psicologia'
};
const CURSOS_NORM = Object.values(CURSO_NOME).map(normNome);
// Como o curso aparece escrito em reserva da Agenda Interna e no calendário.
const APELIDOS_CURSO = {
    agronegocio: ['AGRONEGOCIO'], agronomia: ['AGRONOMIA'], 'arquitetura-urbanismo': ['ARQUITETURA'],
    biomedicina: ['BIOMEDICINA', 'BIOMED'], contabeis: ['CONTABEIS', 'CONTABIL', 'CIENCIAS CONTABEIS'], direito: ['DIREITO'],
    rh: ['RECURSOS HUMANOS', 'RH'], enfermagem: ['ENFERMAGEM'], 'engenharia-civil': ['ENGENHARIA CIVIL', 'ENG CIVIL'],
    fisioterapia: ['FISIOTERAPIA', 'FISIO'], 'gestao-comercial': ['GESTAO COMERCIAL'], 'gestao-financeira': ['GESTAO FINANCEIRA'],
    logistica: ['LOGISTICA'], medicina: ['MEDICINA'], 'medicina-veterinaria': ['VETERINARIA', 'MED VET', 'MEDVET'],
    pedagogia: ['PEDAGOGIA'], psicologia: ['PSICOLOGIA']
};
// Texto cita o curso? Palavra inteira; "MEDICINA" de "MEDICINA VETERINÁRIA" não conta como Medicina.
function citaCurso(texto, curso) {
    const t = ` ${normNome(texto)} `;
    return (APELIDOS_CURSO[curso] || [normNome(CURSO_NOME[curso] || curso)]).some(ap => {
        const i = t.indexOf(` ${ap} `);
        if (i < 0) return false;
        return !(curso === 'medicina' && t.slice(i).startsWith(' MEDICINA VETERINARIA'));
    });
}
const algumCurso = (texto) => Object.keys(APELIDOS_CURSO).some(c => citaCurso(texto, c));
const brasilia = (iso) => new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString();

async function agendaDe(uid, de, ate, sem) {
    const uSnap = await db.collection('users').doc(uid).get();
    if (!uSnap.exists) return [];
    const u = uSnap.data();
    const nome = u.name || u.email || '';
    const cursos = Array.isArray(u.cursos) && u.cursos.length ? u.cursos : (u.curso ? [u.curso] : []);
    const doMeuCurso = (texto) => cursos.some(c => citaCurso(texto, c));
    const itens = [];

    // Meu Espaço
    const consultas = [
        db.collection('atividades').where('uid', '==', uid).get(),
        db.collection('atividades').where('atribuidos', 'array-contains', uid).get()
    ];
    if (u.setorId) consultas.push(db.collection('atividades').where('setorId', '==', u.setorId).where('doSetor', '==', true).get());
    const vistos = new Set();
    (await Promise.all(consultas)).forEach(snap => snap.docs.forEach(d => {
        if (vistos.has(d.id)) return;
        vistos.add(d.id);
        const a = d.data();
        if (!a.prazo) return;
        const local = brasilia(a.prazo);
        const dia = local.slice(0, 10);
        if (dia < de || dia > ate) return;
        if (a.planoAcao) return; // atividades do Plano de Ação vêm por GET /tarefas
        if (a.origem && a.origem.modulo === 'agenda-espacos') return; // vem direto da reserva
        itens.push({
            data: dia, hora: local.slice(11, 16), titulo: a.titulo, descricao: a.descricao || '',
            origem: 'meu-espaco', por: a.criadoPor === uid ? '' : (a.criadoPorNome || ''), feito: a.status === 'concluido'
        });
    }));

    // Comercial: palestras e aulões (intervalo no mesmo campo, sem índice composto)
    const [pal, aul] = await Promise.all([
        db.collection('comercial_palestras').where('data', '>=', de).where('data', '<=', ate).get(),
        db.collection('comercial_auloes').where('data', '>=', de).where('data', '<=', ate).get()
    ]);
    // nome completo citado em outro campo (observação, contato, tema...) também liga
    const citado = (...campos) => campos.some(c => c && mesmoNome(nome, c) === 'sim' && tokens(c).length >= 2);
    pal.docs.forEach(d => {
        const p = d.data();
        if (p.status === 'cancelada') return;
        const palestra = mesmoNome(nome, p.palestrante) || (citado(p.observacoes, p.contatoLocal, p.tema, p.motorista) ? 'sim' : null);
        const envolvido = (p.envolvidos || []).some(e => e.uid === uid) || (p.responsaveis || []).some(e => e.uid === uid);
        if (!palestra && !envolvido) return;
        itens.push({
            confirmar: !envolvido && palestra === 'provavel' ? `confira: no Comercial o palestrante está como "${p.palestrante}"` : '',
            data: p.data, hora: p.horaInicio || '', titulo: `Palestra${p.tema ? `: ${p.tema}` : ''} — ${p.local}, ${p.cidade}`,
            descricao: [palestra ? `Palestrante: ${p.palestrante}` : 'Você está envolvido nesta palestra', p.horario && `Horário: ${p.horario}`,
                p.transporte === 'comercial' && p.motorista ? `Leva: ${p.motorista}` : ''].filter(Boolean).join(' · '),
            origem: 'palestras', feito: p.status === 'realizada'
        });
    });
    aul.docs.forEach(d => {
        const a = d.data();
        const bate = mesmoNome(nome, a.palestrante) || (citado(a.observacoes, a.contatoColegio, a.turma) ? 'sim' : null);
        if (a.status === 'cancelado' || !bate) return;
        itens.push({
            confirmar: bate === 'provavel' ? `confira: no Comercial o palestrante está como "${a.palestrante}"` : '',
            data: a.data, hora: a.horario || '', titulo: `${a.tipo || 'Aulão'} — ${a.colegio}, ${a.cidade}`,
            descricao: [`Palestrante: ${a.palestrante}`, a.turno && `Turno: ${a.turno}`, a.turma && `Turma(s): ${a.turma}`].filter(Boolean).join(' · '),
            origem: 'auloes', feito: a.status === 'realizado'
        });
    });

    // Agenda Interna (lida na hora: mudou lá, muda aqui) — entra a reserva em que
    // ele é o responsável/quem pediu ou cujo evento cita o curso dele
    // ("SEMANA ACADÊMICA BIOMEDICINA" vai pra agenda da Joana)
    const reservas = await db.collection('agenda_espacos_reservas').where('data', '>=', de).where('data', '<=', ate).get();
    reservas.docs.forEach(d => {
        const r = d.data();
        if (!['confirmada', 'pendente'].includes(r.status)) return;
        const minha = r.coordenadorUid === uid || (r.pedidoPor && r.pedidoPor.uid === uid) || mesmoNome(nome, r.responsavel) === 'sim';
        const curso = doMeuCurso(`${r.evento} ${r.observacoes || ''}`);
        if (!minha && !curso) return;
        itens.push({
            data: r.data, hora: r.inicio || '', fimHora: r.fim || '',
            titulo: `${r.evento}${r.status === 'pendente' ? ' (aguardando aprovação)' : ''}`,
            descricao: [r.espaco, r.inicio && r.fim ? `${r.inicio}–${r.fim}` : '', r.responsavel && `Responsável: ${r.responsavel}`, r.pessoas && `${r.pessoas} pessoas`].filter(Boolean).join(' · '),
            origem: 'agenda-interna', motivo: minha ? '' : 'evento do seu curso', pendente: r.status === 'pendente'
        });
    });

    // Calendário acadêmico: gerais + do curso dele (feriado/recesso já aparecem na régua)
    ((sem && sem.eventos) || []).forEach(e => {
        if (e.fim < de || e.inicio > ate || /FERIADO|RECESSO/.test(e.descricao)) return;
        const comp = `${e.descricao} ${e.complemento}`;
        const deCurso = algumCurso(e.complemento);
        const meu = doMeuCurso(comp);
        if (deCurso && !meu) return;
        itens.push({
            data: e.inicio < de ? de : e.inicio, inicio: e.inicio, fim: e.fim, hora: '', titulo: e.descricao.replace(/\.$/, ''),
            descricao: e.complemento ? e.complemento.replace(/\.$/, '') : '', origem: meu ? 'curso' : 'calendario'
        });
    });

    return itens.sort((a, b) => a.data.localeCompare(b.data) || (a.hora || '99').localeCompare(b.hora || '99'));
}

// GET /agenda?semestre=&de=&ate=&uid= — compromissos do coordenador no período (até 31 dias)
router.get('/agenda', verifyToken, checkPermission, async (req, res) => {
    try {
        const de = data(req.query.de), ate = data(req.query.ate);
        if (!de || !ate || ate < de) return res.status(400).json({ error: 'Período inválido.' });
        if ((new Date(ate) - new Date(de)) / 86400000 > 31) return res.status(400).json({ error: 'Período longo demais.' });
        const uid = req.query.uid || req.user.uid;
        if (uid !== req.user.uid && !ehDirecao(req)) return res.status(403).json({ error: 'Você só vê a sua agenda.' });
        const sem = semestreValido(req.query.semestre);
        const semDoc = sem ? await db.collection(COL_SEM).doc(sem).get() : null;
        res.json({ itens: await agendaDe(uid, de, ate, semDoc && semDoc.exists ? semDoc.data() : null) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- atividades definidas (Direção pro coordenador, ou o próprio) ----------
// Pedido 21/10/2026: o Roni (Direção) define atividades pros coordenadores e o
// coordenador também põe as dele, com prazo. Gravadas na coleção `atividades`
// do Meu Espaço (aparecem lá também), uma por coordenador (cada um conclui a
// sua), com `planoAcao: true`. Sem horário = prazo até o fim do dia.
const prazoIso = (dia, hora) => new Date(`${dia}T${hora || '23:59'}:00-03:00`).toISOString();

function tarefaDoc(d) {
    const a = d.data();
    const local = brasilia(a.prazo);
    return {
        id: d.id, uid: a.uid, titulo: a.titulo, descricao: a.descricao || '',
        data: local.slice(0, 10), hora: a.semHora ? '' : local.slice(11, 16),
        feito: a.status === 'concluido', concluidoEm: a.concluidoEm || null,
        criadoPor: a.criadoPor, criadoPorNome: a.criadoPorNome || '', daDirecao: !!a.daDirecao
    };
}

// GET /tarefas?uid= — atividades definidas de um coordenador (ou todas, pra Direção, com ?todos=1)
router.get('/tarefas', verifyToken, checkPermission, async (req, res) => {
    try {
        if (req.query.todos) {
            if (!soDirecao(req, res)) return;
            const snap = await db.collection('atividades').where('planoAcao', '==', true).get();
            return res.json({ tarefas: snap.docs.map(tarefaDoc) });
        }
        const uid = req.query.uid || req.user.uid;
        if (uid !== req.user.uid && !ehDirecao(req)) return res.status(403).json({ error: 'Você só vê as suas atividades.' });
        const snap = await db.collection('atividades').where('uid', '==', uid).where('planoAcao', '==', true).get();
        res.json({ tarefas: snap.docs.map(tarefaDoc).sort((a, b) => a.data.localeCompare(b.data)) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /tarefas { titulo, descricao, data, hora?, uids? } — Direção escolhe os
// coordenadores (uids); o coordenador só cria pra ele mesmo.
router.post('/tarefas', verifyToken, checkPermission, async (req, res) => {
    try {
        const titulo = texto(req.body.titulo, 200);
        const dia = data(req.body.data);
        const hora = /^\d{2}:\d{2}$/.test(req.body.hora || '') ? req.body.hora : '';
        if (!titulo) return res.status(400).json({ error: 'Descreva a atividade.' });
        if (!dia) return res.status(400).json({ error: 'Informe a data (ou o prazo).' });
        let alvos;
        if (ehDirecao(req)) {
            const validos = new Set((await coordenadores()).map(c => c.uid));
            alvos = [...new Set(Array.isArray(req.body.uids) ? req.body.uids : [])].filter(u => validos.has(u));
            if (!alvos.length) return res.status(400).json({ error: 'Escolha pelo menos um coordenador.' });
        } else if (req.user.role === 'coordenador') {
            if (dia < hojeLocal()) return res.status(400).json({ error: 'O prazo não pode ser uma data que já passou.' });
            alvos = [req.user.uid];
        } else return res.status(403).json({ error: 'Só a Direção e os coordenadores criam atividades aqui.' });

        const agora = new Date().toISOString();
        const users = await db.getAll(...alvos.map(u => db.collection('users').doc(u)));
        const batch = db.batch();
        const criadas = [];
        users.forEach(u => {
            const ref = db.collection('atividades').doc();
            const doc = {
                titulo, descricao: texto(req.body.descricao, 1500), prazo: prazoIso(dia, hora), semHora: !hora,
                status: 'a_fazer', historico: [], concluidoEm: null, tipo: 'pontual',
                uid: u.id, setorId: u.exists ? (u.data().setorId || null) : null,
                planoAcao: true, daDirecao: ehDirecao(req),
                criadoPor: req.user.uid, criadoPorNome: quemFez(req), createdAt: agora, updatedAt: agora
            };
            batch.set(ref, doc);
            criadas.push({ id: ref.id, ...doc });
        });
        await batch.commit();
        res.status(201).json({ criadas: criadas.length, tarefas: criadas.map(c => tarefaDoc({ id: c.id, data: () => c })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function tarefaComDono(req, res) {
    const ref = db.collection('atividades').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || !snap.data().planoAcao) { res.status(404).json({ error: 'Atividade não encontrada.' }); return null; }
    return { ref, a: snap.data() };
}

// PATCH /tarefas/:id { feito } — o coordenador conclui (ou reabre) a dele
router.patch('/tarefas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const t = await tarefaComDono(req, res);
        if (!t) return;
        if (t.a.uid !== req.user.uid) return res.status(403).json({ error: 'Só o próprio coordenador conclui a atividade.' });
        const agora = new Date().toISOString();
        const feito = !!req.body.feito;
        await t.ref.update({ status: feito ? 'concluido' : 'a_fazer', concluidoEm: feito ? agora : null, updatedAt: agora });
        res.json(tarefaDoc(await t.ref.get()));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /tarefas/:id — quem criou (ou a Direção) exclui
router.delete('/tarefas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const t = await tarefaComDono(req, res);
        if (!t) return;
        if (t.a.criadoPor !== req.user.uid && !ehDirecao(req)) return res.status(403).json({ error: 'Só quem criou a atividade (ou a Direção) pode excluir.' });
        await t.ref.delete();
        res.json({ message: 'Atividade excluída.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Direção: atividades ----------
function camposAtividade(body) {
    return {
        titulo: texto(body.titulo, 400),
        periodicidade: PERIODICIDADES.includes(body.periodicidade) ? body.periodicidade : 'a_definir',
        responsavel: RESPONSAVEIS.includes(body.responsavel) ? body.responsavel : 'coordenador',
        detalhe: texto(body.detalhe, 1000)
    };
}

router.post('/atividades', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const c = camposAtividade(req.body);
        if (!c.titulo) return res.status(400).json({ error: 'Descreva a atividade.' });
        const lista = await atividades();
        const ordem = Math.max(0, ...lista.map(a => a.ordem || 0)) + 1;
        const ref = db.collection(COL_ATV).doc();
        const doc = { ...c, ordem, ativo: true, createdAt: new Date().toISOString(), createdBy: quemFez(req) };
        await ref.set(doc);
        res.status(201).json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/atividades/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const ref = db.collection(COL_ATV).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Atividade não encontrada.' });
        const c = camposAtividade(req.body);
        if (!c.titulo) return res.status(400).json({ error: 'Descreva a atividade.' });
        // Desativar em vez de excluir: as marcas antigas continuam valendo no histórico.
        const upd = { ...c, ativo: req.body.ativo !== false, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        await ref.update(upd);
        res.json({ id: ref.id, ...snap.data(), ...upd });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Direção: semestre ----------
// PUT /semestres/:sem/prazos/:atividadeId { datas: [...] } — prazos lançados
// pela Direção (os do calendário do Edubox ficam como estão).
router.put('/semestres/:sem/prazos/:atividadeId', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const sem = semestreValido(req.params.sem);
        const ref = db.collection(COL_SEM).doc(sem || '-');
        const snap = await ref.get();
        if (!sem || !snap.exists) return res.status(404).json({ error: 'Semestre não carregado.' });
        const { inicio, fim } = snap.data();
        const datas = [...new Set((req.body.datas || []).map(data).filter(Boolean))].sort();
        if (datas.some(d => d < inicio || d > fim)) return res.status(400).json({ error: `As datas precisam estar dentro do semestre (${inicio} a ${fim}).` });
        const id = texto(req.params.atividadeId, 40);
        const doCalendario = ((snap.data().prazos || {})[id] || []).filter(p => p.origem === 'calendario');
        const lista = [...doCalendario, ...datas.map(d => ({ data: d, origem: 'direcao', por: quemFez(req) }))].sort((a, b) => a.data.localeCompare(b.data));
        await ref.update(new admin.firestore.FieldPath('prazos', id), lista);
        res.json({ prazos: lista });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /semestres/:sem/acompanhamento { inicioAcompanhamento } — a partir de
// quando conta atraso.
router.put('/semestres/:sem/acompanhamento', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soDirecao(req, res)) return;
        const sem = semestreValido(req.params.sem);
        const ref = db.collection(COL_SEM).doc(sem || '-');
        const snap = await ref.get();
        if (!sem || !snap.exists) return res.status(404).json({ error: 'Semestre não carregado.' });
        const d = data(req.body.inicioAcompanhamento);
        if (!d) return res.status(400).json({ error: 'Data inválida.' });
        await ref.update({ inicioAcompanhamento: d });
        res.json({ inicioAcompanhamento: d });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
