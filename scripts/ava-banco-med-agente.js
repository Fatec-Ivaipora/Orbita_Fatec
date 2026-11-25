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
//
// Credenciais no .env: AVA_URL, AVA_LOGIN_USUARIO, AVA_LOGIN_SENHA (+ Firebase). Log em scripts/logs/ (fora do git).
// ==========================================================================
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { db, admin } = require(path.join(__dirname, '..', 'src', 'firebase'));
const { situacaoDoSemestre, semestreAtual, publicarNoBanco, COL_AV } = require(path.join(__dirname, '..', 'src', 'utils', 'banco-med-ava-fila'));
const { SessaoAva } = require(path.join(__dirname, '..', 'src', 'utils', 'ava-sessao'));
const { ImportadorBancoAva } = require(path.join(__dirname, '..', 'src', 'utils', 'ava-banco-importar'));

const INTERVALO_MS = 15 * 60 * 1000;
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

async function gravarResultado(sit, r) {
    const ref = db.collection(COL_AV).doc(sit.id);
    const comum = {
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

async function rodada(origem) {
    const inicio = Date.now();
    const simular = !!args.simular, teste = args['teste-cmid'] || null;
    const lista = (await situacaoDoSemestre(args.semestre || semestreAtual()))
        .filter(s => s.prontas.length && (!args.so || s.id === args.so));
    // na rodada automática, o que já deu "conferir"/"erro" com a MESMA parte pronta espera a secretaria pedir de novo
    const avs = new Map();
    for (const s of lista) avs.set(s.id, (await db.collection(COL_AV).doc(s.id).get()).data());
    const fila = lista.filter(s => origem === 'pedido' || args['uma-vez'] || !['conferir', 'erro'].includes(s.ava.status) || (avs.get(s.id).avaBanco || {}).tentativa !== chaveTentativa(s.prontas));
    const resumo = { importada: 0, ja_estava: 0, conferir: 0, erro: 0, simulado: 0, questoes: 0 };
    if (!fila.length) { log(`Nada novo para o AVA (${origem}).`); return { resumo, segundos: 0 }; }
    log(`Rodada (${origem}): ${fila.length} prova(s) com questões prontas${simular ? ' — SIMULAÇÃO' : ''}${teste ? ` — TESTE no questionário ${teste}` : ''}.`);

    const sessao = new SessaoAva();
    await sessao.entrar();
    const imp = new ImportadorBancoAva(sessao);
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
    const segundos = Math.round((Date.now() - inicio) / 1000);
    log(`Fim da rodada em ${segundos}s: ${JSON.stringify(resumo)}`);
    return { resumo, segundos };
}

let rodando = false, pendente = null;
async function rodar(origem) {
    if (rodando) { pendente = origem; return; }
    rodando = true;
    const em = new Date().toISOString();
    try {
        const r = await rodada(origem);
        await cfg.set({ ultimaRodada: { em, origem, ok: true, ...r } }, { merge: true });
    } catch (e) {
        log(`ERRO: ${e.message}`);
        await cfg.set({ ultimaRodada: { em, origem, ok: false, erro: e.message } }, { merge: true }).catch(() => {});
    } finally {
        rodando = false;
        if (pendente) { const o = pendente; pendente = null; rodar(o); }
    }
}

async function pulso() {
    try { await cfg.set({ agenteVivoEm: new Date().toISOString(), intervaloMin: INTERVALO_MS / 60000 }, { merge: true }); }
    catch (e) { log(`Falha ao gravar pulso: ${e.message}`); }
}

async function iniciar() {
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
