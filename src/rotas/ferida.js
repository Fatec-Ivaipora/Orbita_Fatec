const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// Middleware para verificar permissão do módulo 'ferida' (Gestão Saúde)
// ⚠️ Dado de saúde de paciente = dado pessoal sensível (LGPD).
// Todo acesso passa por token + RBAC e todo registro guarda autoria/data.
const checkPermission = verifyToken.requireModulePermission('ferida');

const COL_PACIENTES = 'ferida_pacientes';
const COL_SOLICITACOES = 'ferida_solicitacoes';
const TIPOS_FERIDA = ['Neuropatia Diabética', 'Úlcera Venosa', 'Úlcera Arterial', 'Úlcera Mista'];

// Enfermeira-chefe do ambulatório — só ela (ou o ADM) pode editar cadastro/atendimento
// já salvos, ou excluir de fato. Os demais enfermeiros podem só solicitar a exclusão.
const UID_AMANDA = 'yvbrbHvSPFMXyA3nLwB68qjch8A2';
const podeExcluirDireto = (req) => req.user.role === 'adm_l1' || req.user.uid === UID_AMANDA;
const apenasAmanda = (req, res, next) => {
    if (podeExcluirDireto(req)) return next();
    return res.status(403).json({ error: 'Somente a enfermeira responsável pode editar este registro.' });
};

// Documento único com a lista de enfermeiros/estagiários ativos do ambulatório.
// Mantida pelo ADM (não pelo próprio enfermeiro) — muda com frequência por conta
// de estagiários do último ano de enfermagem entrando e saindo do rodízio.
const DOC_ENFERMEIROS = db.collection('config').doc('ferida_enfermeiros');

// ==========================================
// PACIENTES
// ==========================================

// Remove acentos e caixa para comparar nomes (ex.: "joão" casa com "Joao").
const DIACRITICOS = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');
const normalizar = s => String(s || '').normalize('NFD').replace(DIACRITICOS, '').toLowerCase();

// Monta um texto de busca com nome + município + enfermeiro(a) responsável,
// pra quem esqueceu o nome do paciente conseguir achar pela cidade ou por quem atende.
const textoBusca = p => normalizar([p.nome, p.municipio, p.enfermeiro].filter(Boolean).join(' '));

// GET /api/ferida/pacientes - Listar pacientes do ambulatório
// ?busca=<termo> filtra no servidor por nome, município ou enfermeiro(a)
// (sem acento/caixa) — a base do ambulatório é pequena, então lê tudo e filtra em memória.
router.get('/pacientes', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_PACIENTES).orderBy('nome').get();
        let pacientes = [];
        snap.forEach(doc => pacientes.push({ id: doc.id, ...doc.data() }));

        const busca = normalizar(req.query.busca);
        if (busca) {
            pacientes = pacientes.filter(p => textoBusca(p).includes(busca));
        }

        // Contagem de atendimentos por paciente (aggregation count — não conta
        // como leitura de documento, só o resultado já filtrado pela busca).
        const pacientesComContagem = await Promise.all(pacientes.map(async p => {
            const contagem = await db.collection(COL_PACIENTES).doc(p.id).collection('atendimentos').count().get();
            return { ...p, atendimentosCount: contagem.data().count };
        }));

        res.json(pacientesComContagem);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/ferida/pacientes/:id - Buscar um paciente específico (abrir a ficha direto por link)
router.get('/pacientes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const doc = await db.collection(COL_PACIENTES).doc(req.params.id).get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Paciente não encontrado.' });
        }
        res.json({ id: doc.id, ...doc.data() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/ferida/pacientes - Cadastrar novo paciente
router.post('/pacientes', verifyToken, checkPermission, async (req, res) => {
    try {
        const { nome, dataNascimento, municipio, tipoFerida, enfermeiro } = req.body;

        if (!nome || !nome.trim()) {
            return res.status(400).json({ error: 'O nome do paciente é obrigatório.' });
        }

        const newDoc = db.collection(COL_PACIENTES).doc();
        await newDoc.set({
            nome: nome.trim(),
            dataNascimento: dataNascimento || null,
            municipio: (municipio || '').trim(),
            tipoFerida: TIPOS_FERIDA.includes(tipoFerida) ? tipoFerida : null,
            enfermeiro: (enfermeiro || '').trim(),
            alta: false,
            dataAlta: null,
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid,
            createdByName: req.user.name || req.user.email || ''
        });
        res.status(201).json({ message: 'Paciente cadastrado com sucesso!', id: newDoc.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/ferida/pacientes/:id - Atualizar dados cadastrais do paciente
router.put('/pacientes/:id', verifyToken, checkPermission, apenasAmanda, async (req, res) => {
    try {
        const { nome, dataNascimento, municipio, tipoFerida, enfermeiro } = req.body;

        if (!nome || !nome.trim()) {
            return res.status(400).json({ error: 'O nome do paciente é obrigatório.' });
        }

        const dadosAtualizados = {
            nome: nome.trim(),
            municipio: (municipio || '').trim(),
            tipoFerida: TIPOS_FERIDA.includes(tipoFerida) ? tipoFerida : null,
            enfermeiro: (enfermeiro || '').trim(),
            updatedAt: new Date().toISOString(),
            updatedBy: req.user.uid
        };
        // O cadastro não pede mais nascimento — só toca o campo se vier explícito
        // no corpo da requisição, pra não apagar o dado de pacientes antigos.
        if (dataNascimento !== undefined) dadosAtualizados.dataNascimento = dataNascimento || null;

        await db.collection(COL_PACIENTES).doc(req.params.id).update(dadosAtualizados);
        res.json({ message: 'Paciente atualizado com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/ferida/pacientes/:id/enfermeiro - Trocar só o enfermeiro responsável
// (aberto a todos os enfermeiros — troca operacional, não edição de cadastro clínico)
router.put('/pacientes/:id/enfermeiro', verifyToken, checkPermission, async (req, res) => {
    try {
        const enfermeiro = (req.body.enfermeiro || '').trim();
        await db.collection(COL_PACIENTES).doc(req.params.id).update({
            enfermeiro,
            updatedAt: new Date().toISOString(),
            updatedBy: req.user.uid
        });
        res.json({ message: 'Enfermeiro atualizado com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/ferida/pacientes/:id/alta - Dar alta ou reativar o paciente
// (aberto a todos os enfermeiros — mesma lógica do endpoint de enfermeiro:
// troca operacional do dia a dia, não edição do cadastro clínico em si).
router.put('/pacientes/:id/alta', verifyToken, checkPermission, async (req, res) => {
    try {
        const alta = req.body.alta === true;
        await db.collection(COL_PACIENTES).doc(req.params.id).update({
            alta,
            dataAlta: alta ? new Date().toISOString() : null,
            updatedAt: new Date().toISOString(),
            updatedBy: req.user.uid
        });
        res.json({ message: alta ? 'Paciente recebeu alta.' : 'Paciente reativado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Apaga o paciente e todo o histórico (subcoleções não somem sozinhas no Firestore).
// Reaproveitada tanto pela exclusão direta (Amanda/ADM) quanto pela aprovação de solicitação.
async function excluirPacienteDefinitivo(pacienteId) {
    const ref = db.collection(COL_PACIENTES).doc(pacienteId);
    for (const sub of ['atendimentos', 'fichas_antigas']) {
        const snap = await ref.collection(sub).get();
        const docs = [...snap.docs];
        while (docs.length) {
            const batch = db.batch();
            docs.splice(0, 400).forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
    }
    await ref.delete();
}

// DELETE /api/ferida/pacientes/:id - Excluir paciente DEFINITIVAMENTE
// ⚠️ Apaga também os atendimentos e as fichas antigas. Irreversível — LGPD:
// atende ao direito de eliminação do titular.
// Só Amanda/ADM excluem de fato; os demais enfermeiros geram uma solicitação
// pendente de aprovação (fila em `ferida_solicitacoes`).
router.delete('/pacientes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_PACIENTES).doc(req.params.id);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Paciente não encontrado.' });
        }

        if (!podeExcluirDireto(req)) {
            await db.collection(COL_SOLICITACOES).add({
                tipo: 'excluir_paciente',
                pacienteId: req.params.id,
                pacienteNome: doc.data().nome || '',
                solicitadoPor: req.user.uid,
                solicitadoPorNome: req.user.name || req.user.email || '',
                solicitadoEm: new Date().toISOString(),
                status: 'pendente'
            });
            return res.status(201).json({ message: 'Solicitação de exclusão enviada. A enfermeira responsável vai aprovar.' });
        }

        await excluirPacienteDefinitivo(req.params.id);

        console.log(`[ferida] Paciente ${req.params.id} excluído por ${req.user.uid} (${req.user.email || ''})`);
        res.json({ message: 'Paciente excluído definitivamente, com todo o histórico.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ENFERMEIROS (lista mantida pelo ADM, usada como padrão no cadastro)
// ==========================================

// GET /api/ferida/enfermeiros - Lista de enfermeiros/estagiários ativos
router.get('/enfermeiros', verifyToken, checkPermission, async (req, res) => {
    try {
        const doc = await DOC_ENFERMEIROS.get();
        res.json({ nomes: doc.exists ? (doc.data().nomes || []) : [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/ferida/enfermeiros - Substitui a lista inteira (só ADM/quem tem edição no módulo)
router.put('/enfermeiros', verifyToken, checkPermission, async (req, res) => {
    try {
        const { nomes } = req.body;
        if (!Array.isArray(nomes)) {
            return res.status(400).json({ error: 'Envie a lista de nomes.' });
        }

        const limpos = [...new Set(nomes.map(n => String(n || '').trim()).filter(Boolean))];

        await DOC_ENFERMEIROS.set({
            nomes: limpos,
            updatedAt: new Date().toISOString(),
            updatedBy: req.user.uid
        });
        res.json({ message: 'Lista de enfermeiros atualizada com sucesso!', nomes: limpos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ATENDIMENTOS (avaliações da ferida)
// ==========================================

// GET /api/ferida/pacientes/:id/atendimentos - Histórico do paciente (mais antigo primeiro)
router.get('/pacientes/:id/atendimentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_PACIENTES).doc(req.params.id)
            .collection('atendimentos')
            .orderBy('createdAt', 'asc')
            .get();
        const atendimentos = [];
        snap.forEach(doc => atendimentos.push({ id: doc.id, ...doc.data() }));
        res.json(atendimentos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const num = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? null : n;
};

// Cada ferida marcada no boneco tem seu próprio tamanho — só as dimensões são
// por marcação. O resto da avaliação clínica (tecido, bordas, exsudato,
// infecção, biofilme, dor) continua única pro atendimento inteiro.
function sanitizarMarcacao(m) {
    return {
        numero: parseInt(m.numero) || 0,
        regiao: String(m.regiao || ''),
        x: num(m.x),
        y: num(m.y),
        rotulo: String(m.rotulo || '').trim(),
        dimensoes: {
            comprimento:  num(m.dimensoes?.comprimento),
            largura:      num(m.dimensoes?.largura),
            profundidade: num(m.dimensoes?.profundidade),
            descolamento: num(m.dimensoes?.descolamento)
        }
    };
}

// Monta e valida o corpo de um atendimento a partir do req.body — usado tanto
// pra criar (POST) quanto pra editar (PUT) um registro.
function montarDadosAtendimento(body) {
    const {
        marcacoes,            // [{ numero, regiao, x, y, rotulo, dimensoes }]
        tecido,               // ["Granulação", ...]
        bordas,               // ["Maceração", ...]
        peleAdjacente,        // ["Íntegra", "Ressecada", ...]
        exsudato,             // { tipo, cor, consistencia, quantidade }
        infeccaoSuperficial,  // ["Odor", ...]
        infeccaoProfunda,     // ["Edema", ...]
        biofilme,             // true | false | null
        dor,                  // { presente: true|false|null, escala: 1..10|null }
        cobertura,            // ["SOLOSITE", "AQUACEL AG+", ...]
        conduta,              // texto livre
        enfermeiro,           // enfermeiro responsável por ESTE atendimento (pode diferir do cadastro do paciente)
        dataAtendimento       // YYYY-MM-DD opcional: data original (ficha de papel importada / lançamento retroativo)
    } = body;

    const marcacoesSanitizadas = Array.isArray(marcacoes) ? marcacoes.map(sanitizarMarcacao) : [];

    const temConteudo =
        marcacoesSanitizadas.some(m => Object.values(m.dimensoes).some(v => v !== null)) ||
        (Array.isArray(tecido) && tecido.length) ||
        (Array.isArray(bordas) && bordas.length) ||
        (Array.isArray(peleAdjacente) && peleAdjacente.length) ||
        (exsudato && Object.values(exsudato).some(Boolean)) ||
        (Array.isArray(infeccaoSuperficial) && infeccaoSuperficial.length) ||
        (Array.isArray(infeccaoProfunda) && infeccaoProfunda.length) ||
        biofilme !== null && biofilme !== undefined ||
        (dor && (typeof dor.presente === 'boolean' || dor.escala)) ||
        (Array.isArray(cobertura) && cobertura.length) ||
        (conduta && conduta.trim());

    if (!temConteudo) {
        return { erro: 'O atendimento está vazio. Preencha a avaliação antes de salvar.' };
    }

    return {
        dados: {
            marcacoes: marcacoesSanitizadas,
            tecido:              Array.isArray(tecido) ? tecido : [],
            bordas:              Array.isArray(bordas) ? bordas : [],
            peleAdjacente:       Array.isArray(peleAdjacente) ? peleAdjacente : [],
            exsudato: {
                tipo:         exsudato?.tipo         || null,
                cor:          exsudato?.cor          || null,
                consistencia: exsudato?.consistencia || null,
                quantidade:   exsudato?.quantidade   || null
            },
            infeccaoSuperficial: Array.isArray(infeccaoSuperficial) ? infeccaoSuperficial : [],
            infeccaoProfunda:    Array.isArray(infeccaoProfunda) ? infeccaoProfunda : [],
            biofilme:            typeof biofilme === 'boolean' ? biofilme : null,
            dor: {
                presente: typeof dor?.presente === 'boolean' ? dor.presente : null,
                escala: (Number.isInteger(dor?.escala) && dor.escala >= 1 && dor.escala <= 10) ? dor.escala : null
            },
            cobertura:  Array.isArray(cobertura) ? cobertura : [],
            conduta:    (conduta || '').trim(),
            enfermeiro: (enfermeiro || '').trim(),
            dataAtendimento: (typeof dataAtendimento === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dataAtendimento)) ? dataAtendimento : null
        }
    };
}

// POST /api/ferida/pacientes/:id/atendimentos - Registrar avaliação da ferida
router.post('/pacientes/:id/atendimentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const pacienteRef = db.collection(COL_PACIENTES).doc(req.params.id);
        const pacienteDoc = await pacienteRef.get();
        if (!pacienteDoc.exists) {
            return res.status(404).json({ error: 'Paciente não encontrado.' });
        }

        const { dados, erro } = montarDadosAtendimento(req.body);
        if (erro) return res.status(400).json({ error: erro });

        const newDoc = pacienteRef.collection('atendimentos').doc();
        await newDoc.set({
            ...dados,
            // Autoria obrigatória (LGPD): quem registrou, quando
            createdAt:     new Date().toISOString(),
            createdBy:     req.user.uid,
            createdByName: req.user.name || req.user.email || ''
        });

        res.status(201).json({ message: 'Atendimento registrado com sucesso!', id: newDoc.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/ferida/pacientes/:id/atendimentos/:atendimentoId - Corrigir um
// atendimento já salvo. Nunca sobrescreve createdAt/createdBy (autoria
// original) — guarda updatedAt/updatedBy/updatedByName como rastro de quem
// editou depois, exigido pra dado de saúde (LGPD).
router.put('/pacientes/:id/atendimentos/:atendimentoId', verifyToken, checkPermission, apenasAmanda, async (req, res) => {
    try {
        const atendimentoRef = db.collection(COL_PACIENTES).doc(req.params.id)
            .collection('atendimentos').doc(req.params.atendimentoId);
        const doc = await atendimentoRef.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Atendimento não encontrado.' });
        }

        const { dados, erro } = montarDadosAtendimento(req.body);
        if (erro) return res.status(400).json({ error: erro });

        await atendimentoRef.update({
            ...dados,
            updatedAt:     new Date().toISOString(),
            updatedBy:     req.user.uid,
            updatedByName: req.user.name || req.user.email || ''
        });

        res.json({ message: 'Atendimento atualizado com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==========================================
// LEITURA DA FICHA PREENCHIDA (OCR local em Python)
// ==========================================
// Proxy para o serviço leitor-ficha (Flask + EasyOCR) que roda
// localmente — as imagens do paciente não saem da infraestrutura.
// Princípio LGPD do projeto: "leitura prepara, humano confirma".
// Ver /leitor-ficha/README.md para instalar e rodar o serviço.

const LEITOR_URL = process.env.LEITOR_FICHA_URL || 'http://127.0.0.1:5001';

// POST /api/ferida/ler-ficha - Lê a ficha de papel (frente/verso) via OCR
router.post('/ler-ficha', verifyToken, checkPermission, async (req, res) => {
    try {
        const { imagens } = req.body;
        if (!Array.isArray(imagens) || imagens.length < 1 || imagens.length > 2) {
            return res.status(400).json({ error: 'Envie 1 ou 2 imagens (frente e verso da ficha).' });
        }
        for (const img of imagens) {
            if (typeof img !== 'string' || !img.startsWith('data:image/') || img.length > MAX_IMG_BASE64 * 2) {
                return res.status(400).json({ error: 'Imagem inválida ou muito grande.' });
            }
        }

        let resposta;
        try {
            resposta = await fetch(`${LEITOR_URL}/ler-ficha`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imagens }),
                signal: AbortSignal.timeout(120000)
            });
        } catch (err) {
            return res.status(503).json({
                error: 'Serviço de leitura indisponível. Inicie o leitor-ficha (Python) — veja /leitor-ficha/README.md.'
            });
        }

        const corpo = await resposta.json().catch(() => ({}));
        if (!resposta.ok) {
            return res.status(resposta.status === 400 ? 400 : 422)
                .json({ error: corpo.error || 'Falha na leitura da ficha.' });
        }
        res.json(corpo);
    } catch (err) {
        res.status(500).json({ error: 'Falha na leitura: ' + err.message });
    }
});

// ==========================================
// FICHAS ANTIGAS (digitalização da ficha de papel)
// ==========================================

// Limite seguro: documento do Firestore aceita no máx. 1 MiB.
// A imagem chega como data URL base64 comprimida no navegador.
const MAX_IMG_BASE64 = 980000;

// GET /api/ferida/pacientes/:id/fichas-antigas - Listar (só metadados; a imagem é pesada)
router.get('/pacientes/:id/fichas-antigas', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_PACIENTES).doc(req.params.id)
            .collection('fichas_antigas')
            .orderBy('createdAt', 'asc')
            .select('nome', 'mimeType', 'tamanho', 'createdAt', 'createdBy', 'createdByName')
            .get();
        const fichas = [];
        snap.forEach(doc => fichas.push({ id: doc.id, ...doc.data() }));
        res.json(fichas);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/ferida/pacientes/:id/fichas-antigas/:fichaId - Buscar a imagem completa
router.get('/pacientes/:id/fichas-antigas/:fichaId', verifyToken, checkPermission, async (req, res) => {
    try {
        const doc = await db.collection(COL_PACIENTES).doc(req.params.id)
            .collection('fichas_antigas').doc(req.params.fichaId).get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Ficha antiga não encontrada.' });
        }
        res.json({ id: doc.id, ...doc.data() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/ferida/pacientes/:id/fichas-antigas - Anexar imagem da ficha de papel
router.post('/pacientes/:id/fichas-antigas', verifyToken, checkPermission, async (req, res) => {
    try {
        const pacienteRef = db.collection(COL_PACIENTES).doc(req.params.id);
        const pacienteDoc = await pacienteRef.get();
        if (!pacienteDoc.exists) {
            return res.status(404).json({ error: 'Paciente não encontrado.' });
        }

        const { imagem, nome } = req.body;
        if (!imagem || typeof imagem !== 'string' || !imagem.startsWith('data:image/')) {
            return res.status(400).json({ error: 'Envie uma imagem válida.' });
        }
        if (imagem.length > MAX_IMG_BASE64) {
            return res.status(400).json({ error: 'Imagem muito grande mesmo após compressão. Tente uma foto com resolução menor.' });
        }

        const mimeType = imagem.substring(5, imagem.indexOf(';'));
        const newDoc = pacienteRef.collection('fichas_antigas').doc();
        await newDoc.set({
            nome: String(nome || 'ficha-antiga').trim(),
            imagem,
            mimeType,
            tamanho: imagem.length,
            // Autoria obrigatória (LGPD)
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid,
            createdByName: req.user.name || req.user.email || ''
        });
        res.status(201).json({ message: 'Ficha antiga anexada com sucesso!', id: newDoc.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/ferida/pacientes/:id/fichas-antigas/:fichaId - Remover anexo equivocado
// Só Amanda/ADM excluem de fato; os demais geram solicitação pendente.
router.delete('/pacientes/:id/fichas-antigas/:fichaId', verifyToken, checkPermission, async (req, res) => {
    try {
        const fichaRef = db.collection(COL_PACIENTES).doc(req.params.id)
            .collection('fichas_antigas').doc(req.params.fichaId);

        if (!podeExcluirDireto(req)) {
            const fichaDoc = await fichaRef.get();
            const pacienteDoc = await db.collection(COL_PACIENTES).doc(req.params.id).get();
            await db.collection(COL_SOLICITACOES).add({
                tipo: 'excluir_ficha_antiga',
                pacienteId: req.params.id,
                pacienteNome: pacienteDoc.exists ? (pacienteDoc.data().nome || '') : '',
                fichaId: req.params.fichaId,
                fichaNome: fichaDoc.exists ? (fichaDoc.data().nome || '') : '',
                solicitadoPor: req.user.uid,
                solicitadoPorNome: req.user.name || req.user.email || '',
                solicitadoEm: new Date().toISOString(),
                status: 'pendente'
            });
            return res.status(201).json({ message: 'Solicitação de exclusão enviada. A enfermeira responsável vai aprovar.' });
        }

        await fichaRef.delete();
        res.json({ message: 'Ficha antiga removida com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/ferida/pacientes/:id/atendimentos/:atendimentoId - Remover registro equivocado
// Só Amanda/ADM excluem de fato; os demais geram solicitação pendente.
router.delete('/pacientes/:id/atendimentos/:atendimentoId', verifyToken, checkPermission, async (req, res) => {
    try {
        const atendimentoRef = db.collection(COL_PACIENTES).doc(req.params.id)
            .collection('atendimentos').doc(req.params.atendimentoId);

        if (!podeExcluirDireto(req)) {
            const atendimentoDoc = await atendimentoRef.get();
            const pacienteDoc = await db.collection(COL_PACIENTES).doc(req.params.id).get();
            await db.collection(COL_SOLICITACOES).add({
                tipo: 'excluir_atendimento',
                pacienteId: req.params.id,
                pacienteNome: pacienteDoc.exists ? (pacienteDoc.data().nome || '') : '',
                atendimentoId: req.params.atendimentoId,
                atendimentoData: atendimentoDoc.exists ? (atendimentoDoc.data().dataAtendimento || '') : '',
                solicitadoPor: req.user.uid,
                solicitadoPorNome: req.user.name || req.user.email || '',
                solicitadoEm: new Date().toISOString(),
                status: 'pendente'
            });
            return res.status(201).json({ message: 'Solicitação de exclusão enviada. A enfermeira responsável vai aprovar.' });
        }

        await atendimentoRef.delete();
        res.json({ message: 'Atendimento removido com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// SOLICITAÇÕES DE EXCLUSÃO (fila aprovada pela enfermeira responsável)
// ==========================================

// GET /api/ferida/solicitacoes?status=pendente|all - Listar solicitações (só Amanda/ADM)
router.get('/solicitacoes', verifyToken, checkPermission, apenasAmanda, async (req, res) => {
    try {
        const snap = await db.collection(COL_SOLICITACOES).get();
        let solicitacoes = [];
        snap.forEach(doc => solicitacoes.push({ id: doc.id, ...doc.data() }));

        const status = req.query.status || 'pendente';
        if (status !== 'all') {
            solicitacoes = solicitacoes.filter(s => s.status === status);
        }
        solicitacoes.sort((a, b) => (b.solicitadoEm || '').localeCompare(a.solicitadoEm || ''));

        res.json(solicitacoes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/ferida/solicitacoes/:id/aprovar - Executa a exclusão de fato (só Amanda/ADM)
router.put('/solicitacoes/:id/aprovar', verifyToken, checkPermission, apenasAmanda, async (req, res) => {
    try {
        const ref = db.collection(COL_SOLICITACOES).doc(req.params.id);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Solicitação não encontrada.' });
        }
        const s = doc.data();
        if (s.status !== 'pendente') {
            return res.status(400).json({ error: 'Essa solicitação já foi decidida.' });
        }

        if (s.tipo === 'excluir_paciente') {
            await excluirPacienteDefinitivo(s.pacienteId);
        } else if (s.tipo === 'excluir_ficha_antiga') {
            await db.collection(COL_PACIENTES).doc(s.pacienteId)
                .collection('fichas_antigas').doc(s.fichaId).delete();
        } else if (s.tipo === 'excluir_atendimento') {
            await db.collection(COL_PACIENTES).doc(s.pacienteId)
                .collection('atendimentos').doc(s.atendimentoId).delete();
        }

        await ref.update({
            status: 'aprovada',
            decididoPor: req.user.uid,
            decididoPorNome: req.user.name || req.user.email || '',
            decididoEm: new Date().toISOString()
        });
        res.json({ message: 'Solicitação aprovada e exclusão realizada.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/ferida/solicitacoes/:id/recusar - Recusa, sem excluir nada (só Amanda/ADM)
router.put('/solicitacoes/:id/recusar', verifyToken, checkPermission, apenasAmanda, async (req, res) => {
    try {
        const ref = db.collection(COL_SOLICITACOES).doc(req.params.id);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Solicitação não encontrada.' });
        }
        if (doc.data().status !== 'pendente') {
            return res.status(400).json({ error: 'Essa solicitação já foi decidida.' });
        }

        await ref.update({
            status: 'recusada',
            decididoPor: req.user.uid,
            decididoPorNome: req.user.name || req.user.email || '',
            decididoEm: new Date().toISOString()
        });
        res.json({ message: 'Solicitação recusada.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
