const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('cobranca');

const COL_PARCELAS = 'financeiro_cobranca_parcelas';
const COL_ACOES = 'financeiro_cobranca_acoes';
const COL_HISTORICO = 'financeiro_cobranca_historico_mensal';

const SITUACOES_VALIDAS = ['Ativo', 'Trancamento', 'Desistência', 'Concluído', 'Cancelado', 'Pendente'];

function normalizarCpf(v) {
    const digitos = (v || '').toString().replace(/\D/g, '');
    return digitos.length === 11 ? digitos : null;
}

function normalizarTexto(v) {
    return (v || '').toString().trim();
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

// Janeiro-Junho = ".1", Julho-Dezembro = ".2" do mesmo ano — vale pra
// qualquer ano (dívida antiga inclusive), a pedido do usuário. Só usado como
// sugestão automática no cadastro manual — o campo semestre é editável,
// porque negociação pode mudar em qual período uma dívida antiga é cobrada.
function calcularSemestre(vencimentoISO) {
    const [ano, mes] = (vencimentoISO || '').split('-');
    if (!ano || !mes) return null;
    return `${ano}/${Number(mes) <= 6 ? 1 : 2}`;
}

// A própria planilha do financeiro já marca, pelo campo "Plano", quem está
// com a dívida encaminhada à advocacia ou em débito judicial — é a mesma
// fonte usada pra seedar as ações em `financeiro_cobranca_acoes` na
// importação. Judicial é "mais grave" que advocacia simples pra fins de
// exibição quando o aluno tem parcelas com os dois planos.
function classificarJuridico(plano) {
    if (plano === 'DÉBITO JUDICIAL') return 'judicial';
    if (plano === 'ADVOGADO FATEC') return 'advogado';
    return null;
}

// Deriva o modelo (Bacharelado/Licenciatura/Tecnólogo) direto do texto do
// curso — não depende do campo `modelo` gravado na importação, então
// funciona igual pra parcela cadastrada manualmente (onde ninguém preenche
// esse campo à parte).
function classificarModelo(curso) {
    const c = (curso || '').toUpperCase();
    if (c.startsWith('BACHARELADO EM')) return 'Bacharelado';
    if (c.startsWith('LICENCIATURA EM')) return 'Licenciatura';
    if (c.startsWith('SUPERIOR DE TECNOLOGIA EM') || c.startsWith('TECNÓLOGO EM')) return 'Tecnólogo';
    return 'Outro';
}

function diasAtraso(vencimentoISO) {
    const venc = new Date(`${vencimentoISO}T00:00:00`);
    return Math.max(0, Math.floor((Date.now() - venc.getTime()) / 86400000));
}

// Toda leitura do módulo parte daqui — a coleção é pequena (pouco mais de
// mil parcelas, ~300 alunos), então trazer tudo e filtrar/agrupar em
// memória evita depender de índice composto novo no Firestore (mesmo
// padrão do módulo Orçamento). Quando dá pra restringir por um único campo
// de igualdade (curso OU semestre) já filtra na própria query, pra não
// trazer o que não vai ser usado.
async function buscarParcelas({ curso, semestre } = {}) {
    let query = db.collection(COL_PARCELAS);
    if (curso) query = query.where('curso', '==', curso);
    else if (semestre) query = query.where('semestre', '==', semestre);

    const snap = await query.get();
    let parcelas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (curso && semestre) parcelas = parcelas.filter(p => p.semestre === semestre);
    return parcelas;
}

// Agrupa parcelas em aberto por aluno (cpf) + curso — o cartão de
// inadimplência é por aluno, não por parcela avulsa; "dias de atraso" e
// "valor total" refletem a pior/soma das parcelas dele naquele curso.
function agruparPorAluno(parcelas) {
    const grupos = new Map();
    for (const p of parcelas) {
        const chave = `${p.cpf || 'semcpf:' + p.nome}|${p.curso}`;
        if (!grupos.has(chave)) {
            grupos.set(chave, {
                cpf: p.cpf, nome: p.nome, celular: p.celular, curso: p.curso,
                parcelas: 0, valorTotal: 0, vencimentoMaisAntigo: p.vencimento,
                situacoes: new Set(), planos: new Set(), parcelaIds: []
            });
        }
        const g = grupos.get(chave);
        g.parcelas++;
        g.valorTotal += round2(p.valorAPagar - p.valorPago);
        if (p.vencimento < g.vencimentoMaisAntigo) g.vencimentoMaisAntigo = p.vencimento;
        g.situacoes.add(p.situacao);
        if (p.plano) g.planos.add(p.plano);
        g.parcelaIds.push(p.id);
    }
    const PRIORIDADE_JURIDICO = { judicial: 2, advogado: 1 };
    return [...grupos.values()].map(g => {
        let situacaoJuridica = null;
        for (const plano of g.planos) {
            const classe = classificarJuridico(plano);
            if (classe && (!situacaoJuridica || PRIORIDADE_JURIDICO[classe] > PRIORIDADE_JURIDICO[situacaoJuridica])) situacaoJuridica = classe;
        }
        return {
            ...g,
            valorTotal: round2(g.valorTotal),
            situacoes: [...g.situacoes],
            planos: [...g.planos],
            situacaoJuridica,
            modelo: classificarModelo(g.curso),
            diasAtraso: diasAtraso(g.vencimentoMaisAntigo)
        };
    });
}

function faixaDoGrupo(dias) {
    if (dias > 90) return '90+';
    if (dias > 60) return '61-90';
    if (dias > 30) return '31-60';
    return '1-30';
}

// ==========================================
// RESUMO — cards do topo (total de alunos, valor, distribuição por faixa e
// por situação de matrícula)
// ==========================================
router.get('/resumo', verifyToken, checkPermission, async (req, res) => {
    try {
        const { curso, semestre, modelo } = req.query;
        let parcelas = (await buscarParcelas({ curso, semestre })).filter(p => !p.quitado);
        if (modelo) parcelas = parcelas.filter(p => classificarModelo(p.curso) === modelo);
        const grupos = agruparPorAluno(parcelas);

        const porFaixa = { '1-30': { alunos: 0, valor: 0 }, '31-60': { alunos: 0, valor: 0 }, '61-90': { alunos: 0, valor: 0 }, '90+': { alunos: 0, valor: 0 } };
        const porSituacao = {};
        const porJuridico = { advogado: 0, judicial: 0 };
        const porModelo = {};
        for (const g of grupos) {
            porModelo[g.modelo] = (porModelo[g.modelo] || 0) + 1;
            const faixa = faixaDoGrupo(g.diasAtraso);
            porFaixa[faixa].alunos++;
            porFaixa[faixa].valor += g.valorTotal;
            for (const s of g.situacoes) porSituacao[s] = (porSituacao[s] || 0) + 1;
            if (g.situacaoJuridica) porJuridico[g.situacaoJuridica]++;
        }

        res.json({
            alunos: grupos.length,
            parcelas: parcelas.length,
            valor_total: round2(grupos.reduce((s, g) => s + g.valorTotal, 0)),
            alunos_1_30: porFaixa['1-30'].alunos, valor_1_30: round2(porFaixa['1-30'].valor),
            alunos_31_60: porFaixa['31-60'].alunos, valor_31_60: round2(porFaixa['31-60'].valor),
            alunos_61_90: porFaixa['61-90'].alunos, valor_61_90: round2(porFaixa['61-90'].valor),
            alunos_90_mais: porFaixa['90+'].alunos, valor_90_mais: round2(porFaixa['90+'].valor),
            por_situacao: porSituacao,
            alunos_advogado: porJuridico.advogado,
            alunos_judicial: porJuridico.judicial,
            por_modelo: porModelo
        });
    } catch (err) {
        console.error('[cobranca] Erro ao buscar resumo:', err);
        res.status(500).json({ error: 'Não foi possível carregar o resumo de inadimplência.' });
    }
});

// ==========================================
// FILTROS — cursos, semestres e situações com pelo menos 1 parcela em aberto
// ==========================================
router.get('/filtros', verifyToken, checkPermission, async (req, res) => {
    try {
        const parcelas = (await buscarParcelas()).filter(p => !p.quitado);
        const cursos = [...new Set(parcelas.map(p => p.curso))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        const semestres = [...new Set(parcelas.map(p => p.semestre))].filter(Boolean).sort().reverse();
        const modelos = [...new Set(parcelas.map(p => classificarModelo(p.curso)))].sort();
        res.json({ cursos, semestres, situacoes: SITUACOES_VALIDAS, situacoesJuridicas: ['advogado', 'judicial'], modelos });
    } catch (err) {
        console.error('[cobranca] Erro ao listar filtros:', err);
        res.status(500).json({ error: 'Não foi possível carregar os filtros.' });
    }
});

// ==========================================
// PARCELAS — lista de alunos inadimplentes (agrupado por aluno+curso), com
// a ação de cobrança mais recente já registrada. "Todos os cursos" + "Todos
// os semestres" também é um filtro válido — mostra tudo (coleção pequena,
// ~1100 parcelas, sem o problema de pool de conexão externo que o Edubox
// tinha; diferente de Matrículas/Orçamento, que ainda travam sem recorte).
// ==========================================
router.get('/parcelas', verifyToken, checkPermission, async (req, res) => {
    const { curso, semestre, situacao, juridico, modelo, faixa, busca } = req.query;
    try {
        let parcelas = (await buscarParcelas({ curso, semestre })).filter(p => !p.quitado);
        if (situacao) parcelas = parcelas.filter(p => p.situacao === situacao);
        if (modelo) parcelas = parcelas.filter(p => classificarModelo(p.curso) === modelo);

        let grupos = agruparPorAluno(parcelas);
        if (juridico) grupos = grupos.filter(g => g.situacaoJuridica === juridico);
        if (faixa) grupos = grupos.filter(g => faixaDoGrupo(g.diasAtraso) === faixa);
        if (busca) {
            const termo = busca.toLowerCase();
            grupos = grupos.filter(g => g.nome.toLowerCase().includes(termo));
        }
        grupos.sort((a, b) => b.diasAtraso - a.diasAtraso);

        // Devolve a lista inteira de uma vez (não pagina no servidor): o
        // "Carregar mais" do front é só revelar mais linhas do que já veio
        // aqui, sem bater no Firestore de novo — muito mais barato do que
        // reler a coleção inteira a cada página clicada.
        const cpfs = [...new Set(grupos.map(g => g.cpf).filter(Boolean))];
        const acoesPorCpf = new Map();
        // Operador "in" do Firestore aceita no máximo 30 valores por
        // consulta — divide em lotes; ainda assim é UMA leitura por lote por
        // busca (não por página), bem mais barato que o esquema antigo.
        for (let i = 0; i < cpfs.length; i += 30) {
            const lote = cpfs.slice(i, i + 30);
            const snap = await db.collection(COL_ACOES).where('cpf', 'in', lote).get();
            snap.forEach(doc => {
                const dados = doc.data();
                const atual = acoesPorCpf.get(dados.cpf);
                const criadoEmMs = dados.criadoEm && dados.criadoEm.toMillis ? dados.criadoEm.toMillis() : 0;
                const atualMs = atual && atual.criadoEm && atual.criadoEm.toMillis ? atual.criadoEm.toMillis() : -1;
                if (!atual || criadoEmMs > atualMs) acoesPorCpf.set(dados.cpf, dados);
            });
        }

        res.json(grupos.map(g => ({ ...g, ultimaAcao: g.cpf ? (acoesPorCpf.get(g.cpf) || null) : null })));
    } catch (err) {
        console.error('[cobranca] Erro ao listar parcelas:', err);
        res.status(500).json({ error: 'Não foi possível carregar a lista de inadimplência.' });
    }
});

// ==========================================
// EDITAR ALUNO — nome/CPF/celular/situação são do ALUNO, não de uma parcela
// só: aplica em todas as parcelas dele (todos os cursos, não só o da linha
// clicada — é a mesma pessoa). Mudança de situação vira um registro
// automático no histórico de ações (tipo `mudanca_situacao`), pra uma
// negociação/mudança de status sempre deixar rastro, mesmo se ninguém
// registrar uma ação manual pra isso.
// ==========================================
router.put('/alunos/:cpf', verifyToken, checkPermission, async (req, res) => {
    try {
        const cpfAtual = normalizarCpf(req.params.cpf);
        if (!cpfAtual) return res.status(400).json({ error: 'CPF inválido.' });

        const snap = await db.collection(COL_PARCELAS).where('cpf', '==', cpfAtual).get();
        if (snap.empty) return res.status(404).json({ error: 'Nenhuma parcela encontrada para este aluno.' });

        const update = { atualizadoEm: new Date().toISOString(), atualizadoPor: req.user.uid };
        if (req.body.nome !== undefined) {
            const nome = normalizarTexto(req.body.nome);
            if (!nome) return res.status(400).json({ error: 'Informe o nome do aluno.' });
            update.nome = nome;
        }
        if (req.body.celular !== undefined) update.celular = normalizarTexto(req.body.celular);

        let situacaoAnterior = null;
        if (req.body.situacao !== undefined) {
            if (!SITUACOES_VALIDAS.includes(req.body.situacao)) return res.status(400).json({ error: 'Situação de matrícula inválida.' });
            situacaoAnterior = snap.docs[0].data().situacao;
            update.situacao = req.body.situacao;
        }

        let cpfNovo = null;
        if (req.body.cpf !== undefined) {
            cpfNovo = normalizarCpf(req.body.cpf);
            if (req.body.cpf && !cpfNovo) return res.status(400).json({ error: 'CPF inválido.' });
            if (cpfNovo && cpfNovo !== cpfAtual) update.cpf = cpfNovo;
        }

        const chunks = [];
        for (let i = 0; i < snap.docs.length; i += 400) chunks.push(snap.docs.slice(i, i + 400));
        for (const chunk of chunks) {
            const batch = db.batch();
            chunk.forEach(doc => batch.update(doc.ref, update));
            await batch.commit();
        }

        // CPF corrigido: o histórico de ações precisa seguir junto, senão
        // fica "órfão" ligado ao CPF antigo (errado).
        if (update.cpf) {
            const acoesSnap = await db.collection(COL_ACOES).where('cpf', '==', cpfAtual).get();
            const acoesChunks = [];
            for (let i = 0; i < acoesSnap.docs.length; i += 400) acoesChunks.push(acoesSnap.docs.slice(i, i + 400));
            for (const chunk of acoesChunks) {
                const batch = db.batch();
                chunk.forEach(doc => batch.update(doc.ref, { cpf: update.cpf }));
                await batch.commit();
            }
        }

        // Mudança de situação sempre vira rastro no histórico — negociação ou
        // troca de status não pode passar batido sem registro.
        if (update.situacao && update.situacao !== situacaoAnterior) {
            await db.collection(COL_ACOES).add({
                cpf: update.cpf || cpfAtual,
                nomeAluno: update.nome || snap.docs[0].data().nome,
                tipo: 'mudanca_situacao',
                escritorio: '',
                observacoes: `Situação alterada de "${situacaoAnterior}" para "${update.situacao}".`,
                origem: 'sistema',
                criadoPor: req.user.uid,
                criadoPorNome: req.user.name || req.user.email || '',
                criadoEm: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        res.json({ message: 'Dados do aluno atualizados.', parcelasAtualizadas: snap.docs.length });
    } catch (err) {
        console.error('[cobranca] Erro ao editar aluno:', err);
        res.status(500).json({ error: 'Não foi possível atualizar os dados do aluno.' });
    }
});

// Busca o detalhe completo de parcelas específicas por id — usado quando a
// usuária clica em "editar" numa linha da lista (que é agrupada por
// aluno+curso, então pode representar mais de uma parcela).
router.get('/parcelas/detalhe', verifyToken, checkPermission, async (req, res) => {
    try {
        const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
        if (!ids.length) return res.json([]);
        const docs = await Promise.all(ids.map(id => db.collection(COL_PARCELAS).doc(id).get()));
        res.json(docs.filter(d => d.exists).map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        console.error('[cobranca] Erro ao buscar detalhe de parcelas:', err);
        res.status(500).json({ error: 'Não foi possível carregar as parcelas.' });
    }
});

// ==========================================
// CADASTRO MANUAL DE CASOS — a partir da importação da planilha (2026-09),
// o financeiro passa a registrar/editar os casos direto por aqui, sem
// depender de reimportação.
// ==========================================
router.post('/parcelas', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = normalizarTexto(req.body.nome);
        const curso = normalizarTexto(req.body.curso);
        const vencimento = normalizarTexto(req.body.vencimento);
        if (!nome) return res.status(400).json({ error: 'Informe o nome do aluno.' });
        if (!curso) return res.status(400).json({ error: 'Informe o curso.' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) return res.status(400).json({ error: 'Informe a data de vencimento (AAAA-MM-DD).' });
        if (!SITUACOES_VALIDAS.includes(req.body.situacao)) return res.status(400).json({ error: 'Situação de matrícula inválida.' });

        const valorBruto = round2(req.body.valorBruto);
        const descontoCadastro = round2(req.body.descontoCadastro);
        const desconto = round2(req.body.desconto);
        const multa = round2(req.body.multa);
        const juros = round2(req.body.juros);
        const valorAPagarInformado = req.body.valorAPagar !== undefined && req.body.valorAPagar !== '';
        const valorAPagar = valorAPagarInformado ? round2(req.body.valorAPagar) : round2(valorBruto - descontoCadastro - desconto + multa + juros);
        const valorPago = round2(req.body.valorPago);

        const doc = {
            nome, curso,
            cpf: normalizarCpf(req.body.cpf),
            celular: normalizarTexto(req.body.celular),
            situacao: req.body.situacao,
            plano: normalizarTexto(req.body.plano),
            vencimento,
            semestre: normalizarTexto(req.body.semestre) || calcularSemestre(vencimento),
            valorBruto, descontoCadastro, desconto, multa, juros, valorAPagar, valorPago,
            quitado: (valorAPagar - valorPago) <= 0.01,
            origem: 'manual',
            criadoEm: new Date().toISOString(),
            criadoPor: req.user.uid,
            atualizadoEm: new Date().toISOString(),
            atualizadoPor: req.user.uid
        };
        const ref = await db.collection(COL_PARCELAS).add(doc);
        res.status(201).json({ id: ref.id, ...doc });
    } catch (err) {
        console.error('[cobranca] Erro ao cadastrar parcela:', err);
        res.status(500).json({ error: 'Não foi possível cadastrar o caso.' });
    }
});

router.put('/parcelas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_PARCELAS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Parcela não encontrada.' });
        const atual = snap.data();
        const update = { atualizadoEm: new Date().toISOString(), atualizadoPor: req.user.uid };

        if (req.body.nome !== undefined) update.nome = normalizarTexto(req.body.nome);
        if (req.body.curso !== undefined) update.curso = normalizarTexto(req.body.curso);
        if (req.body.cpf !== undefined) update.cpf = normalizarCpf(req.body.cpf);
        if (req.body.celular !== undefined) update.celular = normalizarTexto(req.body.celular);
        if (req.body.plano !== undefined) update.plano = normalizarTexto(req.body.plano);
        if (req.body.semestre !== undefined) update.semestre = normalizarTexto(req.body.semestre);
        if (req.body.situacao !== undefined) {
            if (!SITUACOES_VALIDAS.includes(req.body.situacao)) return res.status(400).json({ error: 'Situação de matrícula inválida.' });
            update.situacao = req.body.situacao;
        }
        if (req.body.vencimento !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.vencimento)) return res.status(400).json({ error: 'Data de vencimento inválida (AAAA-MM-DD).' });
            update.vencimento = req.body.vencimento;
        }
        ['valorBruto', 'descontoCadastro', 'desconto', 'multa', 'juros', 'valorAPagar', 'valorPago'].forEach(campo => {
            if (req.body[campo] !== undefined) update[campo] = round2(req.body[campo]);
        });

        const valorAPagarFinal = update.valorAPagar !== undefined ? update.valorAPagar : atual.valorAPagar;
        const valorPagoFinal = update.valorPago !== undefined ? update.valorPago : atual.valorPago;
        update.quitado = (valorAPagarFinal - valorPagoFinal) <= 0.01;

        await ref.update(update);
        res.json({ message: 'Caso atualizado.' });
    } catch (err) {
        console.error('[cobranca] Erro ao atualizar parcela:', err);
        res.status(500).json({ error: 'Não foi possível atualizar o caso.' });
    }
});

router.delete('/parcelas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        await db.collection(COL_PARCELAS).doc(req.params.id).delete();
        res.json({ message: 'Caso removido.' });
    } catch (err) {
        console.error('[cobranca] Erro ao remover parcela:', err);
        res.status(500).json({ error: 'Não foi possível remover o caso.' });
    }
});

// ==========================================
// AÇÕES DE COBRANÇA — contato, negociação, envio à advocacia, acordo
// judicial. Chave por CPF (não existe mais "codcli" do Edubox).
// ==========================================
router.get('/acoes/:cpf', verifyToken, checkPermission, async (req, res) => {
    try {
        const cpf = normalizarCpf(req.params.cpf);
        if (!cpf) return res.status(400).json({ error: 'CPF inválido.' });
        const snap = await db.collection(COL_ACOES)
            .where('cpf', '==', cpf)
            .orderBy('criadoEm', 'desc')
            .get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        console.error('[cobranca] Erro ao buscar histórico de ações:', err);
        res.status(500).json({ error: err.message });
    }
});

const TIPOS_VALIDOS = ['contato', 'negociacao', 'enviado_advocacia', 'acordo_judicial', 'quitado_manual', 'mudanca_situacao', 'outro'];

router.post('/acoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const { cpf, nomeAluno, tipo, escritorio, observacoes } = req.body;
        const cpfNorm = normalizarCpf(cpf);
        if (!cpfNorm) return res.status(400).json({ error: 'Informe o CPF do aluno.' });
        if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de ação inválido.' });

        const doc = {
            cpf: cpfNorm,
            nomeAluno: (nomeAluno || '').toString().trim(),
            tipo,
            escritorio: (escritorio || '').toString().trim(),
            observacoes: (observacoes || '').toString().trim(),
            origem: 'manual',
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || '',
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
        };
        const ref = await db.collection(COL_ACOES).add(doc);
        res.status(201).json({ id: ref.id, ...doc, criadoEm: new Date().toISOString() });
    } catch (err) {
        console.error('[cobranca] Erro ao registrar ação:', err);
        res.status(500).json({ error: err.message });
    }
});

// Excluir um registro do histórico (contato/negociação/etc. lançado errado).
// Sem confirmação extra aqui — a tela já confirma antes de chamar.
router.delete('/acoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        await db.collection(COL_ACOES).doc(req.params.id).delete();
        res.json({ message: 'Ação removida.' });
    } catch (err) {
        console.error('[cobranca] Erro ao excluir ação:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// IMPORTAR CSV — lista própria do financeiro de alunos já encaminhados à
// advocacia/em acordo judicial. Colunas esperadas: nome, cpf (opcional,
// usado pra achar o aluno já cadastrado em Cobrança), escritorio, tipo
// (opcional, default enviado_advocacia), observacoes.
// ==========================================
router.post('/acoes/importar-csv', verifyToken, checkPermission, async (req, res) => {
    try {
        const { records } = req.body;
        if (!Array.isArray(records) || !records.length) {
            return res.status(400).json({ error: 'Nenhum registro para importar.' });
        }

        const cpfs = [...new Set(records.map(r => normalizarCpf(r.cpf)).filter(Boolean))];
        const nomesPorCpf = new Map();
        for (let i = 0; i < cpfs.length; i += 30) {
            const lote = cpfs.slice(i, i + 30);
            const snap = await db.collection(COL_PARCELAS).where('cpf', 'in', lote).get();
            snap.forEach(doc => { const d = doc.data(); if (!nomesPorCpf.has(d.cpf)) nomesPorCpf.set(d.cpf, d.nome); });
        }

        const paraGravar = [];
        const naoEncontrados = [];
        for (const rec of records) {
            const nome = (rec.nome || '').toString().trim();
            if (!nome) continue;
            const cpfNorm = normalizarCpf(rec.cpf);
            const nomeConhecido = cpfNorm ? nomesPorCpf.get(cpfNorm) : null;
            if (cpfNorm && !nomeConhecido) naoEncontrados.push(nome);
            const tipo = ['enviado_advocacia', 'acordo_judicial'].includes(rec.tipo) ? rec.tipo : 'enviado_advocacia';
            paraGravar.push({
                cpf: cpfNorm,
                nomeAluno: nomeConhecido || nome,
                tipo,
                escritorio: (rec.escritorio || '').toString().trim(),
                observacoes: (rec.observacoes || '').toString().trim(),
                origem: 'csv',
                criadoPor: req.user.uid,
                criadoPorNome: req.user.name || req.user.email || '',
                criadoEm: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        const chunks = [];
        for (let i = 0; i < paraGravar.length; i += 400) chunks.push(paraGravar.slice(i, i + 400));
        for (const chunk of chunks) {
            const batch = db.batch();
            chunk.forEach(dados => batch.set(db.collection(COL_ACOES).doc(), dados));
            await batch.commit();
        }

        res.status(201).json({
            message: 'Importação concluída!',
            gravados: paraGravar.length,
            semCpfEncontrado: naoEncontrados
        });
    } catch (err) {
        console.error('[cobranca] Erro ao importar CSV:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// HISTÓRICO MENSAL — série jan-ago/2026 importada da planilha, pro gráfico
// de tendência do relatório (não recalculável a partir das parcelas atuais,
// porque reflete a situação de cada mês passado).
// ==========================================
router.get('/historico-mensal', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_HISTORICO).get();
        const registros = snap.docs.map(d => d.data());
        const ORDEM_MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
        registros.sort((a, b) => (a.ano - b.ano) || (ORDEM_MESES.indexOf(a.mes) - ORDEM_MESES.indexOf(b.mes)));
        res.json(registros);
    } catch (err) {
        console.error('[cobranca] Erro ao buscar histórico mensal:', err);
        res.status(500).json({ error: 'Não foi possível carregar o histórico mensal.' });
    }
});

module.exports = router;
