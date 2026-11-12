// ==========================================================================
// Matrículas do Edubox → módulo Matrículas do Órbita (09/11/2026).
// Roda quando alguém abre as Matrículas (semestre ≥ 2026.2), no máximo 1x a cada 10 min por módulo+semestre.
// Dados via relay /matriculas-edubox/lista (regras/relay/orbita-matriculas-edubox.js).
//
// NADA que muda o que aparece na tela é aplicado sozinho (pedido do usuário): cada diferença vira uma
// PENDÊNCIA (coleção matriculas_edubox_pendencias) que o pessoal das Matrículas aplica ou ignora.
// Automático só o que não aparece/não conflita: ligar o cadastro ao código da matrícula do Edubox
// (eduboxCodmat) e preencher telefone/cidade quando estão VAZIOS no Órbita.
//
// Situação que o Edubox indica (regras combinadas com o usuário):
//   calouro (ingresso no próprio semestre): forma "T" → Matrícula Nova - Transferência; já teve ingresso
//     antes → Matrícula Nova - Retorno; senão → Matrícula Nova.
//   veterano: Ativo → Rematrícula Assinada; Pendente → Não Assinou.
//   Cancelado com motivo "Transf. curso" → Mudança de Curso; calouro Cancelado sem nenhuma parcela paga →
//   1ª Evasão; Cancelado → Cancelou; Trancamento → Trancou; Desistência → Desistente; Transferência → Transferência.
// Diferença de situação só vira pendência quando muda o GRUPO (ex.: Não Assinou x Rematrícula Assinada,
// ativo x saiu). "Assinada" do Comercial, Pendência Financeira, tipo de evasão etc. são do Órbita e não geram
// pendência. Liga pelo eduboxCodmat; na 1ª vez por nome + curso (igual, ou um único nome parecido).
// ==========================================================================
const { db } = require('../firebase');
const { relay } = require('./edubox-relay');

const COL_ALUNOS = 'matriculas_alunos';
const COL_CONFIG = 'matriculas_config';
const COL_PEND = 'matriculas_edubox_pendencias';
const PRIMEIRO_SEMESTRE = '2026.2';   // 2026.2 também (pedido do usuário, 09/11/2026)
const INTERVALO_MS = 10 * 60 * 1000;
const QUEM = 'Edubox (automático)';

// sigla do curso no Edubox → nome do curso no cadastro do Órbita (coleção courses)
const CURSO_EDUBOX = {
    AGRO: 'AGRONEGÓCIO', AGRON: 'AGRONOMIA', ARQUIT: 'ARQUITETURA URB.', BIOMED: 'BIOMEDICINA', 'CI.CONT': 'CONTÁBEIS',
    DIR: 'DIREITO', ENFER: 'ENFERMAGEM', 'ENG.CIV': 'ENGENHARIA CÍVIL', FINAN: 'GESTÃO FINANCEIRA', FISIO: 'FISIOTERAPIA',
    'GEST.COM': 'GESTÃO COMERCIAL', LOG: 'LOGÍSTICA', 'MED.VET.': 'MEDICINA VETERINÁRIA', PED: 'PEDAGOGIA',
    PSICO: 'PSICOLOGIA', RH: 'RECURSOS HUMANOS'
};
// Último período de cada curso (maior período da grade/matriz das turmas no Edubox, 2027.1) — quem está nele
// recebe a marca "Formando" (campo formando, não muda a situação). Pedido do usuário (09/11/2026).
const ULTIMO_PERIODO = {
    AGRO: 6, AGRON: 10, ARQUIT: 10, BIOMED: 8, 'CI.CONT': 8, DIR: 10, ENFER: 10, 'ENG.CIV': 10, FINAN: 4, FISIO: 10,
    'GEST.COM': 4, LOG: 4, MED: 12, 'MED.VET.': 10, PED: 8, PSICO: 10, RH: 4
};
const ehFormando = (e) => !!ULTIMO_PERIODO[e.codcur] && parseInt(e.periodo, 10) === ULTIMO_PERIODO[e.codcur];
const SAIDAS = ['Cancelou', 'Trancou', '1ª Evasão', '2ª Evasão', 'Transferência', 'Mudança de Curso',
    'Desistente', 'Desistente — Calouro', 'Desistente — Veterano'];
const CALOUROS = ['Matrícula Nova', 'Matrícula Nova - Assinada', 'Matrícula Nova - Retorno', 'Matrícula Nova - Retorno Assinada',
    'Retorno', 'Matrícula Nova - Transferência', 'Matrícula Nova - Transferência Assinada'];

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const semestreEdubox = (semestre, modulo) => semestre.replace('.', modulo === 'medicina' ? '-' : '/');
const periodoDe = (p) => (p ? `${parseInt(p, 10)}º` : '');
const fone = (e) => e.celular || e.telefone || '';
const ehSaida = (s) => SAIDAS.includes(s);
// grupo pra comparar: só diferença de grupo vira pendência
function grupo(s) {
    if (ehSaida(s)) return 'saiu';
    if (CALOUROS.includes(s)) return 'calouro';
    if (s === 'Não Assinou') return 'nao-assinou';
    if (s === 'Rematrícula Assinada') return 'assinou';
    return 'outro'; // Pendência Financeira, Formando, Reprovado…: do Órbita
}

// o Edubox às vezes grava o ingresso com traço ("2027-1") mesmo na graduação (11/11/2026, Emilly — Agronomia)
const mesmoSemestre = (a, b) => String(a || '').replace(/[-/]/, '.') === String(b || '').replace(/[-/]/, '.');
function situacaoDoEdubox(e, semEdubox) {
    const calouro = mesmoSemestre(e.semestre_ingresso, semEdubox);
    const s = (e.situacao || '').toLowerCase();
    if (s.startsWith('cancel')) {
        if (/transf.*curso/i.test(e.motivo || '')) return 'Mudança de Curso';
        return calouro && !e.pagou ? '1ª Evasão' : 'Cancelou';
    }
    if (s.startsWith('tranc')) return 'Trancou';
    if (s.startsWith('desist')) return calouro ? 'Desistente — Calouro' : 'Desistente — Veterano';
    if (s.startsWith('transf')) return 'Transferência';
    if (calouro) {
        if ((e.forma_ingresso || '').toUpperCase() === 'T') return 'Matrícula Nova - Transferência';
        return e.ingresso_anterior ? 'Matrícula Nova - Retorno' : 'Matrícula Nova';
    }
    if (s === 'ativo') return 'Rematrícula Assinada';
    if (s === 'pendente') return 'Não Assinou';
    return null;
}

async function cursosDoOrbita() {
    const snap = await db.collection('courses').get();
    const porNome = new Map();
    snap.docs.forEach(d => { const x = d.data(); if (x.active !== false) porNome.set(norm(x.name), { id: d.id, nome: x.name }); });
    return porNome;
}

// Compara Edubox x Órbita de um módulo+semestre. Devolve as pendências (propostas) e o que é automático.
async function comparar({ modulo, semestre }) {
    const semEdubox = semestreEdubox(semestre, modulo);
    const [r, snap, cursos] = await Promise.all([
        relay(`/matriculas-edubox/lista?semestres=${encodeURIComponent(semEdubox)}`, { timeoutMs: 60000 }),
        db.collection(COL_ALUNOS).where('modulo', '==', modulo).where('semestre', '==', semestre).get(),
        cursosDoOrbita()
    ]);
    if (!r || !r.ok) throw new Error((r && r.erro) || 'Edubox não respondeu.');
    // nome social (config/nomes_sociais): o Edubox só tem o nome de registro — troca antes de comparar, senão
    // o aluno com nome social parece outra pessoa (ex.: VALDEIR → CLARK, 09/11/2026)
    const { aplicarNasLinhas } = require('./nome-social');
    const doEdubox = await aplicarNasLinhas((r.matriculas || []).filter(e => (modulo === 'medicina') === (e.codcur === 'MED')));
    const { nomeParecido } = require('../rotas/contratos')._interno;

    const docs = snap.docs.map(d => ({ id: d.id, ref: d.ref, d: d.data() }));
    const porCodmat = new Map(docs.filter(x => x.d.eduboxCodmat).map(x => [String(x.d.eduboxCodmat), x]));
    const usados = new Set([...porCodmat.values()].map(x => x.id));
    const propostas = [], automaticos = [];
    let ligadas = 0;

    // quem trocou de curso tem 2 matrículas no Edubox (a nova ativa e a antiga cancelada): a ATIVA liga
    // primeiro, e a antiga cancelada não vira "criar" nem move o cadastro (09/11/2026)
    const nomesAtivos = new Set(doEdubox.filter(e => { const s0 = situacaoDoEdubox(e, semEdubox); return s0 && !ehSaida(s0); }).map(e => norm(e.nome)));
    const ordenadas = [...doEdubox].sort((a, b) => (ehSaida(situacaoDoEdubox(a, semEdubox)) ? 1 : 0) - (ehSaida(situacaoDoEdubox(b, semEdubox)) ? 1 : 0));
    const antigaDeQuemTrocou = (e, sit) => ehSaida(sit) && nomesAtivos.has(norm(e.nome));

    for (const e of ordenadas) {
        const curso = modulo === 'medicina' ? { id: null, nome: 'Medicina' } : cursos.get(norm(CURSO_EDUBOX[e.codcur] || ''));
        const base = { nome: String(e.nome || '').trim().toUpperCase(), codmat: String(e.codmat), periodo: periodoDe(e.periodo) };
        if (!curso) { propostas.push({ ...base, chave: `conf_${e.codmat}`, tipo: 'conferir', curso: e.codcur, descricao: `Curso "${e.codcur}" do Edubox não existe no Órbita` }); continue; }
        base.curso = curso.nome;
        const sitEdubox = situacaoDoEdubox(e, semEdubox);
        let alvo = porCodmat.get(String(e.codmat));
        if (!alvo) {
            const livres = docs.filter(x => !usados.has(x.id) && !x.d.eduboxCodmat && (modulo === 'medicina' || x.d.cursoId === curso.id));
            const iguais = livres.filter(x => norm(x.d.nome) === norm(e.nome));
            const cand = iguais.length ? iguais : livres.filter(x => nomeParecido(x.d.nome, e.nome));
            if (cand.length > 1) {
                propostas.push({ ...base, chave: `conf_${e.codmat}`, tipo: 'conferir', descricao: `${cand.length} cadastros com nome igual/parecido em ${curso.nome} no Órbita — confira qual é o do Edubox (${sitEdubox || e.situacao})` });
                continue;
            }
            alvo = cand[0] || null;
            if (!alvo) {
                if (antigaDeQuemTrocou(e, sitEdubox)) continue;
                // mesmo aluno em OUTRO curso no Órbita: o Órbita acompanha o Edubox (pedido do usuário, 09/11/2026)
                const outro = docs.find(x => !usados.has(x.id) && norm(x.d.nome) === norm(e.nome));
                if (outro) {
                    usados.add(outro.id);
                    propostas.push({
                        ...base, chave: `curso_${outro.id}`, tipo: 'curso', alunoId: outro.id, de: outro.d.curso, para: curso.nome,
                        cursoIdPara: curso.id, periodoPara: base.periodo, curso: outro.d.curso,
                        descricao: `Curso no Órbita ${outro.d.curso} ${outro.d.periodo || ''} → no Edubox ${curso.nome} ${base.periodo}`
                    });
                    continue;
                }
            }
            if (alvo) { automaticos.push({ ref: alvo.ref, upd: { eduboxCodmat: String(e.codmat) } }); ligadas++; }
        }
        if (!alvo) {
            if (!sitEdubox || antigaDeQuemTrocou(e, sitEdubox)) continue;
            // aluno que JÁ tem matrícula no Órbita no semestre (em outro curso, já ligada): criar duplicaria a
            // contagem e o contrato do Comercial — só avisa pra conferir/cancelar a matrícula sobrando no Edubox
            const jaTem = docs.find(x => usados.has(x.id) && norm(x.d.nome) === norm(e.nome));
            // troca de curso de verdade (11/11/2026): a matrícula do Órbita aponta pra uma matrícula do Edubox que
            // foi cancelada/trancada ou nem existe mais, e esta (outro curso) está ativa → o Órbita acompanha o
            // Edubox: pendência de CURSO com botão Aplicar (muda o mesmo cadastro), não "conferir" à mão.
            const daAntiga = jaTem && jaTem.d.eduboxCodmat ? doEdubox.find(x => String(x.codmat) === String(jaTem.d.eduboxCodmat)) : null;
            const antigaSaiu = jaTem && (!daAntiga || ehSaida(situacaoDoEdubox(daAntiga, semEdubox) || ''));
            if (jaTem && antigaSaiu && !ehSaida(sitEdubox) && (jaTem.d.cursoId !== curso.id)) {
                const mudaSit = ehSaida(jaTem.d.situacao || '') || grupo(jaTem.d.situacao || '') !== grupo(sitEdubox);
                propostas.push({
                    ...base, chave: `curso_${jaTem.id}`, tipo: 'curso', alunoId: jaTem.id, de: jaTem.d.curso, para: curso.nome,
                    cursoIdPara: curso.id, periodoPara: base.periodo, curso: jaTem.d.curso, ...(mudaSit ? { situacaoPara: sitEdubox } : {}),
                    descricao: `Trocou de curso no Edubox: ${jaTem.d.curso} ${jaTem.d.periodo || ''} (${jaTem.d.situacao}) → ${curso.nome} ${base.periodo}${mudaSit ? ` (${sitEdubox})` : ''}`
                });
                continue;
            }
            if (jaTem) {
                propostas.push({ ...base, chave: `conf_${e.codmat}`, tipo: 'conferir', alunoId: jaTem.id,
                    descricao: `Já está no Órbita em ${jaTem.d.curso} ${jaTem.d.periodo || ''} (${jaTem.d.situacao}); o Edubox ainda tem também ${curso.nome} ${base.periodo} (${e.situacao}) — provável troca de curso: confira e cancele a matrícula que sobrou no Edubox` });
                continue;
            }
            propostas.push({
                ...base, chave: `criar_${e.codmat}`, tipo: 'criar', para: sitEdubox,
                descricao: `Está no Edubox e não no Órbita — criar como "${sitEdubox}"`,
                dados: {
                    modulo, cursoId: curso.id, curso: curso.nome, periodo: base.periodo, nome: base.nome,
                    cidade: (e.cidade || '').toUpperCase(), telefone: fone(e), vencimentoBoleto: null, situacao: sitEdubox,
                    planoConfissao: 'Não', observacoes: '', semestre, indicadoPorAlunoId: null, indicadoPorNome: null, formando: ehFormando(e),
                    menor18: false, eduboxCodmat: String(e.codmat), origem: 'edubox'
                }
            });
            continue;
        }
        usados.add(alvo.id);
        // automático: só preenche o que está vazio
        const auto = {};
        if (!alvo.d.telefone && fone(e)) auto.telefone = fone(e);
        if (!alvo.d.cidade && e.cidade) auto.cidade = e.cidade.toUpperCase();
        if (Object.keys(auto).length) automaticos.push({ ref: alvo.ref, upd: auto, alvo });
        // situação: só quando muda o grupo
        const atual = alvo.d.situacao || '';
        if (sitEdubox && grupo(sitEdubox) !== grupo(atual) && grupo(atual) !== 'outro') {
            const voltou = grupo(atual) === 'saiu';   // Órbita diz que saiu, Edubox diz que está ativo: só conferir
            propostas.push({
                ...base, chave: `sit_${alvo.id}`, tipo: voltou ? 'conferir' : 'situacao', alunoId: alvo.id, de: atual, para: sitEdubox,
                curso: alvo.d.curso, descricao: voltou
                    ? `No Órbita está "${atual}", mas no Edubox a matrícula está ${e.situacao}`
                    : `Situação no Órbita "${atual}" → pelo Edubox "${sitEdubox}"`
            });
        }
        if (ehFormando(e) && !alvo.d.formando && !ehSaida(atual)) {
            propostas.push({ ...base, chave: `form_${alvo.id}`, tipo: 'formando', alunoId: alvo.id, para: 'formando', curso: alvo.d.curso, descricao: `Está no último período do curso (${base.periodo}) — marcar como Formando` });
        }
        if (base.periodo && alvo.d.periodo && alvo.d.periodo !== 'DP' && alvo.d.periodo !== base.periodo) {
            propostas.push({ ...base, chave: `per_${alvo.id}`, tipo: 'periodo', alunoId: alvo.id, de: alvo.d.periodo, para: base.periodo, curso: alvo.d.curso, descricao: `Período no Órbita ${alvo.d.periodo} → no Edubox ${base.periodo}` });
        }
    }
    const contNome = {};
    docs.forEach(x => { if (x.d.outraPessoa) return; const k = norm(x.d.nome); contNome[k] = (contNome[k] || 0) + 1; });
    const duplicadas = Object.values(contNome).filter(v => v > 1).length;
    const soNoOrbita = docs.filter(x => !usados.has(x.id) && !x.d.eduboxCodmat).map(x => `${x.d.nome} — ${x.d.curso} ${x.d.periodo || ''} — ${x.d.situacao}`);
    return { propostas, automaticos, ligadas, soNoOrbita, duplicadas, totalEdubox: doEdubox.length, totalOrbita: docs.length };
}

const idPend = (modulo, semestre, chave) => `${modulo}_${semestre.replace('.', '_')}_${chave}`;
const assinatura = (p) => `${p.tipo}|${p.de || ''}|${p.para || ''}|${p.descricao || ''}`;

// Grava as pendências: novas ficam "pendente"; já aplicadas/ignoradas com a mesma diferença continuam como
// estão; pendente que deixou de existir (alguém acertou) sai da lista.
async function sincronizar({ modulo, semestre }) {
    const c = await comparar({ modulo, semestre });
    const agora = new Date().toISOString();
    for (const a of c.automaticos) await a.ref.update({ ...a.upd, updatedAt: agora });
    // telefone/cidade preenchidos também vão pro contrato do Comercial
    const { sincronizarDaMatricula } = require('../rotas/contratos')._interno;
    for (const a of c.automaticos.filter(x => x.alvo)) {
        try { await sincronizarDaMatricula(a.alvo.id, { ...a.alvo.d, ...a.upd }, QUEM, false); } catch (err) { console.error('[matriculas-edubox] contrato:', err.message); }
    }
    const exist = await db.collection(COL_PEND).where('modulo', '==', modulo).where('semestre', '==', semestre).get();
    const antes = new Map(exist.docs.map(d => [d.id, d]));
    const agoraIds = new Set();
    for (const p of c.propostas) {
        const id = idPend(modulo, semestre, p.chave);
        agoraIds.add(id);
        const ant = antes.get(id);
        if (ant && ant.data().assinatura === assinatura(p) && ant.data().status !== 'pendente') continue;
        if (ant && ant.data().assinatura === assinatura(p)) { await ant.ref.update({ vistaEm: agora }); continue; }
        await db.collection(COL_PEND).doc(id).set({ ...p, modulo, semestre, assinatura: assinatura(p), status: 'pendente', criadaEm: agora, vistaEm: agora });
    }
    for (const [id, d] of antes) if (!agoraIds.has(id) && d.data().status === 'pendente') await d.ref.delete();
    // Matrícula NOVA sem conflito entra sozinha (12/11/2026, pedido do usuário): pendência "criar" de calouro
    // (Matrícula Nova / Retorno / Transferência) é aplicada na hora — cria o cadastro e o contrato do Comercial.
    // Conflito (nome repetido, troca de curso, situação diferente) continua pendente pra Lisa decidir.
    let novasAutomaticas = 0;
    const { normalizarPeriodo, normalizarDesistente } = require('../rotas/matriculas')._normalizar || {};
    if (normalizarPeriodo && normalizarDesistente) {
        for (const p of c.propostas.filter(x => x.tipo === 'criar' && CALOUROS.includes(x.para))) {
            const id = idPend(modulo, semestre, p.chave);
            const doc = await db.collection(COL_PEND).doc(id).get();
            if (!doc.exists || doc.data().status !== 'pendente') continue;
            try { await resolverPendencia({ id, acao: 'aplicar', quem: QUEM, normalizarPeriodo, normalizarDesistente }); novasAutomaticas++; }
            catch (err) { console.error('[matriculas-edubox] matrícula nova automática:', p.nome, err.message); }
        }
    }
    return {
        novasAutomaticas,
        pendentes: c.propostas.filter(p => !(p.tipo === 'criar' && CALOUROS.includes(p.para))).filter(p => { const a = antes.get(idPend(modulo, semestre, p.chave)); return !a || a.data().assinatura !== assinatura(p) || a.data().status === 'pendente'; }).length,
        ligadas: c.ligadas, automaticos: c.automaticos.length, soNoOrbita: c.soNoOrbita.length, duplicadas: c.duplicadas, listaSoNoOrbita: c.soNoOrbita.slice(0, 300),
        totalEdubox: c.totalEdubox, totalOrbita: c.totalOrbita
    };
}

// Ao abrir a tela: no máximo 1x a cada 10 min por módulo+semestre (forcar ignora o intervalo).
async function sincronizarSeNecessario({ modulo, semestre, forcar = false }) {
    if (!semestre || semestre < PRIMEIRO_SEMESTRE) return { pulou: `semestre anterior a ${PRIMEIRO_SEMESTRE}` };
    const ref = db.collection(COL_CONFIG).doc(`edubox_${modulo}_${semestre.replace('.', '_')}`);
    const agora = Date.now();
    const lock = await db.runTransaction(async (t) => {
        const d = (await t.get(ref)).data() || {};
        const ultima = d.ultimaEm ? Date.parse(d.ultimaEm) : 0;
        const rodando = d.iniciadaEm && agora - Date.parse(d.iniciadaEm) < 3 * 60 * 1000;
        if (rodando || (!forcar && agora - ultima < INTERVALO_MS)) return { pegou: false, d };
        t.set(ref, { iniciadaEm: new Date(agora).toISOString() }, { merge: true });
        return { pegou: true };
    });
    let resumo, ultimaEm;
    if (lock.pegou) {
        try {
            resumo = await sincronizar({ modulo, semestre });
            ultimaEm = new Date().toISOString();
            await ref.set({ ultimaEm, iniciadaEm: null, resumo }, { merge: true });
        } catch (err) {
            await ref.set({ iniciadaEm: null, ultimoErro: err.message, ultimoErroEm: new Date().toISOString() }, { merge: true });
            throw err;
        }
    } else { resumo = lock.d.resumo || null; ultimaEm = lock.d.ultimaEm || null; }
    // nº de pendências sempre do momento (podem ter sido resolvidas depois da última sincronização)
    const pend = await db.collection(COL_PEND).where('modulo', '==', modulo).where('semestre', '==', semestre).where('status', '==', 'pendente').get();
    return { ultimaEm, resumo, pendentes: pend.size, rodou: lock.pegou };
}

async function listarPendencias({ modulo, semestre }) {
    const snap = await db.collection(COL_PEND).where('modulo', '==', modulo).where('semestre', '==', semestre).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data(), dados: undefined, assinatura: undefined }))
        .sort((a, b) => (a.status === 'pendente' ? 0 : 1) - (b.status === 'pendente' ? 0 : 1) || a.tipo.localeCompare(b.tipo) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

// Aplica ou ignora uma pendência. normalizar = funções da rota (período/desistente).
async function resolverPendencia({ id, acao, quem, normalizarPeriodo, normalizarDesistente }) {
    const ref = db.collection(COL_PEND).doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw Object.assign(new Error('Diferença não encontrada (já foi resolvida?).'), { status: 404 });
    const p = snap.data();
    if (p.status !== 'pendente') throw Object.assign(new Error('Essa diferença já foi resolvida.'), { status: 409 });
    const agora = new Date().toISOString();
    const { sincronizarDaMatricula } = require('../rotas/contratos')._interno;
    let alunoId = p.alunoId || null;
    if (acao === 'aplicar') {
        if (p.tipo === 'conferir') throw Object.assign(new Error('Diferença "pra conferir" não tem o que aplicar — corrija no cadastro e marque como vista.'), { status: 400 });
        if (p.tipo === 'criar') {
            const jaTem = await db.collection(COL_ALUNOS).where('eduboxCodmat', '==', p.codmat).limit(1).get();
            if (!jaTem.empty) throw Object.assign(new Error('Essa matrícula já foi criada.'), { status: 409 });
            // uma pessoa = uma matrícula por semestre
            const { matriculaDuplicada, mensagemDuplicada } = require('./matriculas-duplicidade');
            const dup = await matriculaDuplicada(p.dados.semestre, p.dados.nome);
            if (dup) throw Object.assign(new Error(mensagemDuplicada(dup)), { status: 409 });
            const dados = { ...p.dados, nomeNorm: require('./matriculas-duplicidade').nomeNorm(p.dados.nome), periodo: normalizarPeriodo(p.dados.periodo), situacao: normalizarDesistente(p.dados.situacao, normalizarPeriodo(p.dados.periodo)), createdAt: agora, createdBy: 'edubox', updatedAt: agora, updatedBy: `${quem} (Edubox)` };
            const nova = await db.collection(COL_ALUNOS).add(dados);
            alunoId = nova.id;
            try { await sincronizarDaMatricula(nova.id, dados, quem, true); } catch (err) { console.error('[matriculas-edubox] contrato:', err.message); }
        } else {
            const aRef = db.collection(COL_ALUNOS).doc(p.alunoId);
            const a = await aRef.get();
            if (!a.exists) throw Object.assign(new Error('O cadastro do aluno não existe mais.'), { status: 404 });
            const upd = { updatedAt: agora, updatedBy: `${quem} (Edubox)` };
            if (p.tipo === 'situacao') upd.situacao = normalizarDesistente(p.para, a.data().periodo);
            if (p.tipo === 'periodo') upd.periodo = normalizarPeriodo(p.para);
            if (p.tipo === 'formando') upd.formando = true;
            if (p.tipo === 'curso') {
                upd.cursoId = p.cursoIdPara; upd.curso = p.para; upd.eduboxCodmat = p.codmat;
                if (p.periodoPara) upd.periodo = normalizarPeriodo(p.periodoPara);
                if (p.situacaoPara) upd.situacao = normalizarDesistente(p.situacaoPara, upd.periodo || a.data().periodo);
            }
            await aRef.update(upd);
            try { await sincronizarDaMatricula(p.alunoId, { ...a.data(), ...upd }, quem, p.tipo === 'situacao' || !!upd.situacao); } catch (err) { console.error('[matriculas-edubox] contrato:', err.message); }
        }
    }
    await ref.update({ status: acao === 'aplicar' ? 'aplicada' : 'ignorada', resolvidaPor: quem, resolvidaEm: agora, alunoId });
    return { ok: true, status: acao === 'aplicar' ? 'aplicada' : 'ignorada', alunoId };
}

module.exports = { ULTIMO_PERIODO, comparar, sincronizar, sincronizarSeNecessario, listarPendencias, resolverPendencia, situacaoDoEdubox, CURSO_EDUBOX, PRIMEIRO_SEMESTRE };
