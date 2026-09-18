const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const edubox = require('../db-edubox');

const checkPermission = verifyToken.requireModulePermission('confirmacao-evento');

const COL_EVENTOS = 'docencia_confirmacao_eventos';
const COL_ITENS = 'docencia_confirmacao_itens';

const STATUS_VALIDOS = ['pendente', 'presente', 'ausente', 'ausente_ead'];

// Cursos da FATEC IVP — mesma lista usada em Avaliação Docente/Banco de
// Provas pra vincular o Coordenador a um curso (users.cursos).
const CURSOS = [
    { id: 'agronegocio', name: 'Agronegócio' },
    { id: 'agronomia', name: 'Agronomia' },
    { id: 'arquitetura-urbanismo', name: 'Arquitetura e Urbanismo' },
    { id: 'biomedicina', name: 'Biomedicina' },
    { id: 'contabeis', name: 'Ciências Contábeis' },
    { id: 'direito', name: 'Direito' },
    { id: 'rh', name: 'Recursos Humanos' },
    { id: 'enfermagem', name: 'Enfermagem' },
    { id: 'engenharia-civil', name: 'Engenharia Civil' },
    { id: 'fisioterapia', name: 'Fisioterapia' },
    { id: 'gestao-comercial', name: 'Gestão Comercial' },
    { id: 'gestao-financeira', name: 'Gestão Financeira' },
    { id: 'logistica', name: 'Logística' },
    { id: 'medicina', name: 'Medicina' },
    { id: 'medicina-veterinaria', name: 'Medicina Veterinária' },
    { id: 'pedagogia', name: 'Pedagogia' },
    { id: 'psicologia', name: 'Psicologia' }
];

// Mapa FIXO codcur (Edubox) -> id do curso interno (users.cursos) — pedido
// explícito (18/09): "cada coordenador só consegue editar presença dos
// professores do seu curso... adm pode tudo". Levantado direto do
// `tac_curso` do Edubox (20 cursos); 3 deles (Gestão de Processos
// Gerenciais, Marketing, Secretariado) não têm curso interno correspondente
// ainda — ficam sem `cursoId` (só ADM mexe nesses professores até alguém
// criar o curso correspondente em Usuários).
const CODCUR_PARA_CURSO_ID = {
    'AGRON': 'agronomia',
    'ARQUIT': 'arquitetura-urbanismo',
    'BIOMED': 'biomedicina',
    'CI.CONT': 'contabeis',
    'DIR': 'direito',
    'ENFER': 'enfermagem',
    'ENG.CIV': 'engenharia-civil',
    'FISIO': 'fisioterapia',
    'MED': 'medicina',
    'MED.VET.': 'medicina-veterinaria',
    'PSICO': 'psicologia',
    'PED': 'pedagogia',
    'GEST.COM': 'gestao-comercial',
    'AGRO': 'agronegocio',
    'RH': 'rh',
    'FINAN': 'gestao-financeira',
    'LOG': 'logistica'
};

function apenasProprias(role) {
    return role === 'coordenador';
}

function isAdmin(role) {
    return role === 'adm_l1' || role === 'adm_l2';
}

// Mesmo padrão de avaliacao-docente.js — um coordenador pode ter mais de um
// curso vinculado.
async function cursosDoCoordenador(uid) {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return [];
    const data = snap.data();
    const idsBrutos = Array.isArray(data.cursos) && data.cursos.length
        ? data.cursos
        : (data.curso ? [data.curso] : []);
    return idsBrutos.filter(id => CURSOS.some(c => c.id === id));
}

// Um professor pode lecionar em mais de um curso (pedido explícito 18/09:
// "abre exceção que tem professor que dá aula em mais que um curso") — por
// isso é interseção (algum curso em comum), não "todos os cursos batem".
function coordenadorVeItem(item, cursoIdsCoordenador) {
    if (!cursoIdsCoordenador.length) return false;
    return (item.cursoIds || []).some(id => cursoIdsCoordenador.includes(id));
}

function filtrarItensPorPermissao(itens, role, cursoIdsCoordenador) {
    if (!apenasProprias(role)) return itens;
    return itens.filter(item => coordenadorVeItem(item, cursoIdsCoordenador));
}

// ==========================================
// EDUBOX — professores ativos no(s) semestre(s) vigente(s)
// ==========================================
// O vínculo "professor leciona X neste semestre" fica em
// `tac_professor.dtupro`, que aponta pra `tac_disciplina_turma.coddtu` (é o
// PROFESSOR que referencia a disciplina/turma, não o contrário — o campo
// antigo `tac_disciplina_turma.prodtu` foi abandonado em 2020, não serve
// mais). O semestre vigente vem de `tac_semestre.atisem = 'S'` — o Edubox
// mantém DUAS bases de semestre em paralelo, uma pra graduação (nomsem=
// 'GRA', ex. "2026/2") e uma pra Medicina (nomsem='MED', ex. "2026-2") —
// pedido explícito (18/09): "tem 2 bases o edubox, gra e med" — por isso a
// query sempre busca TODOS os semestres com atisem='S', nunca um só.
//
// Cada professor pode lecionar várias disciplinas/turmas (por isso agrupamos
// por `codfun`, o id da PESSOA em `trh_funcionario` — `tac_professor.codpro`
// é por VÍNCULO/disciplina, tem várias linhas repetidas pro mesmo professor).
//
// Só selecionamos nome e e-mail de `trh_funcionario` de propósito — essa
// tabela tem CPF, RG, endereço, data de nascimento etc., e nada disso é
// necessário aqui (minimização de dado pessoal).
async function buscarProfessoresAtivosEdubox() {
    const semAtivo = await edubox.query(`SELECT codsem FROM tac_semestre WHERE atisem = 'S'`);
    const codsems = semAtivo.rows.map(r => r.codsem);
    if (!codsems.length) return { semestres: [], professores: [] };

    const { rows } = await edubox.query(`
        SELECT
            f.codfun,
            trim(f.nomfun) AS nome,
            f.emafun AS email,
            array_agg(DISTINCT trim(c.descur)) AS cursos,
            array_agg(DISTINCT t.curtur) AS codcurs
        FROM tac_professor p
        JOIN tac_disciplina_turma dt ON dt.coddtu = p.dtupro
        JOIN tac_turma t ON t.codtur = dt.turdtu
        JOIN trh_funcionario f ON f.codfun = p.funpro
        LEFT JOIN tac_curso c ON c.codcur = t.curtur
        WHERE t.semtur = ANY($1::varchar[])
        GROUP BY f.codfun, f.nomfun, f.emafun
        ORDER BY nome
    `, [codsems]);

    return {
        semestres: codsems,
        professores: rows.map(r => ({
            codfun: r.codfun,
            nome: r.nome,
            email: r.email || null,
            cursos: (r.cursos || []).filter(Boolean),
            // Vários codcur por professor (pode lecionar em mais de um
            // curso) -> mapeia cada um pro id interno; ignora os que não
            // têm curso interno correspondente (ver CODCUR_PARA_CURSO_ID).
            cursoIds: [...new Set((r.codcurs || []).map(cod => CODCUR_PARA_CURSO_ID[cod]).filter(Boolean))]
        }))
    };
}

router.get('/professores-edubox', verifyToken, checkPermission, async (req, res) => {
    try {
        const resultado = await buscarProfessoresAtivosEdubox();
        res.json(resultado);
    } catch (err) {
        console.error('[confirmacao-evento] Erro ao consultar Edubox:', err);
        res.status(500).json({ error: 'Não foi possível consultar o Edubox agora. Tente novamente em instantes.' });
    }
});

// ==========================================
// EVENTOS
// ==========================================
function resumoStatus(itens) {
    const resumo = { pendente: 0, presente: 0, ausente: 0, ausente_ead: 0, total: itens.length };
    itens.forEach(i => { resumo[i.status] = (resumo[i.status] || 0) + 1; });
    return resumo;
}

router.get('/eventos', verifyToken, checkPermission, async (req, res) => {
    try {
        const cursoIdsCoordenador = apenasProprias(req.user.role) ? await cursosDoCoordenador(req.user.uid) : [];
        const snap = await db.collection(COL_EVENTOS).orderBy('createdAt', 'desc').get();
        const eventos = await Promise.all(snap.docs.map(async d => {
            const itensSnap = await db.collection(COL_ITENS).where('eventoId', '==', d.id).get();
            const itens = filtrarItensPorPermissao(itensSnap.docs.map(i => i.data()), req.user.role, cursoIdsCoordenador);
            return { id: d.id, ...d.data(), resumo: resumoStatus(itens) };
        }));
        res.json(eventos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/eventos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_EVENTOS).doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Evento não encontrado.' });

        const cursoIdsCoordenador = apenasProprias(req.user.role) ? await cursosDoCoordenador(req.user.uid) : [];
        const itensSnap = await db.collection(COL_ITENS).where('eventoId', '==', req.params.id).get();
        let itens = itensSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        itens = filtrarItensPorPermissao(itens, req.user.role, cursoIdsCoordenador);
        itens.sort((a, b) => (a.professorNome || '').localeCompare(b.professorNome || ''));

        res.json({ id: snap.id, ...snap.data(), itens, resumo: resumoStatus(itens) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cria o evento e já popula a lista de professores puxando do Edubox — o
// coordenador confirma/edita depois, não precisa montar a lista à mão.
// Só ADM cria evento (pedido explícito 18/09) — é uma ação institucional
// (afeta todos os cursos de uma vez), coordenador só confirma presença.
router.post('/eventos', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!isAdmin(req.user.role)) {
            return res.status(403).json({ error: 'Só administradores podem criar eventos.' });
        }
        const nome = String(req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome do evento.' });
        const data = String(req.body.data || '').trim();
        if (!data) return res.status(400).json({ error: 'Informe a data do evento.' });
        const semestreLabel = String(req.body.semestreLabel || '').trim() || null;

        let professores = [];
        let semestresEdubox = [];
        try {
            const resultado = await buscarProfessoresAtivosEdubox();
            professores = resultado.professores;
            semestresEdubox = resultado.semestres;
        } catch (err) {
            console.error('[confirmacao-evento] Erro ao puxar professores do Edubox na criação do evento:', err);
            return res.status(502).json({ error: 'Não foi possível consultar o Edubox pra montar a lista de professores. Tente novamente em instantes.' });
        }

        const eventoRef = await db.collection(COL_EVENTOS).add({
            nome, data, semestreLabel,
            semestresEdubox,
            totalProfessoresEdubox: professores.length,
            createdBy: req.user.uid,
            createdPorNome: req.user.name || req.user.email || 'Coordenador',
            createdAt: new Date().toISOString()
        });

        const batch = db.batch();
        professores.forEach(p => {
            const ref = db.collection(COL_ITENS).doc();
            batch.set(ref, {
                eventoId: eventoRef.id,
                professorCodfun: p.codfun,
                professorNome: p.nome,
                professorEmail: p.email,
                cursos: p.cursos,
                cursoIds: p.cursoIds,
                status: 'pendente',
                justificativa: null,
                dataContato: null,
                dataConfirmacao: null,
                origem: 'edubox',
                updatedAt: new Date().toISOString()
            });
        });
        await batch.commit();

        res.status(201).json({ id: eventoRef.id, message: `Evento criado com ${professores.length} professor(es) do Edubox.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/eventos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_EVENTOS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Evento não encontrado.' });

        const itensSnap = await db.collection(COL_ITENS).where('eventoId', '==', req.params.id).get();
        const batch = db.batch();
        itensSnap.docs.forEach(d => batch.delete(d.ref));
        batch.delete(ref);
        await batch.commit();

        res.json({ message: 'Evento excluído.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recarrega a lista de professores do Edubox pro evento — adiciona quem
// entrou depois (nova disciplina/turma), sem apagar o que já foi confirmado
// pra quem já estava na lista.
router.post('/eventos/:id/atualizar-professores', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_EVENTOS).doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Evento não encontrado.' });

        const itensSnap = await db.collection(COL_ITENS).where('eventoId', '==', req.params.id).get();
        const codfunsExistentes = new Set(itensSnap.docs.map(d => d.data().professorCodfun));

        const { professores } = await buscarProfessoresAtivosEdubox();
        const novos = professores.filter(p => !codfunsExistentes.has(p.codfun));

        const batch = db.batch();
        novos.forEach(p => {
            const ref = db.collection(COL_ITENS).doc();
            batch.set(ref, {
                eventoId: req.params.id,
                professorCodfun: p.codfun,
                professorNome: p.nome,
                professorEmail: p.email,
                cursos: p.cursos,
                cursoIds: p.cursoIds,
                status: 'pendente',
                justificativa: null,
                dataContato: null,
                dataConfirmacao: null,
                origem: 'edubox',
                updatedAt: new Date().toISOString()
            });
        });
        if (novos.length) await batch.commit();

        res.json({ message: novos.length ? `${novos.length} novo(s) professor(es) adicionado(s).` : 'Nenhum professor novo encontrado.', adicionados: novos.length });
    } catch (err) {
        console.error('[confirmacao-evento] Erro ao atualizar lista de professores:', err);
        res.status(500).json({ error: 'Não foi possível consultar o Edubox agora. Tente novamente em instantes.' });
    }
});

// ==========================================
// ITENS (confirmação por professor)
// ==========================================

// Adiciona manualmente um professor que não veio do Edubox (ex.: convidado
// externo, ou vínculo que o Edubox não tem cadastrado).
router.post('/eventos/:id/itens', verifyToken, checkPermission, async (req, res) => {
    try {
        const eventoSnap = await db.collection(COL_EVENTOS).doc(req.params.id).get();
        if (!eventoSnap.exists) return res.status(404).json({ error: 'Evento não encontrado.' });

        const nome = String(req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome do professor.' });

        // Um coordenador que adiciona manualmente marca automaticamente
        // como "do curso dele" (senão o item ficaria invisível pra ele
        // mesmo logo depois de criar, já que o filtro é por cursoIds).
        const cursoIds = apenasProprias(req.user.role) ? await cursosDoCoordenador(req.user.uid) : [];

        const ref = await db.collection(COL_ITENS).add({
            eventoId: req.params.id,
            professorCodfun: null,
            professorNome: nome,
            professorEmail: String(req.body.email || '').trim() || null,
            cursos: [],
            cursoIds,
            status: 'pendente',
            justificativa: null,
            dataContato: null,
            dataConfirmacao: null,
            origem: 'manual',
            updatedAt: new Date().toISOString()
        });
        res.status(201).json({ id: ref.id, message: 'Professor adicionado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/eventos/:id/itens/:itemId', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_ITENS).doc(req.params.itemId);
        const snap = await ref.get();
        if (!snap.exists || snap.data().eventoId !== req.params.id) {
            return res.status(404).json({ error: 'Item não encontrado nesse evento.' });
        }

        // Coordenador só edita presença/justificativa de professor do(s)
        // próprio(s) curso(s) — pedido explícito (18/09). ADM sempre passa
        // (requireModulePermission já libera adm_l1 direto; adm_l2 chega
        // aqui com o mesmo nível 3 do coordenador, então a checagem abaixo
        // teria que valer só pra `coordenador` mesmo).
        if (apenasProprias(req.user.role)) {
            const cursoIdsCoordenador = await cursosDoCoordenador(req.user.uid);
            if (!coordenadorVeItem(snap.data(), cursoIdsCoordenador)) {
                return res.status(403).json({ error: 'Você só pode editar professores do(s) seu(s) curso(s).' });
            }
        }

        const status = req.body.status;
        if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ error: 'Status inválido.' });

        await ref.update({
            status,
            justificativa: String(req.body.justificativa || '').trim() || null,
            dataContato: String(req.body.dataContato || '').trim() || null,
            dataConfirmacao: String(req.body.dataConfirmacao || '').trim() || null,
            updatedBy: req.user.uid,
            updatedAt: new Date().toISOString()
        });
        res.json({ message: 'Atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/eventos/:id/itens/:itemId', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_ITENS).doc(req.params.itemId);
        const snap = await ref.get();
        if (!snap.exists || snap.data().eventoId !== req.params.id) {
            return res.status(404).json({ error: 'Item não encontrado nesse evento.' });
        }
        if (apenasProprias(req.user.role)) {
            const cursoIdsCoordenador = await cursosDoCoordenador(req.user.uid);
            if (!coordenadorVeItem(snap.data(), cursoIdsCoordenador)) {
                return res.status(403).json({ error: 'Você só pode remover professores do(s) seu(s) curso(s).' });
            }
        }
        await ref.delete();
        res.json({ message: 'Professor removido do evento.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
