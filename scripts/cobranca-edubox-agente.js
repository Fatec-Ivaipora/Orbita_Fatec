// ==========================================================================
// Agente da Cobrança (Edubox -> Órbita) — fica rodando num PC da Fatec, que
// é quem consegue acessar o Edubox. Inicia junto com o Windows pelo
// "cobranca-edubox-agente.vbs" (pasta Inicializar do usuário, sem janela).
//
//  - Atualiza sozinho às 7h, 12h, 17h e 22h. Se o PC estava desligado no
//    horário, atualiza assim que ligar.
//  - Botão "Atualizar agora" do Órbita grava config/cobranca_sync.pedidoEm;
//    o agente escuta esse documento e atualiza na hora.
//  - A cada 5 min grava agenteVivoEm, pra tela avisar se o PC estiver
//    desligado (aí o botão não tem quem atenda).
//
// Log em scripts/logs/cobranca-edubox-agente.log (fora do git).
// ==========================================================================
const fs = require('fs');
const path = require('path');
const { sincronizar } = require('./cobranca-edubox-sync');
const { db } = require(path.join(__dirname, '..', 'src', 'firebase'));

const HORARIOS = [7, 12, 17, 22];
const PULSO_MS = 5 * 60 * 1000;
const pastaLog = path.join(__dirname, 'logs');
const arquivoLog = path.join(pastaLog, 'cobranca-edubox-agente.log');
const cfg = db.collection('config').doc('cobranca_sync');

function log(msg) {
    const linha = `[${new Date().toLocaleString('pt-BR')}] ${msg}`;
    console.log(linha);
    try {
        fs.mkdirSync(pastaLog, { recursive: true });
        // mantém o log pequeno: passou de 1 MB, recomeça
        if (fs.existsSync(arquivoLog) && fs.statSync(arquivoLog).size > 1024 * 1024) fs.writeFileSync(arquivoLog, '');
        fs.appendFileSync(arquivoLog, linha + '\n');
    } catch (e) { /* log é opcional */ }
}

// Último horário fixo que já passou (ex.: agora 13h40 -> hoje 12h).
function ultimoHorario(agora = new Date()) {
    for (let i = HORARIOS.length - 1; i >= 0; i--) {
        const h = new Date(agora); h.setHours(HORARIOS[i], 0, 0, 0);
        if (h <= agora) return h;
    }
    const ontem = new Date(agora); ontem.setDate(ontem.getDate() - 1); ontem.setHours(HORARIOS[HORARIOS.length - 1], 0, 0, 0);
    return ontem;
}
function proximoHorario(agora = new Date()) {
    for (const hr of HORARIOS) {
        const h = new Date(agora); h.setHours(hr, 0, 0, 0);
        if (h > agora) return h;
    }
    const amanha = new Date(agora); amanha.setDate(amanha.getDate() + 1); amanha.setHours(HORARIOS[0], 0, 0, 0);
    return amanha;
}

let rodando = false;
let pendente = null;
let ultimaOk = null; // Date da última atualização concluída

async function rodar(origem) {
    if (rodando) { pendente = origem; return; }
    rodando = true;
    try {
        log(`Atualizando (${origem})...`);
        const r = await sincronizar(origem);
        ultimaOk = new Date();
        log(`OK em ${Math.round(r.duracaoMs / 1000)}s — ${r.parcelasLidas} parcelas em aberto, ${r.baixasLidas} baixas.`);
    } catch (e) {
        log(`ERRO: ${e.message}`);
    } finally {
        rodando = false;
        if (pendente) { const o = pendente; pendente = null; rodar(o); }
    }
}

function agendarProximo() {
    const prox = proximoHorario();
    log(`Próxima atualização automática: ${prox.toLocaleString('pt-BR')}`);
    setTimeout(async () => { await rodar('automatica'); agendarProximo(); }, prox - new Date());
}

async function pulso() {
    try { await cfg.set({ agenteVivoEm: new Date().toISOString(), agenteHorarios: HORARIOS }, { merge: true }); }
    catch (e) { log(`Falha ao gravar pulso: ${e.message}`); }
}

async function iniciar() {
    log('Agente da Cobrança iniciado.');
    await pulso();
    setInterval(pulso, PULSO_MS);

    // Recupera horário perdido (PC desligado às 7h, por exemplo)
    const snap = await cfg.get();
    const ult = snap.exists && snap.data().ultimaAtualizacao ? new Date(snap.data().ultimaAtualizacao) : null;
    ultimaOk = ult;
    if (!ult || ult < ultimoHorario()) await rodar('automatica');
    agendarProximo();

    // "Atualizar agora" do Órbita
    let pedidoVisto = snap.exists ? snap.data().pedidoEm || null : null;
    cfg.onSnapshot(doc => {
        const pedido = doc.exists ? doc.data().pedidoEm : null;
        if (!pedido || pedido === pedidoVisto) return;
        pedidoVisto = pedido;
        // pedido antigo que já foi atendido (ex.: feito antes da última atualização)
        if (ultimaOk && new Date(pedido) <= ultimaOk) return;
        log(`Pedido de atualização de ${doc.data().pedidoPorNome || 'alguém'}.`);
        rodar('pedido');
    }, err => log(`Escuta do botão caiu: ${err.message} — reiniciando em 1 min`) || setTimeout(() => process.exit(1), 60000));
}

process.on('unhandledRejection', e => log(`Erro inesperado: ${e && e.message}`));
iniciar().catch(e => { log(`Falha ao iniciar: ${e.message}`); setTimeout(() => process.exit(1), 60000); });
