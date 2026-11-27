// ==========================================================================
// Agente do banco do AVA (Banco MED → banco de questões do AVA) — 25/11/2026.
// Roda no droplet do relay (DigitalOcean) como serviço systemd "orbita-ava-banco-agente", em /opt/orbita-sync,
// com TZ=America/Sao_Paulo — mesmo molde dos agentes do CADD e da Cobrança. Ver regras/regra_do_app.md, seção 8.
//
// O professor termina o trabalho dele no Órbita. Este agente leva para o AVA o que a fila marcou como pronto
// (src/utils/banco-med-ava-fila.js: parte do professor que cumpriu a cota, ou prova finalizada), importando no
// banco do questionário da prova (src/utils/ava-banco-importar.js), e grava o resultado em avaliacao.avaBanco.
// A secretaria acompanha na tela "Envio ao AVA" do Banco MED.
//
//  - A cada 15 min confere a fila (só abre o AVA se houver algo pronto).
//  - Botão "Enviar agora" do Órbita grava config/ava_banco_sync.pedidoEm → roda na hora, e tenta de novo
//    também o que estava em "conferir"/"erro" (na rodada automática, esses só voltam se a parte pronta mudar).
//  - A cada 5 min grava agenteVivoEm (a tela avisa se o agente estiver fora do ar).
//
// Uso manual (no droplet ou no computador do TI, com o .env):
//   node scripts/ava-banco-med-agente.js --uma-vez [--simular] [--so=<id da avaliação>] [--teste-cmid=<cmid>]
//   --simular      só confere curso, questionário e pasta; não importa e não grava nada no Órbita
//   --teste-cmid   importa no questionário indicado (ex.: II Semana Acadêmica) e NÃO grava no Órbita
//   --so-resultados  só lê e grava os resultados das provas (Aplicação de Provas), sem importar questão
//
// Credenciais no .env: AVA_URL, AVA_LOGIN_USUARIO, AVA_LOGIN_SENHA (+ Firebase). Log em scripts/logs/ (fora do git).
// ==========================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { db, admin } = require(path.join(__dirname, '..', 'src', 'firebase'));
const { situacaoDoSemestre, situacaoDaAvaliacao, semestreAtual, publicarNoBanco, COL_AV } = require(path.join(__dirname, '..', 'src', 'utils', 'banco-med-ava-fila'));
const { SessaoAva } = require(path.join(__dirname, '..', 'src', 'utils', 'ava-sessao'));
const { ImportadorBancoAva } = require(path.join(__dirname, '..', 'src', 'utils', 'ava-banco-importar'));
const { questionarioDaAplicacao, lerResultados, fechou: fechouQuiz } = require(path.join(__dirname, '..', 'src', 'utils', 'ava-resultados'));

const INTERVALO_MS = 15 * 60 * 1000;
const QUADRO_MS = 60 * 60 * 1000; // números do questionário (questões, notas) de cada prova: no máximo 1 leitura por hora
const PULSO_MS = 5 * 60 * 1000;
const pastaLog = path.join(__dirname, 'logs');
const arquivoLog = path.join(pastaLog, 'ava-banco-med-agente.log');
const cfg = db.collection('config').doc('ava_banco_sync');

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
const espera = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
    const linha = `[${new Date().toLocaleString('pt-BR')}] ${msg}`;
    console.log(linha);
    try {
        fs.mkdirSync(pastaLog, { recursive: true });
        if (fs.existsSync(arquivoLog) && fs.statSync(arquivoLog).size > 1024 * 1024) fs.writeFileSync(arquivoLog, '');
        fs.appendFileSync(arquivoLog, linha + '\n');
    } catch (e) { /* log é opcional */ }
}

// mesma parte pronta da última tentativa? (aí "conferir"/"erro" não repete na rodada automática)
const chaveTentativa = (ids) => ids.slice().sort().join(',');

// quadro do questionário no AVA, para a Joyce decidir pelo Órbita (25/11/2026)
const quadroDe = (r) => (r && r.resumo ? {
    'avaBanco.quadro': { cmid: r.cmid || null, quiz: r.quiz || '', curso: r.curso || '', naPasta: Number.isFinite(r.naPasta) ? r.naPasta : null, ...r.resumo, lidoEm: new Date().toISOString() }
} : {});
async function gravarQuadro(sit, r) {
    await db.collection(COL_AV).doc(sit.id).update(r.erro ? { 'avaBanco.quadro': { erro: r.erro, curso: r.curso || '', lidoEm: new Date().toISOString() } } : quadroDe(r));
}

async function gravarResultado(sit, r) {
    const ref = db.collection(COL_AV).doc(sit.id);
    const comum = { ...quadroDe(r),
        'avaBanco.em': r.em, 'avaBanco.msg': String(r.msg || '').slice(0, 500), 'avaBanco.curso': r.curso || '', 'avaBanco.cursoId': r.cursoId || null,
        'avaBanco.quiz': r.quiz || '', 'avaBanco.cmid': r.cmid || null, 'avaBanco.noAva': Number.isFinite(r.noAva) ? r.noAva : null, 'avaBanco.por': 'Agente automático',
        'avaBanco.historico': admin.firestore.FieldValue.arrayUnion({ em: r.em, status: r.status, qtd: (r.enviadas || sit.prontas).length, msg: String(r.msg || '').slice(0, 300), por: 'Agente automático' })
    };
    if (r.status === 'importada' || r.status === 'ja_estava') {
        await ref.update({ ...comum, 'avaBanco.status': 'ok', 'avaBanco.tentativa': null, 'avaBanco.enviadas': admin.firestore.FieldValue.arrayUnion(...r.enviadas) });
        await publicarNoBanco(r.enviadas, 'Envio ao AVA');
    } else {
        await ref.update({ ...comum, 'avaBanco.status': r.status, 'avaBanco.tentativa': chaveTentativa(sit.prontas) });
    }
}

// ---------- resultados das provas (25/11/2026) — tela "Resultados do AVA" da Aplicação de Provas ----------
// Lê de cada prova do calendário que já aconteceu: na rodada automática, nos 3 dias depois da prova, no máximo de
// 3 em 3 horas (e de novo se deu erro); com "Enviar agora"/--uma-vez, todas. Só depois que o questionário fecha.
const COL_RES = 'med_resultados_ava';
const RES_INTERVALO_MS = 3 * 60 * 60 * 1000;
async function resultadosAFazer(origem) {
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const snap = await db.collection('med_aplicacao_provas').where('semestre', '==', args.semestre || semestreAtual()).get();
    const provas = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.tipo === 'prova' && p.data && p.data <= hoje);
    const out = [];
    for (const p of provas) {
        if (origem !== 'automatica') { out.push(p); continue; }
        const r = (await db.collection(COL_RES).doc(p.id).get()).data();
        const dias = (Date.parse(hoje) - Date.parse(p.data)) / 86400000;
        const velho = !r || !r.lidoEm || Date.now() - new Date(r.lidoEm).getTime() > RES_INTERVALO_MS;
        if (!r || (velho && (dias <= 3 || r.status !== 'ok'))) out.push(p);
    }
    return out;
}
async function lerResultadoDaProva(imp, p) {
    const base = { provaId: p.id, semestre: p.semestre, turma: p.turma, etapa: p.etapa, data: p.data, disciplina: p.disciplina, lidoEm: new Date().toISOString() };
    const q = await questionarioDaAplicacao(imp, p);
    if (q.erro) return { ...base, status: q.especial ? 'sem_curso' : 'erro', erro: q.erro, curso: q.curso || '' };
    const ligado = { curso: q.curso, cursoId: q.cursoId, cmid: q.cmid, quiz: q.quiz, aviso: q.aviso || '', abertura: q.resumo.abertura || '' };
    if (!fechouQuiz(q.resumo.abertura)) return { ...base, ...ligado, status: 'aberta', erro: '' };
    try {
        const r = await lerResultados(imp, q.cmid);
        const fizeram = r.alunos.filter(a => a.situacao === 'finalizada').length;
        return { ...base, ...ligado, status: 'ok', erro: '', notaMax: r.notaMax, media: r.media, alunos: r.alunos, questoes: r.questoes || [],
            contagem: { inscritos: r.alunos.length, fizeram, naoFizeram: r.alunos.filter(a => a.situacao === 'nao_fez').length, outros: r.alunos.length - fizeram - r.alunos.filter(a => a.situacao === 'nao_fez').length } };
    } catch (e) { return { ...base, ...ligado, status: e.semNota ? 'sem_nota' : 'erro', erro: e.message }; }
}

// ---------- estatísticas da prova → Relatório de Desempenho (27/11/2026) ----------
// Depois de ler os Resultados de uma prova FECHADA, baixa do mesmo questionário o "relatório completo" das
// Estatísticas (o mesmo CSV que se baixava à mão) e grava o Relatório de Desempenho (banco_med_relatorios/ava__<prova>).
// Rodada automática: só a 1ª vez de cada prova. "Ler de novo no AVA" (pedido) e --estatisticas=<prova>: refaz.
const RelDesempenho = require(path.join(__dirname, '..', 'src', 'utils', 'relatorio-desempenho-ava'));
async function gravarEstatisticas(imp, p, r, { forcar = false, simular = false } = {}) {
    if (!r || r.status !== 'ok' || !r.cmid) return '';
    const ref = db.collection(RelDesempenho.COL).doc(`ava__${p.id}`);
    if (!forcar && !simular && (await ref.get()).exists) return '';
    const url = `/mod/quiz/report.php?id=${r.cmid}&mode=statistics&everything=1&download=csv`;
    const { texto } = await imp.s.req(url);
    const { id, doc, existia } = await RelDesempenho.montarDoAva(db, texto, p, r);
    const msg = `estatísticas: ${doc.questoes.length} questões, ${doc.nAlunos ?? '?'} alunos, ${doc.resumo.paraRevisar} para revisar`;
    if (simular) return `${msg} (simulação, não gravou)`;
    await db.collection(RelDesempenho.COL).doc(id).set(doc);
    return `${msg}${existia ? ' (atualizado)' : ' (novo relatório)'}`;
}

// ---------- trazer do AVA para validar (26/11/2026) ----------
// Prova que o professor montou direto no AVA, sem passar pelo Órbita: o Banco MED pede (avaliacao.avaTrazer.status
// = 'pedido'), o agente exporta o banco do questionário em Moodle-XML, guarda no Storage e lista o nome das questões
// que estão na prova. A tela converte e importa na avaliação para a coordenação validar (Conferência CADAM).
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'orbita-fatecivp.firebasestorage.app';
async function trazerAFazer() {
    const snap = await db.collection(COL_AV).where('avaTrazer.status', '==', 'pedido').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function trazerDoAva(imp, av, simular) {
    const ref = db.collection(COL_AV).doc(av.id);
    try {
        const sit = await situacaoDaAvaliacao(av);
        const d = await imp.destino(sit);
        if (d.erro) throw new Error(d.erro);
        const naProva = await imp.questoesDaProva(d.cmid);
        const xml = await imp.exportarXml(d.cmid);
        const noBanco = (xml.match(/<question type="(?!category)/g) || []).length;
        if (simular) return `simulação: ${naProva.length} na prova, ${noBanco} no banco [${d.curso} › ${d.quiz}]`;
        const caminho = `banco-med/ava-trazer/${av.id}.xml`;
        await admin.storage().bucket(BUCKET).file(caminho).save(xml, { contentType: 'application/xml; charset=utf-8', resumable: false });
        await ref.update({
            'avaTrazer.status': 'pronto', 'avaTrazer.arquivo': caminho, 'avaTrazer.questoesNaProva': naProva.slice(0, 200),
            'avaTrazer.naProva': naProva.length, 'avaTrazer.noBanco': noBanco, 'avaTrazer.curso': d.curso, 'avaTrazer.quiz': d.quiz,
            'avaTrazer.cmid': d.cmid, 'avaTrazer.lidoEm': new Date().toISOString(), 'avaTrazer.msg': ''
        });
        return `${naProva.length} questão(ões) na prova, ${noBanco} no banco [${d.curso} › ${d.quiz}]`;
    } catch (e) {
        if (!simular) await ref.update({ 'avaTrazer.status': 'erro', 'avaTrazer.msg': e.message, 'avaTrazer.lidoEm': new Date().toISOString() });
        throw e;
    }
}

// ---------- levar para o AVA as alterações das questões trazidas de lá (26/11/2026) ----------
// Pedido em avaliacao.avaLevar.status = 'pedido'. Para cada questão da prova com avaPendente (alterada no Órbita),
// abre o editor da questão no AVA e troca enunciado, alternativas, correta e feedback (justificativa + FONTE, como o
// XML do Órbita). O AVA guarda como versão nova; quem já fez a prova continua com a versão antiga.
const COL_QUESTOES = 'banco_med_questoes';
const escXml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function levarAFazer() {
    const snap = await db.collection(COL_AV).where('avaLevar.status', '==', 'pedido').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function levarParaAva(imp, av, simular) {
    const ref = db.collection(COL_AV).doc(av.id);
    const docs = await Promise.all((av.questoesIds || []).map(id => db.collection(COL_QUESTOES).doc(id).get()));
    const qs = docs.filter(s => s.exists).map(s => ({ id: s.id, ...s.data() })).filter(q => q.avaPendente && q.avaOrigem && q.avaOrigem.id);
    const erros = [];
    let levadas = 0;
    for (const q of qs) {
        const cmid = q.avaOrigem.cmid || (av.avaTrazer || {}).cmid;
        try {
            if (!cmid) throw new Error('sem o questionário de origem no AVA');
            const feedbackHtml = [q.justificativa, q.fonte ? `<p><em>FONTE: ${escXml(q.fonte)}</em></p>` : ''].filter(Boolean).join('\n');
            if (!simular) {
                await imp.editarQuestao(cmid, q.avaOrigem.id, { enunciadoHtml: q.enunciadoHtml || '', alternativas: q.alternativas || [], feedbackHtml });
                await db.collection(COL_QUESTOES).doc(q.id).update({ avaPendente: false, avaLevadaEm: new Date().toISOString(), avaLevadaErro: null });
            }
            levadas++;
        } catch (e) {
            erros.push({ questao: q.avaOrigem.nome || q.id, erro: e.message });
            if (!simular) await db.collection(COL_QUESTOES).doc(q.id).update({ avaLevadaErro: e.message, avaLevadaErroEm: new Date().toISOString() });
        }
    }
    if (!simular) await ref.update({ 'avaLevar.status': erros.length && !levadas ? 'erro' : 'pronto', 'avaLevar.levadas': levadas, 'avaLevar.erros': erros.slice(0, 50), 'avaLevar.em': new Date().toISOString() });
    return `${levadas} de ${qs.length} levada(s) ao AVA${erros.length ? `; ${erros.length} com erro` : ''}`;
}

async function rodada(origem) {
    const inicio = Date.now();
    const simular = !!args.simular, teste = args['teste-cmid'] || null;
    const lista = (await situacaoDoSemestre(args.semestre || semestreAtual()))
        .filter(s => s.prontas.length && (!args.so || s.id === args.so) && !args['so-resultados']);
    // na rodada automática, o que já deu "conferir"/"erro" com a MESMA parte pronta espera a secretaria pedir de novo
    const avs = new Map();
    for (const s of lista) avs.set(s.id, (await db.collection(COL_AV).doc(s.id).get()).data());
    const fila = lista.filter(s => origem === 'pedido' || args['uma-vez'] || !['conferir', 'erro'].includes(s.ava.status) || (avs.get(s.id).avaBanco || {}).tentativa !== chaveTentativa(s.prontas));
    const resumo = { importada: 0, ja_estava: 0, conferir: 0, erro: 0, simulado: 0, questoes: 0, quadros: 0 };
    // 26/11/2026: também as provas vazias no Órbita — podem ter sido montadas direto no AVA (o quadro conta quem
    // colocou cada questão: nome padrão do Órbita × posta direto), para a coordenação trazer e validar.
    const todas = (await situacaoDoSemestre(args.semestre || semestreAtual())).filter(s => !args.so || s.id === args.so);
    const velho = (s) => { const q = s.ava && s.ava.quadro; return !q || !q.lidoEm || Date.now() - new Date(q.lidoEm).getTime() > QUADRO_MS; };
    const quadros = args['so-resultados'] ? [] : todas.filter(s => !fila.some(f => f.id === s.id) && (origem !== 'automatica' || velho(s)));
    const resultados = args.so ? [] : await resultadosAFazer(origem);
    const trazer = (args.so || teste) ? [] : await trazerAFazer();
    const levar = (args.so || teste) ? [] : await levarAFazer();
    resumo.resultados = 0; resumo.trazidas = 0; resumo.levadas = 0;
    if (!fila.length && !quadros.length && !resultados.length && !trazer.length && !levar.length) { log(`Nada novo para o AVA (${origem}).`); return { resumo, segundos: 0 }; }
    log(`Rodada (${origem}): ${fila.length} prova(s) com questões prontas, ${quadros.length} para atualizar os números, ${resultados.length} resultado(s) para ler, ${trazer.length} para trazer do AVA, ${levar.length} com alterações para levar${simular ? ' — SIMULAÇÃO' : ''}${teste ? ` — TESTE no questionário ${teste}` : ''}.`);

    const sessao = new SessaoAva();
    await sessao.entrar();
    const imp = new ImportadorBancoAva(sessao);
    // primeiro o "Trazer do AVA para validar": tem alguém esperando na tela
    for (const av of trazer) {
        try { const msg = await trazerDoAva(imp, av, simular); resumo.trazidas++; log(`  trazer    ${av.disciplina} · ${av.id} — ${msg}`); }
        catch (e) { log(`  trazer    ${av.disciplina} · ${av.id} — erro: ${e.message}`); }
    }
    for (const av of levar) {
        try { const msg = await levarParaAva(imp, av, simular); resumo.levadas++; log(`  levar     ${av.disciplina} · ${av.id} — ${msg}`); }
        catch (e) { log(`  levar     ${av.disciplina} · ${av.id} — erro: ${e.message}`); if (!simular) await db.collection(COL_AV).doc(av.id).update({ 'avaLevar.status': 'erro', 'avaLevar.erros': [{ questao: '', erro: e.message }], 'avaLevar.em': new Date().toISOString() }).catch(() => {}); }
    }
    for (const sit of fila) {
        const av = { id: sit.id, ...avs.get(sit.id) };
        let r;
        for (let t = 0; t < 2; t++) {
            try { r = await imp.enviar(sit, av, { simular, cmidTeste: teste }); break; }
            catch (e) {
                if (e.tentarDeNovo && t === 0) { await espera(4000); continue; }
                r = { em: new Date().toISOString(), status: 'erro', msg: e.message };
            }
        }
        resumo[r.status] = (resumo[r.status] || 0) + 1;
        if (r.status === 'importada') resumo.questoes += sit.prontas.length;
        log(`  ${r.status.padEnd(9)} ${sit.disciplina} · ${sit.prova} — ${sit.prontas.length} pronta(s) · ${r.msg || ''}${r.quiz ? ` [${r.curso} › ${r.quiz}]` : ''}`);
        if (!simular && !teste) await gravarResultado(sit, r);
    }
    // números do questionário das outras provas (só leitura no AVA)
    for (const sit of quadros) {
        if (teste) break;
        try {
            const r = await imp.resumoDaProva(sit);
            if (!simular) await gravarQuadro(sit, r);
            resumo.quadros++;
            if (simular || args['uma-vez']) log(`  quadro    ${sit.disciplina} · ${sit.prova} — ${r.erro || `${r.resumo.noQuestionario} questões no questionário, nota máx. ${r.resumo.notaMaxima}, soma ${r.resumo.somaNotas}`}`);
        } catch (e) { log(`  quadro    ${sit.disciplina} · ${sit.prova} — erro: ${e.message}`); }
    }
    // resultados das provas que já fecharam (Aplicação de Provas): quem fez, a nota e quem não fez
    for (const p of resultados) {
        if (teste) break;
        try {
            const r = await lerResultadoDaProva(imp, p);
            if (!simular) await db.collection(COL_RES).doc(p.id).set(r);
            resumo.resultados++;
            try { const m = await gravarEstatisticas(imp, p, r, { simular }); if (m) log(`  desempenho ${p.data} ${p.turma} ${p.disciplina} — ${m}`); }
            catch (e) { log(`  desempenho ${p.data} ${p.turma} ${p.disciplina} — erro: ${e.message}`); }
            if (simular || args['uma-vez']) log(`  resultado ${p.data} ${p.turma} ${p.disciplina} — ${r.status === 'ok' ? `${r.contagem.fizeram} fizeram, ${r.contagem.naoFizeram} não fizeram (nota sobre ${r.notaMax})` : r.erro || r.status}`);
        } catch (e) { log(`  resultado ${p.data} ${p.turma} ${p.disciplina} — erro: ${e.message}`); }
    }
    const segundos = Math.round((Date.now() - inicio) / 1000);
    log(`Fim da rodada em ${segundos}s: ${JSON.stringify(resumo)}`);
    return { resumo, segundos };
}

// ---------- pedidos por prova (26/11/2026) ----------
// Cada botão do Órbita grava um pedido em ava_pedidos ({ tipo, alvo, status: 'pendente' }) e acorda o agente. Ele
// atende só aquilo: "Enviar esta prova" manda o que está pronto e relê o questionário daquela prova; "Ler de novo no
// AVA" lê o resultado daquela prova; "Trazer"/"Levar" fazem só isso. "Conferir todas" (tipo 'tudo') é a rodada
// completa. Antes todo botão refazia tudo e levava mais de 10 minutos.
const COL_PED = 'ava_pedidos';
async function lerAv(id) {
    const s = await db.collection(COL_AV).doc(String(id || '')).get();
    if (!s.exists) throw new Error('prova não encontrada no Órbita');
    return { id: s.id, ...s.data() };
}
async function pedidoEnvio(imp, id) {
    const av = await lerAv(id);
    const sit = await situacaoDaAvaliacao(av);
    const partes = [];
    if (sit.prontas.length) {
        let r;
        for (let t = 0; t < 2; t++) {
            try { r = await imp.enviar(sit, av, {}); break; }
            catch (e) { if (e.tentarDeNovo && t === 0) { await espera(4000); continue; } r = { em: new Date().toISOString(), status: 'erro', msg: e.message }; }
        }
        await gravarResultado(sit, r);
        partes.push(`${r.status}${r.msg ? `: ${r.msg}` : ''}`);
    }
    const q = await imp.resumoDaProva(sit);
    await gravarQuadro(sit, q);
    partes.push(q.erro ? `questionário: ${q.erro}` : `questionário com ${q.resumo.noQuestionario} questão(ões)`);
    return partes.join(' · ');
}
// "Colocar no questionário" (26/11/2026): só a prova pedida; depois relê o questionário para o quadro
async function pedidoColocar(imp, id, simular = false) {
    const av = await lerAv(id);
    const sit = await situacaoDaAvaliacao(av);
    const r = await imp.colocarNoQuestionario(sit, { simular });
    if (!simular) {
        await db.collection(COL_AV).doc(id).update({ 'avaBanco.colocar': { status: r.status, msg: String(r.msg || '').slice(0, 300), colocadas: r.colocadas || 0, em: r.em } });
        await gravarQuadro(sit, await imp.resumoDaProva(sit));
    }
    return `${r.status}: ${r.msg}`;
}
async function pedidoResultados(imp, provaId) {
    let provas;
    if (provaId) {
        const s = await db.collection('med_aplicacao_provas').doc(String(provaId)).get();
        provas = s.exists ? [{ id: s.id, ...s.data() }] : [];
    } else provas = await resultadosAFazer('pedido');
    for (const p of provas) {
        const r = await lerResultadoDaProva(imp, p);
        await db.collection(COL_RES).doc(p.id).set(r);
        // "Ler de novo no AVA": refaz também o Relatório de Desempenho da prova
        try { await gravarEstatisticas(imp, p, r, { forcar: true }); } catch (e) { log(`  desempenho ${p.id} — erro: ${e.message}`); }
    }
    return `${provas.length} prova(s) lida(s) no AVA`;
}
// → true se havia pedido por prova (e a rodada completa não precisa rodar)
async function atenderPedidos() {
    const snap = await db.collection(COL_PED).where('status', '==', 'pendente').get();
    const pedidos = snap.docs.map(d => ({ ref: d.ref, ...d.data() })).sort((a, b) => String(a.em).localeCompare(String(b.em)));
    const porProva = pedidos.filter(p => p.tipo !== 'tudo');
    const tudo = pedidos.filter(p => p.tipo === 'tudo');
    if (porProva.length) {
        const sessao = new SessaoAva();
        await sessao.entrar();
        const imp = new ImportadorBancoAva(sessao);
        for (const p of porProva) {
            await p.ref.update({ status: 'rodando', inicio: new Date().toISOString() });
            let ok = true, msg = '';
            try {
                if (p.tipo === 'envio') msg = await pedidoEnvio(imp, p.alvo);
                else if (p.tipo === 'resultados') msg = await pedidoResultados(imp, p.alvo);
                else if (p.tipo === 'trazer') msg = await trazerDoAva(imp, await lerAv(p.alvo), false);
                else if (p.tipo === 'levar') msg = await levarParaAva(imp, await lerAv(p.alvo), false);
                else if (p.tipo === 'colocar') msg = await pedidoColocar(imp, p.alvo);
                else throw new Error(`pedido desconhecido (${p.tipo})`);
            } catch (e) { ok = false; msg = e.message; }
            await p.ref.update({ status: ok ? 'feito' : 'erro', msg: String(msg || '').slice(0, 500), fim: new Date().toISOString() });
            log(`  pedido ${p.tipo} ${p.alvo || ''} de ${p.por || 'alguém'} — ${ok ? '' : 'erro: '}${msg}`);
        }
    }
    if (tudo.length) {
        await Promise.all(tudo.map(p => p.ref.update({ status: 'rodando', inicio: new Date().toISOString() })));
        let ok = true, msg = '';
        try { const r = await rodada('pedido'); msg = `conferência completa em ${r.segundos}s`; } catch (e) { ok = false; msg = e.message; }
        await Promise.all(tudo.map(p => p.ref.update({ status: ok ? 'feito' : 'erro', msg, fim: new Date().toISOString() })));
    }
    return pedidos.length > 0;
}

let rodando = false, pendente = null;
async function rodar(origem) {
    if (rodando) { if (origem === 'pedido' || !pendente) pendente = origem; return; }
    rodando = true;
    const em = new Date().toISOString();
    await cfg.set({ rodandoDesde: em, rodandoOrigem: origem }, { merge: true }).catch(() => {});
    try {
        if (origem === 'pedido') {
            // pedido de um botão: atende os pedidos da fila; sem fila (Órbita antigo), faz a rodada completa
            if (!(await atenderPedidos())) { const r = await rodada('pedido'); await cfg.set({ ultimaRodada: { em, origem, ok: true, ...r } }, { merge: true }); }
            else await cfg.set({ ultimoPedido: { em, fim: new Date().toISOString() } }, { merge: true });
        } else {
            const r = await rodada(origem);
            await cfg.set({ ultimaRodada: { em, origem, ok: true, ...r } }, { merge: true });
        }
    } catch (e) {
        log(`ERRO: ${e.message}`);
        await cfg.set({ ultimaRodada: { em, origem, ok: false, erro: e.message } }, { merge: true }).catch(() => {});
    } finally {
        rodando = false;
        await cfg.set({ rodandoDesde: null, rodandoOrigem: null }, { merge: true }).catch(() => {});
        // pedido que chegou durante a rodada tem prioridade sobre a automática
        if (pendente) { const o = pendente; pendente = null; rodar(o); }
        else {
            const s = await db.collection(COL_PED).where('status', '==', 'pendente').limit(1).get().catch(() => null);
            if (s && !s.empty) rodar('pedido');
        }
    }
}

async function pulso() {
    try { await cfg.set({ agenteVivoEm: new Date().toISOString(), intervaloMin: INTERVALO_MS / 60000 }, { merge: true }); }
    catch (e) { log(`Falha ao gravar pulso: ${e.message}`); }
}

async function iniciar() {
    // teste pelo servidor: node scripts/ava-banco-med-agente.js --estatisticas=<id da prova da Aplicação de Provas> [--simular]
    if (args.estatisticas) {
        try {
            const sessao = new SessaoAva(); await sessao.entrar();
            const imp = new ImportadorBancoAva(sessao);
            const s = await db.collection('med_aplicacao_provas').doc(String(args.estatisticas)).get();
            if (!s.exists) throw new Error('prova não encontrada na Aplicação de Provas');
            const p = { id: s.id, ...s.data() };
            const r = await lerResultadoDaProva(imp, p);
            log(`estatisticas ${p.disciplina} ${p.turma} — resultado: ${r.status}${r.erro ? ` (${r.erro})` : ''} — ${await gravarEstatisticas(imp, p, r, { forcar: true, simular: !!args.simular }) || 'nada (prova não fechada ou sem resultado)'}`);
        } catch (e) { log(`ERRO: ${e.message}`); process.exitCode = 1; }
        process.exit();
    }
    // teste pelo servidor: node scripts/ava-banco-med-agente.js --colocar=<id da avaliação> [--simular]
    if (args.colocar) {
        try {
            const sessao = new SessaoAva(); await sessao.entrar();
            log(`colocar ${args.colocar}${args.simular ? ' (SIMULAÇÃO)' : ''} — ${await pedidoColocar(new ImportadorBancoAva(sessao), String(args.colocar), !!args.simular)}`);
        } catch (e) { log(`ERRO: ${e.message}`); process.exitCode = 1; }
        process.exit();
    }
    if (args['uma-vez']) {
        try { await rodada('manual'); } catch (e) { log(`ERRO: ${e.message}`); process.exitCode = 1; }
        process.exit();
    }
    log('Agente do banco do AVA iniciado.');
    await pulso();
    setInterval(pulso, PULSO_MS);
    await rodar('automatica');
    setInterval(() => rodar('automatica'), INTERVALO_MS);
    // "Enviar agora" do Órbita
    const snap = await cfg.get();
    let pedidoVisto = snap.exists ? snap.data().pedidoEm || null : null;
    cfg.onSnapshot(doc => {
        const pedido = doc.exists ? doc.data().pedidoEm : null;
        if (!pedido || pedido === pedidoVisto) return;
        pedidoVisto = pedido;
        log(`Pedido de envio de ${doc.data().pedidoPorNome || 'alguém'}.`);
        rodar('pedido');
    }, err => log(`Escuta do botão caiu: ${err.message} — reiniciando em 1 min`) || setTimeout(() => process.exit(1), 60000));
}

process.on('unhandledRejection', e => log(`Erro inesperado: ${e && e.message}`));
iniciar().catch(e => { log(`Falha ao iniciar: ${e.message}`); setTimeout(() => process.exit(1), 60000); });
