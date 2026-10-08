import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';
import { getEffectiveLevel } from '../../core/permissions.js';

// ==========================================================================
// Cobrança com dados do Edubox. Os números são gravados no Firestore por um
// agente que roda num PC da Fatec (scripts/cobranca-edubox-agente.js) às 7h,
// 12h, 17h e 22h, ou na hora pelo "Atualizar agora".
// Visões: Painel (vencido x a vencer, faixas, cursos), Lista de cobrança
// (WhatsApp com mensagem pronta + controle de quem já foi cobrado) e
// Fechamento semanal (comecei a semana com X, recebi Y, diferença).
// Tudo que initApp usa de forma síncrona fica declarado aqui em cima.
// ==========================================================================
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

const MODULO = 'cobranca';
const POR_PAGINA = 100;
const AGENTE_OFF_MIN = 15; // sem sinal do PC há mais que isso = desligado
const FAIXAS = [['1-30', 'Até 30 dias', '#edc24e'], ['31-60', '31 a 60 dias', '#e79a39'], ['61-90', '61 a 90 dias', '#d8542e'], ['90+', 'Mais de 90 dias', '#b12f28']];
const TIPOS = {
  whatsapp: ['💬', 'WhatsApp'], ligacao: ['📞', 'Ligação'], email: ['✉️', 'E-mail'], contato: ['🙋', 'Contato / atendimento'],
  negociacao: ['🤝', 'Negociação'], promessa_pagamento: ['📅', 'Promessa de pagamento'], enviado_advocacia: ['⚖️', 'Enviado ao advogado'],
  acordo_judicial: ['⚖️', 'Acordo judicial'], quitado_manual: ['✅', 'Quitado'], mudanca_situacao: ['🔁', 'Mudança de situação'], outro: ['📝', 'Observação']
};

let currentUser = null;
let currentUserNome = '';
let appInitialized = false;
let initializedRole = null;
let podeEditar = false;

let grupo = 'graduacao';
let visao = 'panorama';   // tela principal (a Visão do diretor foi retirada em 07/10/2026)
let semestre = '';
let painel = null;          // resposta de /painel (semana atual)
let semanaRef = null;       // 'AAAA-MM-DD' da semana do fechamento (null = atual)
let semanaDados = null;
const listas = {};          // grupo -> { alunos, controle, geradoEm }
let filtrados = [];
let mostrando = POR_PAGINA;
let modelos = null;
let semanasDados = null;    // resumo por semana (Visão do diretor)
let mes = '';               // 'AAAA-MM' = visão mensal (só Painel e Visão do diretor); '' = semestre inteiro
const mesesDados = {};      // 'AAAA-MM' -> resposta de /mes (carregado ao escolher)
let panMetric = 'valor';     // Panorama: curso por R$ atrasado ou por taxa
let consultoria = null;     // /consultoria: ano inteiro na régua do painel Fiasini (carregado ao escolher)
let consBase = 'aPagar';    // Visão consultoria: com juros (como o Fiasini mostra) ou valor original
let carregandoRecebido = false;
let recebidoDados = null;
let cursoPedido = '';        // curso clicado no Panorama -> abre a Lista já filtrada   // /recebido: dinheiro que entrou por mês e por semana (gráfico do diretor)
let alunoAberto = null;     // aluno do modal WhatsApp / detalhe
let aguardando = null;      // timer do "Atualizar agora"

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(options.headers || {}) };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro na API: ${res.status}`);
  return j;
}

async function apiFetchComRetentativa(endpoint, tentativas = 2) {
  for (let i = 1; i <= tentativas; i++) {
    try { return await apiFetch(endpoint); } catch (err) {
      if (i === tentativas) throw err;
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

function showToast(msg, tipo = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${tipo}`;
  setTimeout(() => toast.classList.add('hidden'), 3500);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
// Valor com juros e multa, igual ao Edubox (conferido com o relatório de contas
// a receber): multa 2% + juros de 1% ao mês composto por mês completo (30 dias).
function aPagarParcela(valor, vencIso) {
  const dias = Math.round((Date.now() - new Date(vencIso + 'T12:00:00').getTime()) / 86400000);
  if (dias <= 0) return valor;
  const multa = Math.round(valor * 0.02 * 100) / 100;
  const juros = Math.round(valor * (Math.pow(1.01, Math.floor(dias / 30)) - 1) * 100) / 100;
  return valor + multa + juros;
}
// Bloco do resumo -> "A pagar" em destaque + valor original embaixo
const apDe = (b) => (b && b.aPagar !== undefined ? b.aPagar : (b ? b.valor : 0));
const celAP = (b, forte = false) => `${forte ? '<b>' : ''}${brl(apDe(b))}${forte ? '</b>' : ''}<small class="cb-orig">original ${brl(b ? b.valor : 0)}</small>`;
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fmtData(s) { if (!s) return ''; const [a, m, d] = s.slice(0, 10).split('-'); return `${d}/${m}/${a}`; }
function fmtDataHora(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ' às');
}
function segunda(d = new Date()) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function somaDias(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dataLocal(s) { const [a, m, d] = s.split('-').map(Number); return new Date(a, m - 1, d, 12); }
function inicioSemanaISO() { const s = segunda(); s.setHours(0, 0, 0, 0); return s.toISOString(); }
function diasDesde(isoStr) { return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86400000); }
function semestreAtual() { const d = new Date(); return `${d.getFullYear()}.${d.getMonth() < 6 ? 1 : 2}`; }
function plural(n, s, p) { return `${n} ${n === 1 ? s : p}`; }
function nomeGrupo() { return grupo === 'medicina' ? 'Medicina' : 'Graduação (16 cursos)'; }
function nomeSemestre() { return usaMes() ? `Mês de ${nomeMes(mes)}` : semestre === 'todos' ? 'Todos os anos (acumulado)' : semestre === 'consultoria' ? `${anoAtual()} (Visão consultoria)` : `Semestre ${semestre}`; }
function anoAtual() { return String(new Date().getFullYear()); }
// ---- Visão mensal (pedido do diretor, 02/10/2026): no Painel e na Visão do
// diretor dá pra escolher um mês do semestre. A Lista de cobrança e o
// Fechamento semanal continuam por semestre (é como o Financeiro trabalha).
const NOMES_MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function mesesDoPeriodo() {
  if (usaMes()) return [mes];
  if (/^\d{4}\.[12]$/.test(semestre)) { const [a, n] = semestre.split('.'); return [0, 1, 2, 3, 4, 5].map(i => `${a}-${String((n === '1' ? 1 : 7) + i).padStart(2, '0')}`); }
  return null;   // todos os anos
}
function nomePeriodo() {
  if (usaMes()) return nomeMes(mes);
  if (/^\d{4}\.[12]$/.test(semestre)) return `${semestre.endsWith('.1') ? '1º' : '2º'} semestre de ${semestre.slice(0, 4)}`;
  return 'todos os anos';
}
function nomeMes(m) { return `${NOMES_MES[Number(m.slice(5, 7)) - 1]}/${m.slice(0, 4)}`; }
// Tudo segue o filtro do topo (08/10/2026): o mês escolhido vale no Panorama, no Painel e na Lista.
const VISOES_COM_MES = ['painel', 'diretor', 'panorama', 'lista'];
function usaMes() { return !!mes && VISOES_COM_MES.includes(visao); }
// Meses do semestre escolhido até o mês atual, dentro dos 24 meses que o agente guarda.
function mesesDoSemestre(s) {
  if (!/^\d{4}\.[12]$/.test(s)) return [];
  const [a, n] = s.split('.');
  const hoje = new Date();
  const atual = iso(hoje).slice(0, 7);
  const minimo = iso(new Date(hoje.getFullYear(), hoje.getMonth() - 23, 1)).slice(0, 7);
  return [0, 1, 2, 3, 4, 5].map(i => `${a}-${String((n === '1' ? 1 : 7) + i).padStart(2, '0')}`).filter(m => m <= atual && m >= minimo);
}
function montarMeses() {
  const sel = document.getElementById('sel-mes');
  const lista = VISOES_COM_MES.includes(visao) ? mesesDoSemestre(semestre) : [];
  sel.classList.toggle('hidden', !lista.length);
  if (!lista.length) return;
  if (mes && !lista.includes(mes)) mes = '';
  sel.innerHTML = '<option value="">Semestre inteiro</option>' + lista.map(m => `<option value="${m}">${nomeMes(m)}</option>`).join('');
  sel.value = mes;
}
async function carregarMes() {
  try {
    mesesDados[mes] = await apiFetch(`/cobranca/edubox/mes/${mes}`);
  } catch (err) {
    showToast(`Não foi possível carregar o mês: ${err.message}`, 'error');
    mes = '';
  }
}
function fimDoMes(m) { return iso(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)); }
function nomeCurso(c) {
  return (c || '').replace(/^BACHARELADO EM /, '').replace(/^LICENCIATURA EM /, 'Lic. ').replace(/^SUPERIOR DE TECNOLOGIA EM /, 'Tec. ')
    .replace(/ - FORMAÇÃO DE PSICÓLOGO \(A\)/, '').toLowerCase().replace(/(^|\s)\S/g, x => x.toUpperCase()).replace(/\b(Em|De|Da|Do|E)\b/g, x => x.toLowerCase());
}

// ---------- AUTH ----------
const cached = getCachedAuth();
if (cached && (cached.role === 'adm_l1' || cached.role === 'adm_l2')) {
  currentUser = cached.user;
  initApp(cached.user, cached.role);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    clearCachedAuth();
    window.location.href = '../../auth/login.html';
    return;
  }
  currentUser = user;
  try {
    const token = await user.getIdToken();
    let role = 'visitante';
    let meuOverrides = null;
    try {
      const userData = await apiFetchComRetentativa('/usuarios/me');
      role = userData.role || 'visitante';
      meuOverrides = userData.permissoes || null;
      currentUserNome = userData.name || user.displayName || '';
    } catch (err) {
      role = cached ? cached.role : 'visitante';
    }
    setCachedAuth(user, role, token);
    let level = 1;
    if (role === 'adm_l1') level = 3;
    else {
      try {
        const perms = await apiFetchComRetentativa('/usuarios/config/permissions');
        level = getEffectiveLevel(perms[role] || {}, meuOverrides, MODULO);
      } catch (e) {
        if (role === 'adm_l2') level = 3;
      }
    }
    if (level < 2) { window.location.href = '../../meu-espaco/index.html'; return; }
    podeEditar = level >= 3;
    document.body.classList.toggle('hide-execute', !podeEditar);
    if (!appInitialized || initializedRole !== role) {
      initializedRole = role;
      initApp(user, role);
    }
    if (!painel) carregarPainel();
  } catch (err) {
    console.error('Erro na revalidação de auth:', err);
  }
});

function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;
  setupLayout(user, role, MODULO, async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });
  document.getElementById('app').classList.remove('hidden');
  wireEventos();
}

// ---------- CARGA ----------
async function carregarPainel() {
  try {
    await auth.authStateReady();
    if (auth.currentUser) currentUser = auth.currentUser;
    painel = await apiFetch('/cobranca/edubox/painel');
    consultoria = null;   // recarrega a visão consultoria junto (depois do "Atualizar agora")
    renderStatus(painel.status || {});
    if (painel.vazio) {
      document.getElementById('faixas').innerHTML = '<div class="tabela-msg">Ainda não houve atualização do Edubox. Clique em "Atualizar agora".</div>';
      return;
    }
    montarSemestres();
    renderTudo();
  } catch (err) {
    document.getElementById('cb-status').textContent = `Erro ao carregar: ${err.message}`;
  }
}

// ---- Seletor em 3 caixas (08/10/2026): Ano | Semestre (ou "Ano inteiro" =
// Visão consultoria) | Mês. A variável interna continua sendo só `semestre`
// ('todos' | 'consultoria' | 'AAAA.N') — as caixas só leem/escrevem nela, pra
// não precisar tocar em renderTudo()/montarMeses()/trocarVisao() por dentro.
function listaSemestresCob() {
  return (painel.semestres || []).filter(s => /^\d{4}\.\d$/.test(s) && s <= semestreAtual());
}
function montarSemestres() {
  const lista = listaSemestresCob();
  if (!semestre) semestre = lista.includes(semestreAtual()) ? semestreAtual() : 'todos';
  montarAno();
  sincronizarCaixasPeriodo();
}
function montarAno() {
  const sel = document.getElementById('sel-ano');
  const anos = [...new Set(listaSemestresCob().map(s => s.split('.')[0]))].sort((a, b) => b.localeCompare(a));
  sel.innerHTML = `<option value="todos-anos">Todos os anos (acumulado)</option>` + anos.map(a => `<option value="${a}">${a}</option>`).join('');
}
function montarPeriodo(anoSel) {
  const sel = document.getElementById('sel-sem-periodo');
  if (anoSel === 'todos-anos') { sel.classList.add('hidden'); return; }
  sel.classList.remove('hidden');
  const lista = listaSemestresCob();
  const opts = [];
  if (lista.includes(`${anoSel}.1`)) opts.push(['1', `1º semestre (${anoSel}.1)`]);
  if (lista.includes(`${anoSel}.2`)) opts.push(['2', `2º semestre (${anoSel}.2)`]);
  // "Ano inteiro" (Visão consultoria) só existe pro ano atual — o agente só
  // grava resumo[anoAtual()] no doc de consultoria, nada de anos passados.
  if (anoSel === anoAtual()) opts.push(['ano-inteiro', 'Ano inteiro (4 grupos — Visão consultoria)']);
  sel.innerHTML = opts.map(([v, rot]) => `<option value="${v}">${rot}</option>`).join('');
}
// Lê `semestre` e ajusta as 3 caixas pra combinar — chamada sempre que
// `semestre` muda por fora das próprias caixas (trocarVisao, tabela de
// semestres, carga inicial).
function sincronizarCaixasPeriodo() {
  let ano, periodo;
  if (semestre === 'todos') { ano = 'todos-anos'; periodo = null; }
  else if (semestre === 'consultoria') { ano = anoAtual(); periodo = 'ano-inteiro'; }
  else { const [a, n] = semestre.split('.'); ano = a; periodo = n; }
  document.getElementById('sel-ano').value = ano;
  montarPeriodo(ano);
  if (periodo) document.getElementById('sel-sem-periodo').value = periodo;
}
// Lê as 3 caixas e grava em `semestre`/`mes` — mesma regra que o antigo
// listener do #sel-semestre tinha (inclusive o desvio pro Panorama quando
// escolhe "Ano inteiro").
function aplicarCaixasPeriodo() {
  const ano = document.getElementById('sel-ano').value;
  semestre = ano === 'todos-anos' ? 'todos' : (() => {
    const periodo = document.getElementById('sel-sem-periodo').value;
    return periodo === 'ano-inteiro' ? 'consultoria' : `${ano}.${periodo}`;
  })();
  mes = '';
  mostrando = POR_PAGINA;
  if (semestre === 'consultoria' && visao !== 'panorama') { trocarVisao('panorama'); return; }
  renderTudo();
}

function renderTudo() {
  montarMeses();
  if (usaMes() && !mesesDados[mes]) { carregarMes().then(renderTudo); return; }
  // aviso do semestre vale pra todas as visões (antes só o Painel atualizava)
  const aviso = document.getElementById('aviso-advogado');
  aviso.classList.toggle('hidden', semestre === 'todos');
  const [anoS, nS] = semestre.split('.');
  aviso.textContent = `Semestre ${semestre}: parcelas que vencem de ${nS === '1' ? 'janeiro a junho' : 'julho a dezembro'} de ${anoS} (mesmo critério do relatório do Edubox). Escolha "Todos os anos" para ver o total e a divisão por semestre.`;
  if (usaMes()) aviso.textContent = avisoMes();
  if (semestre === 'consultoria') aviso.textContent = `Visão consultoria: inclui Advogado, Débito judicial e desistentes/trancados/cancelados; apenas parcelas de ${anoAtual()}; mesma régua de hoje do painel Fiasini.`;
  if (visao === 'diretor') renderDiretor();
  else if (visao === 'panorama') renderPanorama();
  else if (visao === 'painel') renderPainel();
  else if (visao === 'lista') abrirLista();
  else renderSemana();
}

// ---------- STATUS DO AGENTE ----------
function renderStatus(st) {
  const el = document.getElementById('cb-status');
  const partes = [];
  if (st.status === 'rodando') partes.push(`<span class="cb-pill run"><span class="cb-girando"></span> Atualizando agora...</span>`);
  if (st.ultimaAtualizacao) {
    const origem = { automatica: 'automática', pedido: `pedida${st.pedidoPorNome ? ` por ${esc(st.pedidoPorNome)}` : ''}`, manual: 'manual' }[st.ultimaOrigem] || '';
    partes.push(`Dados do Edubox de <strong>${fmtDataHora(st.ultimaAtualizacao)}</strong>${origem ? ` (${origem})` : ''}`);
  } else partes.push('Ainda sem atualização do Edubox');
  const vivo = st.agenteVivoEm && (Date.now() - new Date(st.agenteVivoEm).getTime()) < AGENTE_OFF_MIN * 60000;
  partes.push(vivo
    ? `<span class="cb-pill ok">PC de atualização ligado</span>`
    : `<span class="cb-pill off" title="O programa que busca no Edubox roda no computador do TI. Desligado, não há atualização automática nem pelo botão.">PC de atualização desligado${st.agenteVivoEm ? ` desde ${fmtDataHora(st.agenteVivoEm)}` : ''}</span>`);
  if (st.status === 'erro' && st.erro) partes.push(`<span class="cb-pill off">Última tentativa falhou: ${esc(st.erro)}</span>`);
  el.innerHTML = partes.join(' · ');
}

async function atualizarAgora() {
  const btn = document.getElementById('btn-atualizar');
  if (aguardando) return;
  btn.disabled = true;
  document.getElementById('btn-atualizar-texto').textContent = 'Atualizando...';
  try {
    const { pedidoEm } = await apiFetch('/cobranca/edubox/atualizar', { method: 'POST' });
    renderStatus({ ...(painel?.status || {}), status: 'rodando' });
    const limite = Date.now() + 120000;
    const fim = (msg, tipo) => {
      clearInterval(aguardando); aguardando = null;
      btn.disabled = false;
      document.getElementById('btn-atualizar-texto').textContent = 'Atualizar agora';
      if (msg) showToast(msg, tipo);
    };
    aguardando = setInterval(async () => {
      try {
        const st = await apiFetch('/cobranca/edubox/status');
        if (st.ultimaAtualizacao && st.ultimaAtualizacao > pedidoEm && st.status !== 'rodando') {
          fim('Atualizado com os dados do Edubox.');
          Object.keys(listas).forEach(k => delete listas[k]);
          semanaDados = null;
          semanasDados = null;
          recebidoDados = null;
          painel = null;
          await carregarPainel();
        } else if (st.status === 'erro' && st.erroEm > pedidoEm) {
          renderStatus(st);
          fim(`O Edubox não respondeu: ${st.erro}`, 'error');
        } else if (Date.now() > limite) {
          renderStatus(st);
          fim('O PC que busca no Edubox não respondeu (pode estar desligado). Tente de novo mais tarde.', 'error');
        }
      } catch (e) { /* tenta de novo no próximo ciclo */ }
    }, 3000);
  } catch (err) {
    btn.disabled = false;
    document.getElementById('btn-atualizar-texto').textContent = 'Atualizar agora';
    showToast(err.message, 'error');
  }
}

// ---------- PAINEL ----------
// "Previsão" mês a mês (doc atual.previsao): do mês atual até o fim do semestre.
function previsaoMeses() {
  const p = painel?.previsao || {};
  const meses = Object.keys(p).filter(m => p[m][grupo]).sort();
  if (!meses.length) return '';
  const atual = iso(new Date()).slice(0, 7);
  let tf = 0, tj = 0, ts = 0;
  const linhas = meses.map(m => {
    const x = p[m][grupo];
    tf += x.f; tj += x.j; ts += x.s || 0;
    const rot = m === atual ? `${nomeMes(m).split('/')[0]} <small>de hoje até ${fmtData(fimDoMes(m))}</small>` : nomeMes(m).split('/')[0];
    return `<div class="cb-prev-linha"><span>${rot}</span><b>${brl(x.f + x.j)}<small>Financeiro ${brlCurto(x.f)} (${plural(x.alunosF, 'aluno', 'alunos')}) · advogado/débito ${brlCurto(x.j)}${x.s ? ` · fora: saldo devedor ${brlCurto(x.s)}` : ''}</small></b></div>`;
  });
  return `<div class="cb-prev" style="grid-column:1/-1">${linhas.join('')}
    <div class="cb-prev-linha total"><span>Total até ${fmtData(fimDoMes(meses[meses.length - 1]))}</span><b>${brl(tf + tj)}<small>Financeiro ${brlCurto(tf)} · advogado/débito ${brlCurto(tj)}</small></b></div>
    ${ts ? `<div class="cb-prev-linha"><span>Saldo devedor <small>plano "Saldo devedor Nº semestre": negociação com vencimento em 30/12 que costuma ser empurrada para o ano seguinte — não entra na previsão</small></span><b>${brl(ts)}</b></div>` : ''}</div>`;
}

// Mês que já terminou: venceu, já foi pago, ainda em aberto e o que entrou.
function renderMesFechou(r, fin) {
  const devido = (r && r.devido && r.devido.financeiro) || 0;
  const aberto = fin.valor || 0;
  const pago = Math.max(0, devido - aberto);
  const rec = mesesDados[mes]?.recebido?.[grupo] || { f: 0, j: 0, fa: 0, ja: 0 };
  const jur = (r && r.juridico && r.juridico.vencido) || { valor: 0, alunos: 0 };
  document.getElementById('mes-fechou-sub').textContent = `— mensalidades do Financeiro que venceram em ${nomeMes(mes)}, situação de hoje`;
  const linha = (rot, sub, val, cls = '') => `<div class="cb-fechou-linha ${cls}"><span>${rot}${sub ? `<small>${sub}</small>` : ''}</span><b>${val}</b></div>`;
  document.getElementById('mes-fechou').innerHTML = devido
    ? linha('Venceu no mês', 'mensalidades com vencimento no mês (sem advogado/débito)', brl(devido)) +
      linha('Já foi pago', 'em dia ou depois, até hoje', `${brl(pago)} (${pct(pago / devido)})`, 'ok') +
      linha('Ainda em aberto', `${plural(fin.alunos || 0, 'aluno', 'alunos')} · com juros e multa ${brl(apDe(fin))}`, `${brl(aberto)} (${pct(aberto / devido)})`, aberto ? 'ruim' : 'ok') +
      linha('Entrou dentro do mês', `tudo que foi pago no mês, de qualquer parcela · ${brlCurto(rec.fa + rec.ja)} eram atrasados`, brl(rec.f + rec.j)) +
      (jur.valor ? linha('Advogado / débito judicial', `parcelas de acordo que venceram no mês e não foram pagas · ${plural(jur.alunos, 'aluno', 'alunos')} · o Financeiro não cobra`, brl(jur.valor)) : '')
    : '<div class="tabela-msg">Sem mensalidades com vencimento neste mês.</div>';
}

function avisoMes() {
  if (mesesDados[mes]?.vazio) return `Os números de ${nomeMes(mes)} aparecem depois da próxima atualização do Edubox (o agente passou a guardar os meses em 02/10/2026).`;
  return `Mês de ${nomeMes(mes)}: parcelas que vencem em ${nomeMes(mes)} — "atrasado" é o que delas ainda não foi pago. "Entrou" é tudo que foi pago dentro do mês, de qualquer parcela.`;
}
function recorte() {
  if (usaMes()) return mesesDados[mes]?.[grupo] || null;
  const r = painel?.resumo?.[semestre]?.[grupo];
  return r || null;
}
// Advogado/Débito seguem o mesmo semestre do resto (ver somaBaixas).
function recorteJuridico() {
  return recorte();
}

// Soma das baixas de uma lista de dias, no grupo/semestre escolhidos.
function somaBaixas(dias) {
  const t = { financeiro: 0, juridico: 0, financeiroAtraso: 0, juridicoAtraso: 0 };
  for (const d of dias) {
    if (semestre === 'todos') {
      t.financeiro += d[grupo].financeiro.valor; t.juridico += d[grupo].juridico.valor;
      t.financeiroAtraso += d[grupo].financeiro.emAtraso; t.juridicoAtraso += d[grupo].juridico.emAtraso;
    } else {
      // Advogado/Débito também seguem o semestre escolhido — o da dívida
      // original, que é como o Edubox registra o acordo (pedido 01/10/2026).
      const s = d.porSemestre?.[semestre]?.[grupo];
      if (s) for (const k in t) t[k] += s[k];
    }
  }
  return t;
}

// Advogado (Advogado Fatec / Advogado Medicina = acordo feito) x Débito
// judicial (com a advogada, sem acordo), a partir dos planos jurídicos.
function ladosJuridico(rj) {
  const novo = () => ({ valor: 0, aPagar: 0, alunos: 0, aVencer: 0 });
  const saida = { advogado: novo(), debito: novo() };
  for (const [plano, x] of Object.entries((rj && rj.planosJuridico) || {})) {
    const lado = /ADVOGADO/i.test(plano) ? saida.advogado : saida.debito;
    lado.valor += x.vencido.valor; lado.aPagar += apDe(x.vencido); lado.alunos += x.vencido.alunos; lado.aVencer += x.aVencer.valor;
  }
  return saida;
}
function ehModoAdvogado(modo) { return modo === 'advogado' || modo === 'debito'; }
// Modos em que o Financeiro NÃO cobra (sem WhatsApp): advogado, débito e "enviar".
function ehModoSemCobranca(modo) { return ehModoAdvogado(modo) || modo === 'enviar'; }

function renderPainel() {
  const r = recorte();
  const vazio = { valor: 0, alunos: 0, parcelas: 0 };
  const v = r ? r.vencido : vazio;
  const rj = recorteJuridico();
  const fin = r ? r.financeiro.vencido : vazio;
  const jur = rj ? rj.juridico.vencido : vazio;
  const finAdv = (r && r.financeiroComAdvogado) || vazio;
  // Quem manda é o plano da parcela: parcela normal é do Financeiro mesmo
  // que o aluno tenha acordo; Advogado (acordo feito) e Débito judicial (sem
  // acordo) não são cobrados pelo Financeiro.
  document.getElementById('k-vencido').innerHTML = `${brl(apDe(fin))}<small class="cb-orig">valor original ${brl(fin.valor)} + juros e multa</small>`;
  const devFin = (r && r.devido && r.devido.financeiro) || 0;
  document.getElementById('k-vencido-hint').innerHTML = [
    `${plural(fin.alunos, 'aluno', 'alunos')}, ${plural(fin.parcelas, 'parcela', 'parcelas')}`,
    devFin ? `<b>${pct(fin.valor / devFin)}</b> do que já venceu (${brlCurto(devFin)})` : '',
    finAdv.alunos ? `${plural(finAdv.alunos, 'aluno também tem', 'alunos também têm')} acordo com advogado` : '',
    r && r.enviar && r.enviar.vencido.valor ? `Fora da cobrança: ${brlCurto(r.enviar.vencido.valor)} de ${plural(r.enviar.vencido.alunos, 'desistente/trancado/cancelado', 'desistentes/trancados/cancelados')}` : ''
  ].filter(Boolean).map(l => `<span class="cb-hint-linha">${l}</span>`).join('');
  const lados = ladosJuridico(rj);
  // "pagando" é por aluno (não por semestre): só faz sentido no total
  const sit = semestre === 'todos' ? ((painel.situacaoAdvogado && painel.situacaoAdvogado[grupo]) || {}) : {};
  const dicaJur = (x, s) => `${plural(x.alunos, 'aluno', 'alunos')} · mais ${brlCurto(x.aVencer)} a vencer` +
    (s && s.alunos ? ` · ${s.pagando} de ${s.alunos} alunos pagaram algo nos últimos 90 dias (${brlCurto(s.pago90)})` : '') + ' · o Financeiro não cobra';
  document.getElementById('k-jur').innerHTML = `${brl(lados.advogado.aPagar)}<small class="cb-orig">valor original ${brl(lados.advogado.valor)}</small>`;
  document.getElementById('k-jur-hint').textContent = dicaJur(lados.advogado, sit.advogado);
  document.getElementById('k-fin').innerHTML = `${brl(lados.debito.aPagar)}<small class="cb-orig">valor original ${brl(lados.debito.valor)}</small>`;
  document.getElementById('k-fin-hint').textContent = dicaJur(lados.debito, sit.debito);
  const aviso = document.getElementById('aviso-advogado');
  aviso.classList.toggle('hidden', semestre === 'todos');
  aviso.textContent = usaMes() ? avisoMes() : `Semestre ${semestre}: tudo neste painel é deste semestre. Advogado e Débito judicial entram pelo semestre da dívida original (é como o Edubox registra o acordo) — escolha "Todos os anos" para ver o total e a divisão por semestre.`;
  renderSemestres();

  const recMes = usaMes() ? mesesDados[mes]?.recebido?.[grupo] : null;
  const periodo = mesesDoPeriodo();
  const semestreFiltrado = !usaMes() && periodo;
  document.getElementById('k-recebido-rot').textContent = usaMes() ? `Entrou em ${nomeMes(mes)}` : semestreFiltrado ? `Entrou no ${nomePeriodo()}` : 'Entrou nesta semana';
  const b = somaBaixas(painel.semana.baixas);
  const hojeISO = iso(new Date());
  const bh = somaBaixas(painel.semana.baixas.filter(d => d.data === hojeISO));
  if (semestreFiltrado) {
    if (!recebidoDados && !carregandoRecebido) { carregandoRecebido = true; apiFetch('/cobranca/edubox/recebido').then(d => { recebidoDados = d || {}; }).catch(() => { recebidoDados = {}; }).finally(() => { carregandoRecebido = false; if (visao === 'painel') renderPainel(); }); }
    const x = { f: 0, j: 0, fa: 0 };
    for (const m of periodo) { const y = recebidoDados?.meses?.[m]?.[grupo]; if (y) { x.f += y.f; x.j += y.j; x.fa += y.fa; } }
    document.getElementById('k-recebido').textContent = recebidoDados ? brl(x.f + x.j) : '…';
    document.getElementById('k-recebido-hint').textContent = `Baixas no Edubox com data de pagamento no ${nomePeriodo()} · Financeiro ${brlCurto(x.f)} · Advogado/Débito ${brlCurto(x.j)} · ${brlCurto(x.fa)} eram mensalidades atrasadas`;
  } else if (usaMes()) {
    const x = recMes || { f: 0, j: 0, fa: 0 };
    document.getElementById('k-recebido').textContent = brl(x.f + x.j);
    document.getElementById('k-recebido-hint').textContent = `Baixas no Edubox dentro do mês · Financeiro ${brlCurto(x.f)} · Advogado/Débito ${brlCurto(x.j)} · ${brlCurto(x.fa)} eram mensalidades atrasadas`;
  } else {
    document.getElementById('k-recebido').textContent = brl(b.financeiro + b.juridico);
    document.getElementById('k-recebido-hint').textContent = `Baixas no Edubox de segunda até agora · Financeiro ${brlCurto(b.financeiro)} · Advogado/Débito ${brlCurto(b.juridico)} · só hoje ${brlCurto(bh.financeiro + bh.juridico)}`;
  }

  const maxF = Math.max(1, ...FAIXAS.map(([k]) => r ? r.faixas[k].valor : 0));
  document.getElementById('faixas').innerHTML = FAIXAS.map(([k, rot, cor]) => {
    const f = r ? r.faixas[k] : vazio;
    return `<div class="cb-faixa" data-dica="${esc(`${rot}|${brl(apDe(f))} com juros e multa|valor original ${brl(f.valor)}|${plural(f.alunos, 'aluno', 'alunos')}`)}"><span>${rot}</span><div class="cb-faixa-barra"><span style="width:${(f.valor / maxF) * 100}%;background:${cor}"></span></div><b>${brlCurto(apDe(f))}<small>${plural(f.alunos, 'aluno', 'alunos')} · original ${brlCurto(f.valor)}</small></b></div>`;
  }).join('');

  // Mês que já terminou: faixas de atraso (contadas a partir de hoje) e "a
  // vencer" não dizem nada sobre o mês — mostra como o mês fechou (02/10/2026).
  const mesFechado = usaMes() && fimDoMes(mes) < iso(new Date());
  document.getElementById('card-mes-fechou').classList.toggle('hidden', !mesFechado);
  document.getElementById('bloco-faixas-avencer').classList.toggle('hidden', mesFechado);
  if (mesFechado) renderMesFechou(r, fin);

  const av = r ? r.aVencer : vazio;
  // período do "ainda vai vencer": de hoje até o fim do semestre escolhido (pelo vencimento)
  const fimSem = usaMes() ? fmtData(fimDoMes(mes)) : (semestre === 'todos' ? null : (semestre.endsWith('.1') ? `30/06/${semestre.slice(0, 4)}` : `31/12/${semestre.slice(0, 4)}`));
  const rotRec = usaMes() ? nomeMes(mes) : semestre;
  document.getElementById('a-vencer-periodo').textContent = usaMes() && fimDoMes(mes) < iso(new Date())
    ? `— ${nomeMes(mes)} já terminou: nada mais a vencer neste mês`
    : fimSem
    ? `— vence de hoje até ${fimSem} · valor sem juros (não é atraso)`
    : '— tudo que ainda vai vencer, de qualquer semestre · valor sem juros (não é atraso)';
  // Previsão mês a mês até o fim do semestre: no semestre atual e no mês atual
  const prev = previsaoMeses();
  if (prev && (usaMes() ? mes === iso(new Date()).slice(0, 7) : semestre === semestreAtual())) {
    document.getElementById('a-vencer-periodo').textContent = '— previsão do que vence até o fim do semestre · valor sem juros (não é atraso)';
    document.getElementById('a-vencer').innerHTML = prev;
  } else document.getElementById('a-vencer').innerHTML = `
    <div><span>Financeiro${semestre !== 'todos' ? ` (${rotRec})` : ''}</span><b>${brl(r ? r.financeiro.aVencer.valor : 0)}</b> <small class="cb-sub">${plural(r ? r.financeiro.aVencer.alunos : 0, 'aluno', 'alunos')}</small></div>
    <div><span>Advogado + Débito judicial${semestre !== 'todos' ? ` (${rotRec})` : ''}</span><b>${brl(rj ? rj.juridico.aVencer.valor : 0)}</b> <small class="cb-sub">${plural(rj ? rj.juridico.aVencer.alunos : 0, 'aluno', 'alunos')}</small></div>
    <div style="grid-column:1/-1"><span>Total que ainda vai vencer</span><b>${brl((r ? r.financeiro.aVencer.valor : 0) + (rj ? rj.juridico.aVencer.valor : 0))}</b></div>`;

  // por plano jurídico (acumulado) + recebido na semana
  const thEntrou = document.getElementById('th-planos-entrou');
  thEntrou.textContent = 'Entrou nesta semana';
  thEntrou.closest('table').classList.toggle('cb-sem-entrou', !!mesesDoPeriodo());   // com período escolhido, "esta semana" não faz parte do filtro
  const planos = rj ? Object.entries(rj.planosJuridico || {}) : [];
  const recPlano = {};
  for (const d of painel.semana.baixas) for (const [k, val] of Object.entries(d[grupo].juridico.porPlano || {})) recPlano[k] = (recPlano[k] || 0) + val;
  const tp = document.getElementById('tb-planos');
  tp.innerHTML = planos.length
    ? planos.sort((a, b2) => b2[1].vencido.valor - a[1].vencido.valor).map(([k, x]) =>
        `<tr><td>${esc(k)}</td><td class="num">${x.vencido.alunos}</td><td class="num">${celAP(x.vencido, true)}</td><td class="num">${brl(x.aVencer.valor)}</td><td class="num">${brl(recPlano[k] || 0)}</td></tr>`).join('') +
      `<tr class="mes-linha"><td><b>Total</b></td><td class="num"><b>${jur.alunos}</b></td><td class="num"><b>${brl(jur.valor)}</b></td><td class="num"><b>${brl(rj.juridico.aVencer.valor)}</b></td><td class="num"><b>${brl(Object.values(recPlano).reduce((s2, x) => s2 + x, 0))}</b></td></tr>`
    : '<tr><td colspan="5" class="tabela-msg">Nenhum aluno com advogado neste grupo.</td></tr>';

  const cursos = r ? Object.entries(r.porCurso).sort((a, b2) => b2[1].vencido.valor - a[1].vencido.valor) : [];
  const tb = document.getElementById('tb-cursos');
  if (!cursos.length) { tb.innerHTML = '<tr><td colspan="5" class="tabela-msg">Nada vencido neste recorte.</td></tr>'; return; }
  tb.innerHTML = cursos.map(([c, x]) => `<tr><td>${esc(nomeCurso(c))}</td><td class="num">${x.vencido.alunos}</td><td class="num">${celAP(x.financeiroVencido)}</td><td class="num">${celAP(x.juridicoVencido)}</td><td class="num">${celAP(x.vencido, true)}</td></tr>`).join('') +
    `<tr class="mes-linha"><td><b>Total</b></td><td class="num"><b>${v.alunos}</b></td><td class="num">${celAP(fin, true)}</td><td class="num">${celAP(r.juridico.vencido, true)}</td><td class="num">${celAP(v, true)}</td></tr>`;
}

// "Todos os semestres": quanto tem em cada semestre, pra conta ficar clara.
function renderSemestres() {
  const card = document.getElementById('card-semestres');
  card.classList.toggle('hidden', semestre !== 'todos');
  if (semestre !== 'todos') return;
  const linhas = Object.entries(painel.resumo || {})
    .filter(([s, gr]) => s !== 'todos' && gr[grupo] && gr[grupo].vencido.valor > 0)
    .map(([s, gr]) => ({ s, g: gr[grupo], l: ladosJuridico(gr[grupo]) }))
    // mais novo primeiro; "sem semestre" (parcela sem semestre no Edubox) por último
    .sort((a, b) => (/^\d/.test(b.s) - /^\d/.test(a.s)) || b.s.localeCompare(a.s));
  const tot = painel.resumo.todos[grupo];
  const lt = ladosJuridico(tot);
  document.getElementById('tb-semestres').innerHTML = linhas.map(({ s, g, l }) => `
    <tr data-sem="${esc(s)}"><td><b>${esc(s)}</b></td><td class="num">${g.vencido.alunos}</td><td class="num">${celAP(g.financeiro.vencido)}</td>
      <td class="num">${l.advogado.valor ? celAP(l.advogado) : '—'}</td><td class="num">${l.debito.valor ? celAP(l.debito) : '—'}</td>
      <td class="num">${celAP(g.vencido, true)}</td></tr>`).join('') +
    `<tr class="mes-linha"><td><b>Total</b></td><td class="num"><b>${tot.vencido.alunos}</b></td><td class="num">${celAP(tot.financeiro.vencido, true)}</td>
      <td class="num">${celAP(lt.advogado, true)}</td><td class="num">${celAP(lt.debito, true)}</td><td class="num">${celAP(tot.vencido, true)}</td></tr>`;
}

// ---------- VISÃO DO DIRETOR ----------
// Poucos números grandes pra quem não é do financeiro: % de inadimplência
// (e se melhorou desde segunda), dinheiro que entrou, resultado das cobranças,
// gráfico semana a semana, cursos com mais atraso e situação dos acordos.
function brlCurto(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e6) return `R$ ${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`;
  if (Math.abs(n) >= 1e3) return `R$ ${Math.round(n / 1e3).toLocaleString('pt-BR')} mil`;
  return brl(n);
}
const pct = (v, casas = 1) => `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;

async function renderDiretor() {
  const r = recorte();
  if (!r) return;
  if (!semanasDados) {
    try { semanasDados = (await apiFetch('/cobranca/edubox/semanas')).semanas || {}; } catch (e) { semanasDados = {}; }
  }
  const seg = iso(segunda());
  // no mês não tem "como estava na segunda" — essa comparação é semanal
  const w = usaMes() ? {} : (semanasDados[seg]?.[grupo]?.[semestre] || {});
  const rotSem = usaMes() ? `mês de ${nomeMes(mes)}` : semestre === 'todos' ? 'todos os semestres' : `semestre ${semestre}`;

  // 1) Inadimplência
  const venc = r.financeiro.vencido.valor;
  const devido = (r.devido && r.devido.financeiro) || 0;
  const inad = devido ? venc / devido : null;
  let seta = '';
  if (inad !== null && w.ini && w.ini.fd) {
    const antes = w.ini.f / w.ini.fd;
    const dif = (inad - antes) * 100;
    seta = `<span class="cb-dir-seta ${Math.abs(dif) < 0.05 ? 'igual' : dif > 0 ? 'sobe' : 'desce'}">Segunda: ${pct(antes)} → hoje: ${pct(inad)} ${Math.abs(dif) < 0.05 ? '=' : dif > 0 ? '▲ piorou' : '▼ melhorou'}</span>`;
  }
  document.getElementById('d-inad').innerHTML = `
    <div class="cb-dir-rotulo">Inadimplência · ${esc(nomeGrupo())} · ${esc(rotSem)}</div>
    <div class="cb-dir-numero ${inad === null ? '' : inad > 0.05 ? 'ruim' : 'bom'}">${inad === null ? '—' : `${pct(inad)} <small style="font-size:1rem;font-weight:700">em atraso</small>`}</div>
    <div class="cb-dir-texto">${inad === null
      ? 'Aguardando a próxima atualização do Edubox para calcular.'
      : `<b>${brlCurto(venc).replace(/ mi$/, ' milhões')}</b> não pagos (<b>${brlCurto(apDe(r.financeiro.vencido)).replace(/ mi$/, ' milhões')}</b> com juros e multa), de <b>${brlCurto(devido).replace(/ mi$/, ' milhões')}</b> que já venceram. Quanto menor, melhor. (Sem contar advogado e débito judicial.)`}</div>
    ${seta}`;

  // 2) Dinheiro que entrou na semana (ou no mês) + taxa de recuperação
  if (usaMes()) {
    const x = mesesDados[mes]?.recebido?.[grupo] || { f: 0, j: 0, fa: 0, ja: 0 };
    document.getElementById('d-receb').innerHTML = `
      <div class="cb-dir-rotulo">🟢 Entrou em ${esc(nomeMes(mes))}</div>
      <div class="cb-dir-numero bom">${brlCurto(x.f + x.j)}</div>
      <div class="cb-dir-texto">Tudo que foi pago dentro do mês. Disso, <b>${brlCurto(x.fa + x.ja)}</b> foi pagamento de parcela atrasada (Financeiro ${brlCurto(x.fa)} · advogado/débito ${brlCurto(x.ja)}); o resto foi pago em dia.</div>`;
  }
  const rec = w.rec || null;
  const b = rec ? { f: rec.f + rec.j, fa: rec.fa } : (() => { const t = somaBaixas(painel.semana.baixas); return { f: t.financeiro + t.juridico, fa: t.financeiroAtraso }; })();
  const taxa = w.ini && w.ini.f ? b.fa / w.ini.f : null;
  if (!usaMes()) document.getElementById('d-receb').innerHTML = `
    <div class="cb-dir-rotulo">🟢 Entrou nesta semana <small style="text-transform:none;font-weight:500">(de segunda até agora)</small></div>
    <div class="cb-dir-numero bom">${brlCurto(b.f)}</div>
    <div class="cb-dir-texto">${taxa !== null
      ? `Disso, <b>${brlCurto(b.fa)}</b> foi pagamento de mensalidade atrasada: <b>${pct(taxa, 0)} do atraso de segunda (${brlCurto(w.ini.f)}) já foi recuperado</b>. O resto foi pago em dia.`
      : `${brlCurto(b.fa)} vieram de parcelas atrasadas.`}</div>`;

  // 3) Resultado das cobranças (funil)
  const cobrEl = document.getElementById('d-cobr');
  const rotCobr = usaMes() ? `Cobranças do Financeiro em ${esc(nomeMes(mes))}` : 'Cobranças do Financeiro na semana';
  const iniCobr = usaMes() ? `${mes}-01` : seg;
  const fimCobr = usaMes() ? [fimDoMes(mes), iso(new Date())].sort()[0] : iso(somaDias(segunda(), 6));
  cobrEl.innerHTML = `<div class="cb-dir-rotulo">${rotCobr}</div><div class="cb-dir-texto">Carregando...</div>`;
  apiFetch(`/cobranca/edubox/retorno?inicio=${iniCobr}&fim=${fimCobr}`).then(rt => {
    const lista = rt.alunos.filter(x => (x.grupo || 'graduacao') === grupo);
    const prom = lista.filter(x => x.promessa).length;
    const pagaram = lista.filter(x => x.pagouDepois > 0);
    const valor = pagaram.reduce((s, x) => s + x.pagouDepois, 0);
    cobrEl.innerHTML = `
      <div class="cb-dir-rotulo">${rotCobr}</div>
      <div class="cb-funil">
        <div><b>${lista.length}</b><small>alunos cobrados</small></div><span>›</span>
        <div><b>${prom}</b><small>prometeram</small></div><span>›</span>
        <div><b>${pagaram.length}</b><small>pagaram</small></div>
      </div>
      <div class="cb-dir-texto" style="margin-top:0.5rem">${lista.length ? `${pct(pagaram.length / lista.length, 0)} dos cobrados já pagaram · <b>${brlCurto(valor)}</b> recebidos deles.` : 'Nenhuma cobrança registrada no Órbita neste período ainda.'}</div>`;
  }).catch(() => { cobrEl.innerHTML = `<div class="cb-dir-rotulo">${rotCobr}</div><div class="cb-dir-texto">Não foi possível carregar.</div>`; });

  // 4) Dinheiro que entrou — segue o semestre/mês escolhido (02/10/2026):
  //    mês -> as semanas daquele mês; semestre -> mês a mês; todos -> últimas 12 semanas.
  //    Sempre pela DATA DO PAGAMENTO, de qualquer parcela.
  if (!recebidoDados) {
    try { recebidoDados = await apiFetch('/cobranca/edubox/recebido'); } catch (e) { recebidoDados = {}; }
  }
  renderGraficoRecebido();

  // Inadimplência ao longo do ano: % de cada segunda + o valor de agora
  const ano = String(new Date().getFullYear());
  const pontos = Object.keys(semanasDados).sort()
    .filter(k => k.startsWith(ano))
    .map(k => ({ k, x: semanasDados[k]?.[grupo]?.[semestre] }))
    .filter(p => p.x && p.x.ini && p.x.ini.fd > 0)
    .map(p => ({ rot: fmtData(p.k).slice(0, 5), v: p.x.ini.f / p.x.ini.fd }));
  if (inad !== null) pontos.push({ rot: 'agora', v: inad });
  document.getElementById('d-inad-ano').innerHTML = pontos.length > 1
    ? graficoInadimplencia(pontos)
    : '<div class="tabela-msg">O histórico do ano ainda está sendo montado — volta a aparecer aqui em instantes.</div>';

  // 5) Cursos com mais atraso (%)
  document.getElementById('d-cursos-sub').textContent = `— ${rotSem}: % de cada curso = atrasado ÷ o que já venceu, só mensalidades do Financeiro`;
  const cursos = Object.entries(r.porCurso)
    .filter(([, c]) => c.devidoFinanceiro > 0 && c.financeiroVencido.valor > 0)
    .map(([nome, c]) => ({ nome, p: c.financeiroVencido.valor / c.devidoFinanceiro, v: c.financeiroVencido.valor }))
    .sort((a, b2) => b2.p - a.p).slice(0, 10);
  const maxP = Math.max(0.0001, ...cursos.map(c => c.p));
  document.getElementById('d-cursos').innerHTML = cursos.length
    ? cursos.map(c => `<div class="cb-rank"><span>${esc(nomeCurso(c.nome))}</span><div class="cb-rank-barra"><span style="width:${(c.p / maxP) * 100}%"></span></div><b>${pct(c.p)}<small>${brlCurto(c.v)} atrasado de ${brlCurto(c.v / c.p)}</small></b></div>`).join('')
    : '<div class="tabela-msg">Nada atrasado neste recorte.</div>';

  // 6) Advogado e débito judicial — sempre o TOTAL (o acordo é com o aluno e
  // as dívidas são de semestres antigos; "atrasado no 2026.2" dava R$ 0 e confundia)
  const sit = (painel.situacaoAdvogado && painel.situacaoAdvogado[grupo]) || {};
  const lados = ladosJuridico(painel.resumo.todos[grupo]);
  const linha = (titulo, s, l, dica) => {
    const tot = (s && s.alunos) || 0;
    const pg = (s && s.pagando) || 0;
    return `<div class="cb-adv-linha"><b>${titulo}</b> <small class="cb-sub">${dica}</small>
      <div class="cb-faixa-barra"><span style="width:${tot ? (pg / tot) * 100 : 0}%"></span></div>
      <div class="cb-dir-texto">💰 <b>${brlCurto(l.aPagar)} a pagar</b> (original ${brlCurto(l.valor)}, todos os semestres) · <b>${pg} de ${tot}</b> alunos pagaram algo nos últimos 90 dias (${brlCurto((s && s.pago90) || 0)} entrou)</div></div>`;
  };
  const env = painel.resumo.todos[grupo].enviar || { vencido: { valor: 0, alunos: 0 } };
  const envSem = r.enviar || { vencido: { valor: 0, alunos: 0 } };
  document.getElementById('d-adv').innerHTML =
    linha('⚖️ Acordos com advogado', sit.advogado, lados.advogado, 'acordo feito — paga direto') +
    linha('🏛 Débito judicial', sit.debito, lados.debito, 'com a advogada, ainda sem acordo') +
    `<div class="cb-adv-linha"><b>📤 Para enviar ao advogado</b> <small class="cb-sub">desistentes, trancados, cancelados — o Financeiro não cobra</small>
      <div class="cb-dir-texto">💰 <b>${brlCurto(apDe(env.vencido))} a pagar</b> (original ${brlCurto(env.vencido.valor)}) de ${plural(env.vencido.alunos, 'aluno', 'alunos')}${semestre !== 'todos' ? ` · no ${esc(usaMes() ? nomeMes(mes) : semestre)}: ${brlCurto(apDe(envSem.vencido))} de ${plural(envSem.vencido.alunos, 'aluno', 'alunos')}` : ''}</div></div>`;
}

function graficoInadimplencia(pontos) {
  const W = 820, H = 230, M = { t: 26, r: 24, b: 30, l: 44 };
  const max = Math.max(0.01, ...pontos.map(p => p.v)) * 1.15;
  const x = (i) => M.l + (pontos.length === 1 ? 0 : i * (W - M.l - M.r) / (pontos.length - 1));
  const y = (v) => H - M.b - (v / max) * (H - M.t - M.b);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Inadimplência por semana">`;
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    svg += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e2e8f0"/><text x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#94a3b8">${pct(v, 0)}</text>`;
  }
  const area = `${x(0)},${y(0)} ` + pontos.map((p, i) => `${x(i)},${y(p.v)}`).join(' ') + ` ${x(pontos.length - 1)},${y(0)}`;
  svg += `<polygon points="${area}" fill="#ef4444" opacity="0.08"/>`;
  svg += `<polyline points="${pontos.map((p, i) => `${x(i)},${y(p.v)}`).join(' ')}" fill="none" stroke="#ef4444" stroke-width="3" stroke-linejoin="round"/>`;
  const passo = Math.max(1, Math.ceil(pontos.length / 12)); // não amontoar rótulos
  pontos.forEach((p, i) => {
    const ultimo = i === pontos.length - 1;
    svg += `<circle cx="${x(i)}" cy="${y(p.v)}" r="${ultimo ? 6 : 3.5}" fill="${ultimo ? '#b91c1c' : '#ef4444'}"><title>${p.rot}: ${pct(p.v)}</title></circle>`;
    if (i % passo === 0 || ultimo) {
      svg += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#64748b">${p.rot}</text>`;
      svg += `<text x="${x(i)}" y="${y(p.v) - 9}" text-anchor="middle" font-size="11" font-weight="700" fill="#b91c1c">${pct(p.v)}</text>`;
    }
  });
  return svg + '</svg>';
}

function renderGraficoRecebido() {
  const titulo = document.getElementById('d-grafico-titulo');
  const sub = document.getElementById('d-grafico-sub');
  const el = document.getElementById('d-grafico');
  const hojeIso = iso(new Date());
  const soma = (x) => x ? (x.f || 0) + (x.j || 0) : 0;
  const dica = (x) => x ? `Financeiro ${brl(x.f || 0)} · advogado/débito ${brl(x.j || 0)}` : '';
  let itens = [];
  if (usaMes()) {
    const ws = (recebidoDados.semanas || {})[mes] || {};
    const ini = `${mes}-01`, fim = fimDoMes(mes);
    itens = Object.keys(ws).sort().map(seg => {
      const de = seg < ini ? ini : seg;
      const ate = [iso(somaDias(dataLocal(seg), 6)), fim].sort()[0];
      return { rot: `${fmtData(de).slice(0, 5)} a ${fmtData(ate).slice(0, 5)}`, v: soma(ws[seg][grupo]), dica: dica(ws[seg][grupo]), destaque: hojeIso >= de && hojeIso <= ate };
    });
    titulo.textContent = `💰 Dinheiro que entrou em ${nomeMes(mes)}, semana a semana`;
    sub.textContent = `— pagamentos baixados no Edubox dentro do mês (de qualquer parcela); a soma das barras é o "Entrou em ${nomeMes(mes)}" lá de cima`;
  } else if (semestre !== 'todos') {
    const ms = recebidoDados.meses || {};
    itens = mesesDoSemestre(semestre).map(m => ({ rot: NOMES_MES[Number(m.slice(5, 7)) - 1].slice(0, 3) + (m === hojeIso.slice(0, 7) ? ' (até hoje)' : ''), v: soma(ms[m]?.[grupo]), dica: dica(ms[m]?.[grupo]), destaque: m === hojeIso.slice(0, 7) }));
    titulo.textContent = `💰 Dinheiro que entrou no semestre ${semestre}, mês a mês`;
    sub.textContent = `— pagamentos baixados no Edubox em cada mês (de qualquer parcela, pela data do pagamento)`;
  } else {
    const semanas = Object.keys(semanasDados).sort().slice(-12)
      .map(k => ({ k, x: semanasDados[k]?.[grupo]?.todos || {} }))
      .filter(s => s.x.rec);
    itens = semanas.map((s, i) => ({ rot: i === semanas.length - 1 ? 'esta semana' : 'semana ' + fmtData(s.k).slice(0, 5), v: soma(s.x.rec), dica: dica(s.x.rec), destaque: i === semanas.length - 1 }));
    titulo.textContent = '💰 Dinheiro que entrou, semana a semana';
    sub.textContent = '— tudo que foi pago e baixado no Edubox em cada semana, de qualquer semestre (o atraso está no gráfico de baixo)';
  }
  el.innerHTML = itens.length ? graficoBarras(itens) : '<div class="tabela-msg">Os pagamentos deste período aparecem depois da próxima atualização do Edubox.</div>';
}

function graficoBarras(itens, tema = { f: '#10b981', fd: '#059669', t: '#047857' }) {
  // Só o dinheiro que entrou (barras). A linha do atraso, no mesmo desenho e
  // com outra escala, confundia quem não é do financeiro (02/10) — o atraso
  // fica no gráfico "Inadimplência ao longo do ano", em %.
  const W = 820, H = 240, M = { t: 28, r: 16, b: 34, l: 16 };
  const n = itens.length;
  const larg = (W - M.l - M.r) / n;
  const maxV = Math.max(1, ...itens.map(it => it.v));
  const yV = (v) => H - M.b - (v / maxV) * (H - M.t - M.b);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dinheiro que entrou">`;
  itens.forEach((it, i) => {
    const x = M.l + i * larg;
    const y = yV(it.v);
    svg += `<rect x="${x + larg * 0.18}" y="${y}" width="${larg * 0.64}" height="${H - M.b - y}" rx="6" fill="${it.destaque ? tema.fd : tema.f}" opacity="${it.destaque ? 1 : 0.8}"><title>${it.rot}: ${brl(it.v)}${it.dica ? ` — ${it.dica}` : ''}</title></rect>`;
    svg += `<text x="${x + larg / 2}" y="${y - 8}" text-anchor="middle" font-size="13" font-weight="700" fill="${tema.t}">${brlCurto(it.v)}</text>`;
    svg += `<text x="${x + larg / 2}" y="${H - 12}" text-anchor="middle" font-size="12" fill="#64748b">${it.rot}</text>`;
  });
  return svg + '</svg>';
}


// ---------- PANORAMA DA CARTEIRA ----------
// Resumo para a direção, no desenho do painel da consultoria Fiasini (07/10/2026), mas com os
// números do Órbita: só o que o Financeiro cobra (parcela normal de matrícula Ativo/Concluído/Pendente,
// sem advogado, débito judicial e "para enviar"), sem nome de aluno. Segue o semestre escolhido.
const TAXA_CRITICA = 0.10;   // pílula vermelha a partir de 10% de inadimplência (08/10/2026)

// Colunas verticais simples (linha do tempo): valor em cima, mês embaixo; dica no mouse/toque.
function miniBarras(itens, cor) {
  const max = Math.max(1, ...itens.map(i => i.v));
  return `<div class="cb-mini">${itens.map(i => `<div class="cb-mini-col" data-dica="${esc(`${i.rot}|${brl(i.v)}`)}"><span class="cb-mini-v">${brlCurto(i.v).replace('R$ ', '')}</span><i style="height:${Math.max(2, (i.v / max) * 100)}%;background:${cor}"></i><span class="cb-mini-m">${esc(i.rot)}</span></div>`).join('')}</div>`;
}

// Rosca "Posição da carteira": recebido / a vencer / atrasado.
function rosca(partes) {
  const tot = partes.reduce((t, p) => t + p.v, 0) || 1;
  const R = 52, C = 2 * Math.PI * R;
  let ac = 0;
  const arcos = partes.map(p => {
    const l = (p.v / tot) * C;
    const a = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${p.cor}" stroke-width="22" stroke-dasharray="${l} ${C - l}" stroke-dashoffset="${-ac}" transform="rotate(-90 70 70)" data-dica="${esc(`${p.rot}|${brl(p.v)} · ${pct(p.v / tot)} da carteira|${p.expl}`)}"/>`;
    ac += l; return a;
  }).join('');
  return `<div class="cb-rosca"><svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Posição da carteira">${arcos}
      <text x="70" y="67" text-anchor="middle" font-family="Archivo, sans-serif" font-weight="800" font-size="15" fill="#0d1b33">${brlCurto(tot).replace('R$ ', '')}</text>
      <text x="70" y="84" text-anchor="middle" font-size="10" fill="#8793a6">carteira</text></svg>
    <div class="cb-rosca-leg">${partes.map(p => `<div data-dica="${esc(`${p.rot}|${brl(p.v)}|${p.expl}`)}"><i style="background:${p.cor}"></i>${p.rot}<b>${brlCurto(p.v)}</b><small>${pct(p.v / tot, 0)}</small></div>`).join('')}</div></div>`;
}
function pintarRosca(recebido, aVencer, atrasado, sub) {
  document.getElementById('p-rosca-sub').textContent = sub;
  document.getElementById('p-rosca').innerHTML = recebido + aVencer + atrasado > 0
    ? rosca([
        { rot: 'Recebido', v: Math.max(0, recebido), cor: '#12935a', expl: 'já venceu e foi pago' },
        { rot: 'A vencer', v: aVencer, cor: '#1f6fb2', expl: 'mensalidade futura (não é atraso)' },
        { rot: 'Atrasado', v: atrasado, cor: '#c8392f', expl: 'venceu e não foi paga (valor original)' }])
    : '<div class="tabela-msg">Sem mensalidades neste recorte.</div>';
}

// Dica padronizada (igual ao painel do Luiz): título em negrito, valor em destaque e 1–2 linhas de
// contexto, no mouse e no toque. Vale para qualquer gráfico da tela:
//  - elemento com data-dica="Título|valor|linha|linha";
//  - linhas de barra (faixas de atraso, cursos): título = nome da linha, valor e contexto = o que está à direita;
//  - barras em SVG: usa o <title> da barra.
const SELETOR_DICA = '[data-dica], .cb-pan-faixa, .cb-faixa, .cb-rank, svg rect, svg circle';
function textoDica(alvo) {
  if (alvo.dataset && alvo.dataset.dica) return alvo.dataset.dica.split('|');
  if (alvo.matches('.cb-pan-faixa, .cb-faixa, .cb-rank')) {
    const nome = (alvo.querySelector(':scope > span') || {}).textContent || '';
    const b = alvo.querySelector(':scope > b');
    if (!b) return null;
    const small = b.querySelector('small');
    const valor = [...b.childNodes].filter(n => n !== small && !(n.classList && n.classList.contains('kpi-lupa'))).map(n => n.textContent).join('').trim();
    const ctx = small ? small.textContent.replace(/\s+/g, ' ').trim() : '';
    return [nome.trim(), valor, ...ctx.split(' · ').filter(Boolean)];
  }
  const t = alvo.querySelector && alvo.querySelector('title');
  if (t) { const [cab, ...resto] = t.textContent.split(/: | — /); return resto.length ? [cab, ...resto] : [t.textContent]; }
  return null;
}
function ligarDicas() {
  const d = document.createElement('div');
  d.className = 'cb-dica'; document.body.appendChild(d);
  const mostrar = (alvo, x, y) => {
    const linhas = textoDica(alvo);
    if (!linhas || !linhas[0]) { d.style.opacity = 0; return; }
    const [t, valor, ...ctx] = linhas;
    d.innerHTML = `<div class="t">${esc(t)}</div>${valor ? `<b>${esc(valor)}</b>` : ''}${ctx.map(l => `<div>${esc(l)}</div>`).join('')}`;
    d.style.opacity = 1;
    const p = 14, w = d.offsetWidth, h = d.offsetHeight;
    let left = x + p, top = y + p;
    if (left + w > window.innerWidth - 8) left = x - w - p;
    if (top + h > window.innerHeight - 8) top = y - h - p;
    d.style.left = `${left}px`; d.style.top = `${top}px`;
  };
  const achar = (el) => (el && el.closest ? el.closest(SELETOR_DICA) : null);
  document.addEventListener('mousemove', (e) => { const a = achar(e.target); if (a) mostrar(a, e.clientX, e.clientY); else d.style.opacity = 0; });
  document.addEventListener('touchstart', (e) => { const a = achar(e.target); if (a) { const t = e.touches[0]; mostrar(a, t.clientX, t.clientY); } else d.style.opacity = 0; }, { passive: true });
}

const FAIXAS_PAN = [['1 a 30 dias', 1, 30, '#edc24e'], ['31 a 60 dias', 31, 60, '#e79a39'], ['61 a 90 dias', 61, 90, '#e8791e'], ['91 a 180 dias', 91, 180, '#d8542e'], ['Mais de 180 dias', 181, 1e9, '#b12f28']];
// Contexto pros números do Panorama (revisão com a skill kpi-dashboard-design, 08/10/2026):
// todo indicador mostra com o que comparar. Inadimplência: como estava na segunda-feira.
function tendenciaInad(hoje) {
  if (hoje === null || usaMes() || semestre === 'consultoria') return '';
  if (!semanasDados) { carregarContextoPanorama(); return ''; }
  const w = semanasDados[iso(segunda())]?.[grupo]?.[semestre];
  if (!w || !w.ini || !w.ini.fd) return '';
  const antes = w.ini.f / w.ini.fd, dif = (hoje - antes) * 100;
  if (Math.abs(dif) < 0.05) return '<span class="cb-tend igual">igual à segunda-feira</span>';
  return `<span class="cb-tend ${dif > 0 ? 'sobe' : 'desce'}">${dif > 0 ? '▲ piorou' : '▼ melhorou'} desde segunda (${pct(antes)})</span>`;
}
// Recuperado dividido: atraso do próprio período x dívida de semestres anteriores (pelo
// semestre de vencimento da parcela). Só pra mês/semestre; precisa do agente de 08/10/2026.
function recuperadoDivisao() {
  const periodo = mesesDoPeriodo();
  if (!periodo) return '';
  const fonte = usaMes() ? { [mes]: mesesDados[mes]?.recebido } : recebidoDados?.meses;
  if (!fonte) return '';
  const semDoPeriodo = usaMes() ? `${mes.slice(0, 4)}.${Number(mes.slice(5, 7)) <= 6 ? 1 : 2}` : semestre;
  let proprio = 0, anterior = 0, tem = false;
  for (const m of periodo) {
    const aSem = fonte[m]?.[grupo]?.aSem;
    if (!aSem) continue;
    tem = true;
    for (const [sv, v] of Object.entries(aSem)) { if (sv === semDoPeriodo) proprio += v; else anterior += v; }
  }
  if (!tem) return '';
  return `<span class="cb-hint-linha">${brlCurto(proprio)} de parcelas do ${semDoPeriodo.endsWith('.1') ? '1º' : '2º'} semestre de ${semDoPeriodo.slice(0, 4)}</span><span class="cb-hint-linha">${brlCurto(anterior)} de semestres anteriores</span>`;
}
// Recuperado = pagamento de parcela atrasada, pela data do pagamento, no período do filtro.
function recuperadoPeriodo() {
  if (usaMes()) { const x = mesesDados[mes]?.recebido?.[grupo]; return x ? x.fa + x.ja : 0; }
  const periodo = mesesDoPeriodo();
  if (periodo) {
    if (!recebidoDados) { carregarContextoPanorama(); return null; }
    return periodo.reduce((t, m) => { const y = recebidoDados.meses?.[m]?.[grupo]; return t + (y ? y.fa + y.ja : 0); }, 0);
  }
  if (!semanasDados) { carregarContextoPanorama(); return null; }
  const w = semanasDados[iso(segunda())]?.[grupo]?.todos?.rec;
  return w ? w.fa + w.ja : 0;
}
let carregandoContexto = false;
function carregarContextoPanorama() {
  if (carregandoContexto) return;
  carregandoContexto = true;
  Promise.all([
    semanasDados ? null : apiFetch('/cobranca/edubox/semanas').then(d => { semanasDados = d.semanas || {}; }).catch(() => { semanasDados = {}; }),
    recebidoDados ? null : apiFetch('/cobranca/edubox/recebido').then(d => { recebidoDados = d || {}; }).catch(() => { recebidoDados = {}; })
  ]).finally(() => { carregandoContexto = false; if (visao === 'panorama') renderTudo(); });
}

async function renderPanorama() {
  const consult = semestre === 'consultoria';
  document.getElementById('p-divisao').classList.toggle('hidden', !consult);
  document.getElementById('p-aviso').innerHTML = consult
    ? `<b>Visão consultoria:</b> inclui Advogado, Débito judicial e desistentes/trancados/cancelados; apenas parcelas de ${anoAtual()}; mesma régua de hoje do painel Fiasini. Só parcela com matrícula (protocolo e eventos ficam fora, como no Fiasini). Aluno que deve nos dois semestres conta uma vez só. Não mostra nome de aluno.`
    : 'Resumo da carteira de atraso <b>do que o Financeiro cobra</b> (sem advogado, débito judicial e desistentes), organizado a partir do painel da consultoria Fiasini. Não mostra nome de aluno. Muda com o semestre escolhido acima.';
  document.getElementById('p-tl-fut-tit').textContent = consult ? `A vencer até dezembro de ${anoAtual()} (todos os grupos, já com desconto)` : 'A vencer nos próximos meses (Financeiro)';
  if (consult) return renderConsultoria();
  const r = recorte();
  if (!r) return;
  if (!listas[grupo]) {
    try { listas[grupo] = await apiFetch(`/cobranca/edubox/alunos?grupo=${grupo}`); }
    catch (err) { document.getElementById('p-kpis').innerHTML = `<div class="tabela-msg">Não foi possível carregar: ${esc(err.message)}</div>`; return; }
  }
  const hoje = Date.now();
  const porAluno = new Map();
  const meses = {};
  const aging = FAIXAS_PAN.map(() => ({ v: 0, n: new Set() }));
  for (const a of listas[grupo].alunos) {
    for (const p of a.parcelas) {
      if (p.j || p.e) continue;
      if (semestre !== 'todos' && p.s !== semestre) continue;
      if (usaMes() && p.v.slice(0, 7) !== mes) continue;
      const dias = Math.round((hoje - dataLocal(p.v).getTime()) / 86400000);
      if (dias < 1) continue;
      porAluno.set(a.chave, (porAluno.get(a.chave) || 0) + p.valor);
      const f = FAIXAS_PAN.findIndex(([, de, ate]) => dias >= de && dias <= ate);
      aging[f].v += p.valor; aging[f].n.add(a.chave);
      meses[p.v.slice(0, 7)] = (meses[p.v.slice(0, 7)] || 0) + p.valor;
    }
  }
  const V = [...porAluno.values()].reduce((s, x) => s + x, 0);
  const N = porAluno.size;
  const devido = (r.devido && r.devido.financeiro) || 0;
  const taxaGeral = devido ? V / devido : null;
  const critico = aging[3].v + aging[4].v;

  // curva ABC pelo atrasado de cada aluno
  const ordenados = [...porAluno.values()].sort((a, b) => b - a);
  const ABC = { A: { n: 0, v: 0 }, B: { n: 0, v: 0 }, C: { n: 0, v: 0 } };
  let antes = 0;
  for (const v of ordenados) {
    const k = antes < V * 0.8 ? 'A' : antes < V * 0.95 ? 'B' : 'C';
    ABC[k].n++; ABC[k].v += v; antes += v;
  }

  // cursos (mensalidades do Financeiro)
  const cursos = Object.entries(r.porCurso || {})
    .filter(([, c]) => c.devidoFinanceiro > 0 && c.financeiroVencido.valor > 0)
    .map(([nome, c]) => ({ nome, v: c.financeiroVencido.valor, alunos: c.financeiroVencido.alunos, taxa: c.financeiroVencido.valor / c.devidoFinanceiro }));
  const piorTaxa = [...cursos].filter(c => c.alunos >= 5).sort((a, b) => b.taxa - a.taxa)[0];   // curso com poucos alunos distorce a taxa

  // 1) números principais
  const kpi = (cls, rot, val, dica) => `<div class="kpi-card ${cls}"><div class="kpi-label">${rot}</div><div class="kpi-value">${val}</div><div class="kpi-hint">${dica}</div></div>`;
  document.getElementById('p-kpis').innerHTML =
    kpi('cb-kpi-vencido', 'Atrasado — Financeiro cobra', brlCurto(V), `${esc(nomeGrupo())} · ${esc(nomeSemestre())}`) +
    kpi('', 'Inadimplência sobre o vencido', taxaGeral === null ? '—' : pct(taxaGeral), (devido ? `atrasado ÷ ${brlCurto(devido)} que já venceram` : 'sem base') + tendenciaInad(taxaGeral)) +
    kpi('', 'Alunos em atraso', N.toLocaleString('pt-BR'), `média de ${N ? brlCurto(V / N) : '—'} por aluno, valor original`) +
    kpi('kpi-ass', 'Recuperado no período', recuperadoPeriodo() === null ? '…' : brlCurto(recuperadoPeriodo()), `parcelas atrasadas que foram pagas ${usaMes() ? 'em ' + nomeMes(mes) : /^\d{4}\.[12]$/.test(semestre) ? 'no ' + nomePeriodo() : 'nesta semana'}` + recuperadoDivisao()) +
    kpi('kpi-menor', 'Atraso crítico (+90 dias)', brlCurto(critico), V ? `${pct(critico / V, 0)} do atrasado` : '') +
    kpi('kpi-sem', 'Classe A (alta prioridade)', `${ABC.A.n} alunos`, V ? `respondem por ${pct(ABC.A.v / V, 0)} do atrasado` : '');

  pintarRosca(devido - r.financeiro.vencido.valor, r.financeiro.aVencer.valor, r.financeiro.vencido.valor, '— mensalidades do Financeiro, valor original');

  // 2) o que chama atenção, em frase
  const ins = [];
  if (V) {
    ins.push(`<div class="ruim"><small>Concentração de risco</small><b>${ABC.A.n} alunos</b> (${pct(ABC.A.n / N, 0)} dos devedores) respondem por <b>${pct(ABC.A.v / V, 0)}</b> do atrasado (${brlCurto(ABC.A.v)}). Priorizar a cobrança neles rende o maior retorno.</div>`);
    if (piorTaxa) ins.push(`<div class="azul"><small>Curso com maior taxa</small><b>${esc(nomeCurso(piorTaxa.nome))}</b>: ${pct(piorTaxa.taxa)} de inadimplência (${brlCurto(piorTaxa.v)}, ${plural(piorTaxa.alunos, 'aluno', 'alunos')})${taxaGeral !== null ? `, contra ${pct(taxaGeral)} na média` : ''}.</div>`);
    ins.push(`<div class="ruim"><small>Atraso crítico</small><b>${brlCurto(critico)}</b> (${pct(critico / V, 0)} do atrasado) já passou de 90 dias — candidato a renegociação formal ou provisão.</div>`);
  }
  document.getElementById('p-insights').innerHTML = ins.join('');

  // 3) idade do atraso
  const maxA = Math.max(1, ...aging.map(x => x.v));
  document.getElementById('p-aging').innerHTML = V ? FAIXAS_PAN.map(([rot, , , cor], i) =>
    `<div class="cb-pan-faixa"><span>${rot}</span><div class="trilho"><i style="width:${(aging[i].v / maxA) * 100}%;background:${cor}"></i></div><b>${brlCurto(aging[i].v)}<small>${plural(aging[i].n.size, 'aluno', 'alunos')} · ${pct(aging[i].v / V, 0)}</small></b></div>`).join('')
    : '<div class="tabela-msg">Nada atrasado neste recorte.</div>';

  // 4) cursos
  const lista = [...cursos].sort((a, b) => (panMetric === 'taxa' ? b.taxa - a.taxa : b.v - a.v)).slice(0, 12);
  const maxC = Math.max(0.0001, ...lista.map(c => (panMetric === 'taxa' ? c.taxa : c.v)));
  document.getElementById('p-cursos').innerHTML = lista.length
    ? lista.map(c => `<div class="cb-rank cb-rank-link" data-curso="${esc(c.nome)}" title="Clique para ver os alunos deste curso"><span>${esc(nomeCurso(c.nome))}</span><div class="cb-rank-barra"><span style="width:${((panMetric === 'taxa' ? c.taxa : c.v) / maxC) * 100}%"></span></div><b>${panMetric === 'taxa' ? pct(c.taxa) : brlCurto(c.v)}<small><span class="cb-taxa ${c.taxa >= TAXA_CRITICA ? 'crit' : ''}">${panMetric === 'taxa' ? brlCurto(c.v) : pct(c.taxa)}</span> · ${plural(c.alunos, 'aluno', 'alunos')}</small></b></div>`).join('')
    : '<div class="tabela-msg">Nada atrasado neste recorte.</div>';

  // 5) curva ABC
  const cl = (k, rot, dica) => `<div class="${k}"><span class="cl">${rot}</span><span class="vl">${brlCurto(ABC[k].v)}</span><small>${plural(ABC[k].n, 'aluno', 'alunos')} · ${V ? pct(ABC[k].v / V, 0) : '0%'} do atrasado · ${dica}</small></div>`;
  document.getElementById('p-abc').innerHTML = V
    ? `<div class="cb-abc">${cl('A', 'Classe A · alta prioridade', 'cobrar primeiro')}${cl('B', 'Classe B · prioridade média', 'segunda rodada')}${cl('C', 'Classe C · cauda longa', 'muitos alunos, pouco valor')}</div>
       <p class="cb-sub" style="margin:0.8rem 0 0">Os ${ABC.A.n} alunos da classe A (${pct(ABC.A.n / N, 0)} dos devedores) concentram ${pct(ABC.A.v / V, 0)} do atrasado deste recorte.</p>`
    : '<div class="tabela-msg">Nada atrasado neste recorte.</div>';

  // 6) linha do tempo: o que está atrasado, por mês de vencimento, e o que ainda vai vencer
  const abrev = (m) => NOMES_MES[Number(m.slice(5, 7)) - 1].slice(0, 3) + (m.slice(2, 4) !== String(new Date().getFullYear()).slice(2) ? '/' + m.slice(2, 4) : '');
  const mesesVenc = Object.keys(meses).sort().slice(-8);
  document.getElementById('p-tl-venc').innerHTML = mesesVenc.length
    ? miniBarras(mesesVenc.map(m => ({ rot: abrev(m), v: meses[m], destaque: false })), '#c8392f')
    : '<div class="tabela-msg">Nada atrasado neste recorte.</div>';
  const prev = painel.previsao || {};
  const noPeriodo = mesesDoPeriodo();
  const mesesFut = Object.keys(prev).filter(m => prev[m][grupo] && (!noPeriodo || noPeriodo.includes(m))).sort();
  document.getElementById('p-tl-fut').innerHTML = mesesFut.length
    ? miniBarras(mesesFut.map(m => ({ rot: abrev(m), v: prev[m][grupo].f, destaque: false })), '#1f6fb2')
    : '<div class="tabela-msg">Sem previsão para os próximos meses.</div>';
}

// ---------- VISÃO CONSULTORIA ----------
// O ano inteiro (1º + 2º semestre) na régua do painel da consultoria Fiasini, pra
// conferir com ele (07/10/2026): os 4 grupos somados (Financeiro, Advogado, Débito
// judicial e desistentes/trancados/cancelados), só parcela com matrícula, aluno
// único no ano e curva ABC sobre o total. O "vencido" do Fiasini já vem com multa
// e juros — por isso o padrão aqui é "com juros", com o valor original ao lado.
// Os números vêm prontos do agente (cobranca_edubox/consultoria).
const GRUPOS_CONS = [['financeiro', 'Financeiro', '#1B3A4B'], ['advogado', 'Advogado (acordo)', '#7c3aed'], ['debito', 'Débito judicial', '#b45309'], ['enviar', 'Desistentes/trancados/cancelados', '#94a3b8']];
const FAIXAS_CONS = [['1-30', '1 a 30 dias', '#edc24e'], ['31-60', '31 a 60 dias', '#e79a39'], ['61-90', '61 a 90 dias', '#e8791e'], ['91-180', '91 a 180 dias', '#d8542e'], ['180+', 'Mais de 180 dias', '#b12f28']];
// Tecnólogos somados num curso só, como na referência da consultoria (só nesta visão).
const cursoCons = (c) => (/^SUPERIOR DE TECNOLOGIA/i.test(c) ? 'Gestão (Tecnólogo)' : nomeCurso(c));

async function renderConsultoria() {
  const ano = anoAtual();
  if (!consultoria) {
    document.getElementById('p-kpis').innerHTML = '<div class="tabela-msg">Carregando a visão consultoria...</div>';
    try { consultoria = await apiFetch('/cobranca/edubox/consultoria'); }
    catch (err) { document.getElementById('p-kpis').innerHTML = `<div class="tabela-msg">Não foi possível carregar: ${esc(err.message)}</div>`; return; }
    if (semestre !== 'consultoria' || visao !== 'panorama') return;   // trocou de tela enquanto carregava
  }
  const r = consultoria.resumo && consultoria.resumo[ano] && consultoria.resumo[ano][grupo];
  const vazios = ['p-insights', 'p-aging', 'p-cursos', 'p-abc', 'p-tl-venc', 'p-tl-fut', 'p-divisao'];
  if (!r) {
    document.getElementById('p-kpis').innerHTML = '<div class="tabela-msg">A visão consultoria aparece depois da próxima atualização do Edubox (o agente passou a calcular em 07/10/2026).</div>';
    vazios.forEach(id => { document.getElementById(id).innerHTML = ''; });
    return;
  }
  const B = consBase;
  const vb = (b) => (b ? b[B] || 0 : 0);
  const V = vb(r.vencido);
  const N = r.vencido.alunos;
  const orig = r.vencido.valor;
  const taxa = r.carteira ? V / r.carteira : null;
  const critico = vb(r.faixas['91-180']) + vb(r.faixas['180+']);
  const ABC = r.abc[B];
  const rotBase = B === 'aPagar' ? 'com multa e juros' : 'valor original, sem juros';

  // 1) números principais (total consolidado dos 4 grupos)
  const lupa = (chave, extra) => `<button type="button" class="btn-detalhe-total kpi-lupa" data-ver-conta="${esc(chave)}"${extra ? ` data-ver-extra="${esc(extra)}"` : ''} title="Ver de onde vem esse número">🔍 ver a conta</button>`;
  const kpi = (cls, rot, val, dica, chave, extra) => `<div class="kpi-card ${cls}"><div class="kpi-label">${rot}</div><div class="kpi-value">${val}</div><div class="kpi-hint">${dica}</div>${chave ? lupa(chave, extra) : ''}</div>`;
  document.getElementById('p-kpis').innerHTML =
    kpi('cb-kpi-vencido', 'Vencido total (4 grupos)', brlCurto(V), B === 'aPagar' ? `original ${brlCurto(orig)} · ${esc(nomeGrupo())} · ${ano}` : `com juros ${brlCurto(r.vencido.aPagar)} · ${esc(nomeGrupo())} · ${ano}`, 'cons-vencido') +
    kpi('', 'Inadimplência sobre a carteira', taxa === null ? '—' : pct(taxa), `vencido ÷ ${brlCurto(r.carteira)} de carteira prevista ${ano} (valor − desconto) — régua da consultoria`, 'cons-pct') +
    kpi('', 'Alunos devedores', N.toLocaleString('pt-BR'), 'cada aluno conta uma vez no ano', 'cons-devedores') +
    kpi('', 'Vencido médio por aluno', N ? brlCurto(V / N) : '—', rotBase) +
    kpi('kpi-menor', 'Atraso crítico (+90 dias)', brlCurto(critico), V ? `${pct(critico / V, 0)} do vencido` : '', 'cons-faixa', '91-180,180+') +
    kpi('kpi-sem', 'Classe A (alta prioridade)', `${ABC.A.alunos} alunos`, V ? `respondem por ${pct(ABC.A.valor / V, 0)} do vencido` : '', 'cons-abc', 'A');

  // 2) divisão do total entre os 4 grupos
  document.getElementById('p-divisao').innerHTML = `
    <div class="cab"><span>Como o total de ${brlCurto(V)} se divide <small class="cb-sub">· calculado em ${fmtDataHora(consultoria.geradoEm)}</small></span>
      <span class="cb-pan-tog" id="p-cons-base"><button type="button" data-b="aPagar" class="${B === 'aPagar' ? 'ativa' : ''}">Com juros (como o Fiasini)</button><button type="button" data-b="valor" class="${B === 'valor' ? 'ativa' : ''}">Valor original</button></span></div>
    <div class="barra">${GRUPOS_CONS.map(([k, , cor]) => `<i style="width:${V ? (vb(r.grupos[k]) / V) * 100 : 0}%;background:${cor}" title="${esc(GRUPOS_CONS.find(g => g[0] === k)[1])}: ${brl(vb(r.grupos[k]))}"></i>`).join('')}</div>
    <div class="itens">${GRUPOS_CONS.map(([k, rot, cor]) => `<span><em style="background:${cor}"></em><b>${brlCurto(vb(r.grupos[k]))}</b> ${rot} <small>${plural(r.grupos[k].alunos, 'aluno', 'alunos')}${V ? ` · ${pct(vb(r.grupos[k]) / V, 0)}` : ''}</small> ${lupa('cons-grupo', k)}</span>`).join('')}</div>`;

  {
    const aVencerAno = Object.values(r.meses || {}).reduce((t, m) => t + (m.aVencer || 0), 0);
    pintarRosca(r.carteira - r.vencido.valor - aVencerAno, aVencerAno, r.vencido.valor, `— carteira prevista ${ano} (valor − desconto), os 4 grupos`);
  }

  // 3) o que chama atenção
  const cursosMap = {};
  for (const [nome, c] of Object.entries(r.porCurso || {})) {
    const k = cursoCons(nome);
    const x = (cursosMap[k] = cursosMap[k] || { nome: k, v: 0, alunos: 0, carteira: 0 });
    x.v += vb(c.vencido); x.alunos += c.vencido.alunos; x.carteira += c.carteira || 0;
  }
  const cursos = Object.values(cursosMap).filter(c => c.v > 0).map(c => ({ ...c, taxa: c.carteira ? c.v / c.carteira : 0 }));
  const piorTaxa = [...cursos].filter(c => c.alunos >= 5).sort((a, b) => b.taxa - a.taxa)[0];
  const ins = [];
  if (V) {
    ins.push(`<div class="ruim"><small>Concentração de risco</small><b>${ABC.A.alunos} alunos</b> (${pct(ABC.A.alunos / N, 0)} dos devedores) respondem por <b>${pct(ABC.A.valor / V, 0)}</b> do vencido (${brlCurto(ABC.A.valor)}).</div>`);
    if (piorTaxa) ins.push(`<div class="azul"><small>Curso com maior taxa</small><b>${esc(piorTaxa.nome)}</b>: ${pct(piorTaxa.taxa)} de inadimplência (${brlCurto(piorTaxa.v)}, ${plural(piorTaxa.alunos, 'aluno', 'alunos')})${taxa !== null ? `, contra ${pct(taxa)} na média` : ''}.</div>`);
    ins.push(`<div class="ruim"><small>Atraso crítico</small><b>${brlCurto(critico)}</b> (${pct(critico / V, 0)} do vencido) já passou de 90 dias.</div>`);
  }
  document.getElementById('p-insights').innerHTML = ins.join('');

  // 4) idade do atraso
  const maxA = Math.max(1, ...FAIXAS_CONS.map(([k]) => vb(r.faixas[k])));
  document.getElementById('p-aging').innerHTML = V ? FAIXAS_CONS.map(([k, rot, cor]) =>
    `<div class="cb-pan-faixa"><span>${rot}</span><div class="trilho"><i style="width:${(vb(r.faixas[k]) / maxA) * 100}%;background:${cor}"></i></div><b>${brlCurto(vb(r.faixas[k]))}<small>${plural(r.faixas[k].alunos, 'aluno', 'alunos')} · ${pct(vb(r.faixas[k]) / V, 0)}</small>${lupa('cons-faixa', k)}</b></div>`).join('')
    : '<div class="tabela-msg">Nada vencido neste recorte.</div>';

  // 5) cursos
  const lista = [...cursos].sort((a, b) => (panMetric === 'taxa' ? b.taxa - a.taxa : b.v - a.v));
  const maxC = Math.max(0.0001, ...lista.map(c => (panMetric === 'taxa' ? c.taxa : c.v)));
  document.getElementById('p-cursos').innerHTML = lista.length
    ? lista.map(c => `<div class="cb-rank"><span>${esc(c.nome)}</span><div class="cb-rank-barra"><span style="width:${((panMetric === 'taxa' ? c.taxa : c.v) / maxC) * 100}%"></span></div><b>${panMetric === 'taxa' ? pct(c.taxa) : brlCurto(c.v)}<small><span class="cb-taxa ${c.taxa >= TAXA_CRITICA ? 'crit' : ''}">${panMetric === 'taxa' ? brlCurto(c.v) : pct(c.taxa)}</span> · ${plural(c.alunos, 'aluno', 'alunos')}</small>${lupa('cons-curso', c.nome)}</b></div>`).join('')
    : '<div class="tabela-msg">Nada vencido neste recorte.</div>';

  // 6) curva ABC (sobre o total consolidado)
  const cl = (k, rot, dica) => `<div class="${k}"><span class="cl">${rot}</span><span class="vl">${brlCurto(ABC[k].valor)}</span><small>${plural(ABC[k].alunos, 'aluno', 'alunos')} · ${V ? pct(ABC[k].valor / V, 0) : '0%'} do vencido · ${dica}</small>${lupa('cons-abc', k)}</div>`;
  document.getElementById('p-abc').innerHTML = V
    ? `<div class="cb-abc">${cl('A', 'Classe A · alta prioridade', 'cobrar primeiro')}${cl('B', 'Classe B · prioridade média', 'segunda rodada')}${cl('C', 'Classe C · cauda longa', 'muitos alunos, pouco valor')}</div>
       <p class="cb-sub" style="margin:0.8rem 0 0">${plural(N, 'devedor', 'devedores')} no ano. Os ${ABC.A.alunos} da classe A (${pct(ABC.A.alunos / N, 0)}) concentram ${pct(ABC.A.valor / V, 0)} do vencido.</p>`
    : '<div class="tabela-msg">Nada vencido neste recorte.</div>';

  // 7) linha do tempo do ano: vencido e a vencer por mês de vencimento
  const abrev = (m) => NOMES_MES[Number(m.slice(5, 7)) - 1].slice(0, 3);
  const meses = Object.keys(r.meses || {}).sort();
  const mv = meses.filter(m => (B === 'aPagar' ? r.meses[m].vencidoAPagar : r.meses[m].vencido) > 0);
  document.getElementById('p-tl-venc').innerHTML = mv.length
    ? miniBarras(mv.map(m => ({ rot: abrev(m), v: B === 'aPagar' ? r.meses[m].vencidoAPagar : r.meses[m].vencido, destaque: false })), '#c8392f')
      + `<div class="cb-tl-lupas">${mv.map(m => `<button type="button" class="btn-detalhe-total cb-tl-lupa" data-ver-conta="cons-mes" data-ver-extra="${esc(m)}">🔍 ${abrev(m)}</button>`).join('')}</div>`
    : '<div class="tabela-msg">Nada vencido neste recorte.</div>';
  const mf = meses.filter(m => r.meses[m].aVencer > 0);
  document.getElementById('p-tl-fut').innerHTML = mf.length
    ? miniBarras(mf.map(m => ({ rot: abrev(m), v: r.meses[m].aVencer, destaque: false })), '#1f6fb2')
      + `<div class="cb-tl-lupas">${mf.map(m => `<button type="button" class="btn-detalhe-total cb-tl-lupa" data-ver-conta="cons-mes-avencer" data-ver-extra="${esc(m)}">🔍 ${abrev(m)}</button>`).join('')}</div>`
    : '<div class="tabela-msg">Nada a vencer até o fim do ano.</div>';
}

// ========================================================================
// "VER A CONTA" (08/10/2026) — mesmo componente do Relatório de Matrículas
// (modal #modal-detalhe-total, CSS .modal-detalhe-total-content, botão
// .btn-detalhe-total). Cada seção é recalculada a partir do MESMO `r` que
// já alimenta os cards (nenhum número digitado à mão) e nunca mostra nome
// de aluno — só agregado por grupo/curso/mês/faixa (LGPD).
// Por enquanto cobre a Visão consultoria (totais "cons-*"); o Painel por
// semestre/mês ainda não tem os botões.
// ========================================================================
const REGRA_VENCIDO_CONS = 'Vencido = parcela em aberto (situação Aberto ou Parcial no Edubox) com vencimento antes de hoje. Só entra parcela COM matrícula vinculada (protocolo e evento sem matrícula ficam fora) e que não foi cancelada nem substituída por renegociação — mesma carteira do painel da consultoria Fiasini. Separado em 4 grupos: Financeiro, Advogado, Débito judicial e Desistentes/trancados/cancelados.';
const REGRA_GRUPO_CONS = {
  financeiro: 'Situação da matrícula = Ativo, Concluído ou Pendente, e a parcela não é de plano de Renegociação Judicial — é o que o setor Financeiro cobra direto.',
  advogado: 'Parcela de plano de categoria "Renegociação Judicial" com "ADVOGADO" no nome do plano — acordo já feito, em andamento com o escritório.',
  debito: 'Parcela de plano de Renegociação Judicial que não é "Advogado" — está com a advogada, sem acordo ainda (Débito Judicial).',
  enviar: 'Situação da matrícula é Desistência, Trancamento, Cancelado ou Transferência, ou a parcela não tem matrícula vinculada — fora da cobrança do Financeiro.'
};
const REGRA_FAIXA_CONS = 'Dias de atraso = hoje menos a data de vencimento, em dias corridos. Cada parcela vencida entra numa única faixa, pelos dias que já passaram do vencimento.';
const REGRA_ABC_CONS = 'Curva ABC pelo valor em atraso de cada aluno (um por cliente, único no ano): ordena do maior pro menor e soma acumulada — Classe A = alunos que juntos chegam a 80% do vencido; Classe B = de 80% a 95%; Classe C = o restante até 100%.';
const REGRA_PCT_CONS = '% de inadimplência = Vencido ÷ Carteira prevista do ano (toda parcela com matrícula vinculada, valor menos desconto de pontualidade, vencimento dentro do ano, não cancelada nem substituída) — mesmo numerador e denominador do painel Fiasini.';
const REGRA_DEVEDORES_CONS = 'Conta cada cliente do Edubox uma vez só no ano inteiro, mesmo que tenha parcela vencida nos dois semestres — por isso não é igual a somar os devedores de cada semestre separado.';
const REGRA_CURSO_CONS = 'Mesmo critério do Vencido total, filtrado pelo curso da matrícula vinculada à parcela (ou da matrícula mais recente do cliente, quando a parcela não tem matrícula própria). Cursos "Superior de Tecnologia" somados em "Gestão (Tecnólogo)", só nesta visão — como na referência da consultoria.';
const REGRA_MES_CONS = 'Soma de toda parcela vencida (qualquer grupo) cujo vencimento cai nesse mês.';
const REGRA_MES_AVENCER_CONS = 'Soma de toda parcela que ainda não venceu, cujo vencimento cai nesse mês.';

function linhaDetCons(nome, orig, apagar, hint) {
  return `<tr><td>${esc(nome)}${hint ? `<br><small class="cb-sub">${esc(hint)}</small>` : ''}</td><td>${brl(orig)} <small class="cb-sub">(${brl(apagar)} c/ juros)</small></td></tr>`;
}
function linhaSecaoCons(nome) { return `<tr class="linha-secao-header"><td colspan="2">${esc(nome)}</td></tr>`; }
function linhaTotalCons(nome, orig, apagar) {
  return `<tr class="linha-destaque linha-separador"><td>${esc(nome)}</td><td>${brl(orig)} <small class="cb-sub">(${brl(apagar)} c/ juros)</small></td></tr>`;
}

// Fiasini — diferença conferida parcela a parcela em 07-08/10/2026 (ver
// C:/OrbitaWT/conferencia-fiasini/, só com código da parcela, sem nome de
// aluno). Valor deles é uma referência fixa daquele arquivo, não dá pra
// recalcular ao vivo; o "nosso" vem sempre do dado carregado agora.
const FIASINI_REF = {
  vencidoGraduacao: 777103.13,
  decomposicao: [
    ['Corte de data (pagamentos entre a geração do arquivo dele e nossa atualização)', 8895],
    ['Regra da parcela "Parcial" (como ela entra na carteira dele)', -3198],
    ['Parcela "Parcial" que só existe do nosso lado', -2950],
    ['Parcelas não localizadas do lado dele (3 parcelas)', 2747]
  ]
};
function fiasiniHtmlVencido(nosso) {
  if (grupo !== 'graduacao') return null;
  const fiasini = FIASINI_REF.vencidoGraduacao;
  const dif = fiasini - nosso;
  const linhas = FIASINI_REF.decomposicao.map(([nome, v]) => `${esc(nome)}: ${v >= 0 ? '+' : ''}${brl(v)}`).join('; ');
  return `<b>Como bate com o Fiasini</b> <small class="cb-sub">(referência de 07/10/2026)</small><br>
    Fiasini: <b>${brl(fiasini)}</b> · Nosso agora: <b>${brl(nosso)}</b> · Diferença: <b>${brl(dif)}</b> (Fiasini ${dif >= 0 ? 'maior' : 'menor'})<br>
    <small>${linhas}. Detalhe por parcela (só código, sem nome) em <code>conferencia-fiasini/divergencias-fiasini-2026.csv</code>.</small>`;
}

// Rastreio por curso — só existe pra quem o doc guarda por curso (vencido
// total e cada curso individual). Pra grupo/faixa/ABC/% o doc de hoje não
// quebra por curso ainda; o quadro mostra a composição mesmo assim, só sem
// a lista de cursos (nenhum número é inventado pra preencher a tabela).
function rastreioPorCursoCons(ano) {
  const porCurso = (consultoria.resumo[ano][grupo] || {}).porCurso || {};
  const agrupado = {};
  for (const [nomeCru, c] of Object.entries(porCurso)) {
    if (!c.vencido || !c.vencido.valor) continue;
    const nome = cursoCons(nomeCru);
    const x = (agrupado[nome] = agrupado[nome] || { valor: 0, aPagar: 0, parcelas: 0 });
    x.valor += c.vencido.valor; x.aPagar += c.vencido.aPagar; x.parcelas += c.vencido.parcelas;
  }
  return Object.entries(agrupado).sort((a, b) => b[1].aPagar - a[1].aPagar);
}

function montarDetalheConsultoria(tipo, extra) {
  const ano = anoAtual();
  const r = consultoria.resumo[ano] && consultoria.resumo[ano][grupo];
  if (!r) return null;
  let titulo = '', campo = '', regra = REGRA_VENCIDO_CONS, linhas = '', fiasini = null, rastreio = null;

  if (tipo === 'cons-vencido') {
    titulo = 'Vencido total (4 grupos)';
    campo = `resumo['${ano}']['${grupo}'].vencido`;
    linhas = linhaSecaoCons('Composição por grupo') +
      GRUPOS_CONS.map(([k, rot]) => linhaDetCons(rot, r.grupos[k].valor, r.grupos[k].aPagar, `${plural(r.grupos[k].alunos, 'aluno', 'alunos')} · ${plural(r.grupos[k].parcelas, 'parcela', 'parcelas')}`)).join('') +
      linhaTotalCons('= Vencido total', r.vencido.valor, r.vencido.aPagar);
    fiasini = fiasiniHtmlVencido(r.vencido.aPagar);
    rastreio = rastreioPorCursoCons(ano);
  } else if (tipo === 'cons-grupo') {
    const def = GRUPOS_CONS.find(g => g[0] === extra);
    const b = r.grupos[extra];
    titulo = def[1];
    campo = `resumo['${ano}']['${grupo}'].grupos.${extra}`;
    regra = REGRA_GRUPO_CONS[extra];
    linhas = linhaDetCons(def[1], b.valor, b.aPagar, `${plural(b.alunos, 'aluno', 'alunos')} · ${plural(b.parcelas, 'parcela', 'parcelas')}`) +
      linhaTotalCons('= ' + def[1], b.valor, b.aPagar);
  } else if (tipo === 'cons-faixa') {
    const chaves = extra.split(',');
    const nomes = chaves.map(k => FAIXAS_CONS.find(f => f[0] === k)[1]);
    titulo = nomes.length > 1 ? `Atraso crítico (${nomes.join(' + ')})` : nomes[0];
    campo = `resumo['${ano}']['${grupo}'].faixas['${chaves.join("' + '")}']`;
    regra = REGRA_FAIXA_CONS;
    let tv = 0, ta = 0;
    linhas = chaves.map(k => {
      const b = r.faixas[k];
      tv += b.valor; ta += b.aPagar;
      return linhaDetCons(FAIXAS_CONS.find(f => f[0] === k)[1], b.valor, b.aPagar, `${plural(b.alunos, 'aluno', 'alunos')} · ${plural(b.parcelas, 'parcela', 'parcelas')}`);
    }).join('') + (chaves.length > 1 ? linhaTotalCons('= Total', tv, ta) : '');
  } else if (tipo === 'cons-curso') {
    titulo = extra;
    campo = `resumo['${ano}']['${grupo}'].porCurso (agrupado: "${extra}")`;
    regra = REGRA_CURSO_CONS;
    const todos = rastreioPorCursoCons(ano);
    const achado = todos.find(([nome]) => nome === extra);
    const [, b] = achado || [null, { valor: 0, aPagar: 0, parcelas: 0 }];
    linhas = linhaTotalCons(extra, b.valor, b.aPagar) +
      `<tr><td colspan="2"><small class="cb-sub">${plural(b.parcelas, 'parcela', 'parcelas')} vencidas neste curso.</small></td></tr>`;
  } else if (tipo === 'cons-abc') {
    const B = consBase;
    const vb = (b) => (b ? b[B] || 0 : 0);
    const ABC = r.abc[B];
    const nomes = { A: 'Classe A · alta prioridade', B: 'Classe B · prioridade média', C: 'Classe C · cauda longa' };
    titulo = nomes[extra];
    campo = `resumo['${ano}']['${grupo}'].abc.${B}.${extra}`;
    regra = REGRA_ABC_CONS;
    const tot = vb(r.vencido);
    linhas = `<tr><td>${esc(nomes[extra])}<br><small class="cb-sub">Curva calculada sobre o valor ${B === 'aPagar' ? 'com juros e multa' : 'original'} (botão "${B === 'aPagar' ? 'Com juros' : 'Valor original'}" ativo acima) — trocar a base pode mudar quem entra em cada classe.</small></td><td>${brl(ABC[extra].valor)}</td></tr>` +
      `<tr><td>Alunos nesta classe</td><td>${ABC[extra].alunos}</td></tr>` +
      `<tr class="linha-destaque linha-separador"><td>% do vencido total</td><td>${tot ? pct(ABC[extra].valor / tot) : '—'}</td></tr>`;
  } else if (tipo === 'cons-pct') {
    titulo = '% de inadimplência';
    campo = `resumo['${ano}']['${grupo}'].vencido.aPagar ÷ resumo['${ano}']['${grupo}'].carteira`;
    regra = REGRA_PCT_CONS;
    linhas = linhaDetCons('Vencido (numerador)', r.vencido.valor, r.vencido.aPagar) +
      `<tr><td>Carteira prevista do ano (denominador)</td><td>${brl(r.carteira)}</td></tr>` +
      `<tr class="linha-destaque linha-separador"><td>= % de inadimplência (original / com juros)</td><td>${r.carteira ? pct(r.vencido.valor / r.carteira) : '—'} / ${r.carteira ? pct(r.vencido.aPagar / r.carteira) : '—'}</td></tr>`;
  } else if (tipo === 'cons-devedores') {
    titulo = 'Alunos devedores (únicos no ano)';
    campo = `resumo['${ano}']['${grupo}'].vencido.alunos`;
    regra = REGRA_DEVEDORES_CONS;
    linhas = `<tr><td>Alunos devedores</td><td>${r.vencido.alunos.toLocaleString('pt-BR')}</td></tr>` +
      `<tr><td>Parcelas vencidas</td><td>${r.vencido.parcelas.toLocaleString('pt-BR')}</td></tr>`;
  } else if (tipo === 'cons-mes' || tipo === 'cons-mes-avencer') {
    const avencer = tipo === 'cons-mes-avencer';
    const m = r.meses[extra];
    const [ay, am] = extra.split('-');
    titulo = `${NOMES_MES[Number(am) - 1]}/${ay} — ${avencer ? 'a vencer' : 'vencido'}`;
    campo = `resumo['${ano}']['${grupo}'].meses['${extra}'].${avencer ? 'aVencer' : 'vencido/vencidoAPagar'}`;
    regra = avencer ? REGRA_MES_AVENCER_CONS : REGRA_MES_CONS;
    linhas = avencer
      ? linhaTotalCons('= A vencer no mês', m.aVencer, m.aVencer)
      : linhaTotalCons('= Vencido no mês', m.vencido, m.vencidoAPagar);
    // Medicina tem plano "SALDO DEVEDOR Nº semestre" (acordo negociado, com
    // vencimento sempre 30/12, empurrado semestre a semestre) — não é
    // mensalidade normal, mas hoje entra junto no "a vencer" de dezembro e
    // infla o mês. O agente já separa isso em outro lugar (campo `s` da
    // previsão do Painel); aqui só avisa, não filtra (achado pela outra
    // sessão em 08/10/2026 — decisão de separar ou não é do usuário).
    if (avencer && grupo === 'medicina' && am === '12') {
      linhas += `<tr><td colspan="2"><small class="cb-sub">⚠ Dezembro de Medicina inclui o plano "Saldo Devedor" (acordo negociado, vencimento sempre 30/12, empurrado de semestre a semestre) — não é mensalidade normal. O agente ainda não separa esse valor aqui; se quiser ver o mês sem ele, é preciso pedir essa separação em <code>montarConsultoria</code>.</small></td></tr>`;
    }
  } else {
    return null;
  }

  return { titulo, campo, regra, linhas, fiasini, rastreio };
}

function abrirDetalheCobranca(tipo, extra) {
  if (!consultoria) return;
  const det = montarDetalheConsultoria(tipo, extra);
  if (!det) return;
  document.getElementById('detalhe-total-titulo').textContent = det.titulo;
  document.getElementById('detalhe-total-sub').textContent = `${nomeGrupo()} · Visão consultoria ${anoAtual()}`;
  const dataAgente = consultoria && consultoria.geradoEm ? fmtDataHora(consultoria.geradoEm) : '—';
  document.getElementById('detalhe-total-data').textContent = `Dados do Edubox de ${dataAgente} · calculado em ${dataAgente}`;
  document.getElementById('detalhe-total-regra').innerHTML = `<b>Regra:</b> ${det.regra}`;
  document.getElementById('detalhe-total-tbody').innerHTML = det.linhas;
  const fiasiniEl = document.getElementById('detalhe-total-fiasini');
  if (det.fiasini) { fiasiniEl.innerHTML = det.fiasini; fiasiniEl.classList.remove('hidden'); }
  else { fiasiniEl.innerHTML = ''; fiasiniEl.classList.add('hidden'); }
  const rastreioEl = document.getElementById('detalhe-total-rastreio');
  if (det.rastreio && det.rastreio.length) {
    document.getElementById('detalhe-total-rastreio-tbody').innerHTML =
      `<tr><th>Curso</th><th>Vencido</th><th>Parcelas</th></tr>` +
      det.rastreio.map(([nome, x]) => `<tr><td>${esc(nome)}</td><td>${brl(x.aPagar)}</td><td>${x.parcelas}</td></tr>`).join('');
    rastreioEl.classList.remove('hidden');
  } else {
    rastreioEl.classList.add('hidden');
  }
  document.getElementById('modal-detalhe-total').classList.remove('hidden');
}

// ---------- LISTA DE COBRANÇA ----------
async function abrirLista() {
  if (!listas[grupo]) {
    document.getElementById('tb-alunos').innerHTML = '<tr><td colspan="5" class="tabela-msg">Carregando alunos...</td></tr>';
    try {
      listas[grupo] = await apiFetch(`/cobranca/edubox/alunos?grupo=${grupo}`);
    } catch (err) {
      document.getElementById('tb-alunos').innerHTML = `<tr><td colspan="5" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
      return;
    }
  }
  document.getElementById('l-planos').innerHTML = (listas[grupo].planos || []).slice().sort().map(p => `<option value="${esc(p)}">`).join('');
  const cursos = [...new Set(listas[grupo].alunos.flatMap(a => a.cursos))].sort();
  const selC = document.getElementById('l-curso');
  const atualC = selC.value;
  selC.innerHTML = '<option value="">Todos os cursos</option>' + cursos.map(c => `<option value="${esc(c)}">${esc(nomeCurso(c))}</option>`).join('');
  const pedido = cursoPedido; cursoPedido = '';
  selC.value = cursos.includes(pedido) ? pedido : cursos.includes(atualC) ? atualC : '';
  mostrando = POR_PAGINA;
  filtrarLista();
}

function faixaDe(dias) { return dias <= 30 ? '1-30' : dias <= 60 ? '31-60' : dias <= 90 ? '61-90' : '90+'; }

// Aluno com só as parcelas que interessam ao filtro. Quem manda é o PLANO da
// parcela (decisão do usuário, 01/10/2026):
//  - 'cobrar': parcelas normais (não jurídicas) do semestre escolhido — de
//    qualquer aluno, mesmo quem também tem acordo com advogado;
//  - 'advogado' / 'debito': alunos com acordo feito / débito judicial, só as
//    parcelas jurídicas (semestre = o da dívida original, como no Edubox).
// Vencimento de/até e plano valem nos três.
function recortarAluno(a, modo, f) {
  const hoje = Date.now();
  const adv = ehModoAdvogado(modo);
  if (adv && a.tipoAdvogado !== modo) return null;
  const nomes = listas[grupo].planos || [];
  const parcelas = a.parcelas.filter(p => {
    // cobrar: normais de matrícula Ativo/Concluído/Pendente · advogado/débito: jurídicas · enviar: normais de desistente/trancado/cancelado
    if (modo === 'enviar') { if (p.j || !p.e) return false; }
    else if (adv ? !p.j : (p.j || p.e)) return false;
    if (semestre !== 'todos' && p.s !== semestre) return false;
    if (usaMes() && p.v.slice(0, 7) !== mes) return false;
    if (f.de && p.v < f.de) return false;
    if (f.ate && p.v > f.ate) return false;
    if (f.plano && !(nomes[p.pl] || '').toLowerCase().includes(f.plano)) return false;
    return true;
  });
  if (!parcelas.length) return null;
  const total = parcelas.reduce((s, p) => s + p.valor, 0);
  const maisAntigo = parcelas[0].v;
  const dias = Math.round((hoje - dataLocal(maisAntigo).getTime()) / 86400000);
  const totalAP = parcelas.reduce((s, p) => s + aPagarParcela(p.valor, p.v), 0);
  return { ...a, parcelasVis: parcelas, totalVis: Math.round(total * 100) / 100, apVis: Math.round(totalAP * 100) / 100, maisAntigoVis: maisAntigo, diasVis: dias, modoAdv: ehModoSemCobranca(modo), modoEnviar: modo === 'enviar' };
}

function situacaoCobranca(a) {
  const c = listas[grupo]?.controle?.[a.chave];
  const semana = c && c.em >= inicioSemanaISO();
  return { c, semana };
}

function filtrarLista() {
  const L = listas[grupo];
  if (!L) return;
  const busca = document.getElementById('l-busca').value.trim().toLowerCase();
  const buscaDig = busca.replace(/\D/g, '');
  const ctl = document.getElementById('l-controle').value;
  const lado = document.getElementById('l-lado').value;
  const faixa = document.getElementById('l-faixa').value;
  const curso = document.getElementById('l-curso').value;
  const pagando = document.getElementById('l-pagando').value;
  const f = {
    de: document.getElementById('l-venc-de').value,
    ate: document.getElementById('l-venc-ate').value,
    plano: document.getElementById('l-plano').value.trim().toLowerCase()
  };
  const adv = ehModoSemCobranca(lado);
  document.getElementById('l-pagando').classList.toggle('hidden', !ehModoAdvogado(lado));
  document.getElementById('l-controle').classList.toggle('hidden', adv);
  const agoraISO = new Date().toISOString();

  filtrados = [];
  for (const bruto of L.alunos) {
    const a = recortarAluno(bruto, lado, f);
    if (!a) continue;
    if (ehModoAdvogado(lado) && pagando) {
      const pg = a.pagamento && a.pagamento.pago90 > 0;
      if ((pagando === 'sim') !== !!pg) continue;
    }
    if (curso && !a.cursos.includes(curso)) continue;
    if (faixa && faixaDe(a.diasVis) !== faixa) continue;
    if (busca && !a.nome.toLowerCase().includes(busca) && !(buscaDig.length >= 3 && a.cpf.includes(buscaDig))) continue;
    const { c, semana } = situacaoCobranca(a);
    if (adv) { filtrados.push(a); continue; }
    if (ctl === 'nao-semana' && semana) continue;
    if (ctl === 'sim-semana' && !semana) continue;
    if (ctl === 'nunca' && c) continue;
    if (ctl === 'nao-15' && c && diasDesde(c.em) < 15) continue;
    if (ctl === 'nao-30' && c && diasDesde(c.em) < 30) continue;
    if (ctl === 'promessa' && !(c && c.promessa)) continue;
    if (ctl === 'sem-celular' && a.celular) continue;
    filtrados.push(a);
  }
  filtrados.sort((x, y) => y.apVis - x.apVis);

  const total = filtrados.reduce((s, a) => s + a.apVis, 0);
  const totalOrig = filtrados.reduce((s, a) => s + a.totalVis, 0);
  const cobradosSemana = filtrados.filter(a => situacaoCobranca(a).semana).length;
  if (lado === 'enviar') {
    document.getElementById('l-contadores').innerHTML = `
      <span>📤 <b>${filtrados.length}</b> alunos desistentes/trancados/cancelados · 💰 <b>${brl(total)}</b> a pagar <small>(original ${brl(totalOrig)})</small></span>
      <span>O Financeiro <b>não cobra</b> — lista pra encaminhar ao advogado</span>
      <span class="cb-sub">Lista do Edubox de ${fmtDataHora(L.geradoEm)}</span>`;
    renderLista();
    return;
  }
  if (adv) {
    const pagandoN = filtrados.filter(a => a.pagamento && a.pagamento.pago90 > 0).length;
    document.getElementById('l-contadores').innerHTML = `
      <span>${lado === 'advogado' ? '⚖️' : '🏛'} <b>${filtrados.length}</b> alunos · 💰 <b>${brl(total)}</b> a pagar <small>(original ${brl(totalOrig)})</small></span>
      <span>✅ Pagando (90 dias): <b>${pagandoN}</b> · ⚠️ Parados: <b>${filtrados.length - pagandoN}</b></span>
      <span>O Financeiro <b>não cobra</b> essas parcelas — só consulta e registra observações</span>
      <span class="cb-sub">Lista do Edubox de ${fmtDataHora(L.geradoEm)}</span>`;
    renderLista();
    return;
  }
  document.getElementById('l-contadores').innerHTML = `
    <span><b>${filtrados.length}</b> alunos com atraso · 💰 <b>${brl(total)}</b> a pagar <small>(original ${brl(totalOrig)} + juros e multa)</small></span>
    <span>✅ Cobrados nesta semana: <b>${cobradosSemana}</b></span>
    <span>⏳ Faltam cobrar: <b>${filtrados.length - cobradosSemana}</b></span>
    ${filtrados.some(a => !a.celular) ? `<span class="cb-sem-cel-aviso" title="Só cobramos no celular do próprio aluno — atualize o cadastro no Edubox">📵 ${filtrados.filter(a => !a.celular).length} sem celular no Edubox</span>` : ''}
    <span class="cb-sub">Lista do Edubox de ${fmtDataHora(L.geradoEm)}</span>`;
  renderLista(agoraISO);
}

// Situação de pagamento do aluno com acordo/débito (último pagamento no Edubox).
function badgePagamento(a) {
  const pg = a.pagamento || {};
  if (pg.pago90 > 0) {
    return `<span class="cb-pagto sim">✅ Pagando</span><div class="cb-sub">último pagamento ${fmtData(pg.ultimo)} · ${brl(pg.pago90)} em 90 dias</div>`;
  }
  return `<span class="cb-pagto nao">⚠️ Parado</span><div class="cb-sub">${pg.ultimo ? `sem pagamento há ${diasDesde(pg.ultimo + 'T12:00:00')} dias (último ${fmtData(pg.ultimo)})` : 'nenhum pagamento registrado'}</div>`;
}

function badgeCobranca(a) {
  if (a.modoEnviar) return `<span class="cb-pagto nao">📤 ${esc((a.situacoes || []).filter(s => !['Ativo', 'Concluído', 'Pendente'].includes(s)).join(', ') || 'sem matrícula')}</span><div class="cb-sub">enviar ao advogado</div>`;
  if (a.modoAdv) return badgePagamento(a);
  const { c } = situacaoCobranca(a);
  let html;
  if (!c) html = '<span class="cb-cobrado nunca">Não cobrado</span>';
  else {
    const d = diasDesde(c.em);
    const quando = d === 0 ? 'hoje' : d === 1 ? 'ontem' : `há ${d} dias`;
    const [ic] = TIPOS[c.tipo] || ['•'];
    html = `<span class="cb-cobrado ${c.em >= inicioSemanaISO() ? 'recente' : 'antigo'}" title="${esc(`${fmtDataHora(c.em)} por ${c.por || '—'} · ${c.n || 1} ação(ões) no total`)}">${ic} Cobrado ${quando}</span><div class="cb-sub">por ${esc((c.por || '').split(' ')[0])}</div>`;
  }
  if (c && c.promessa) {
    const venc = c.promessa.data < iso(new Date());
    html += `<span class="cb-promessa ${venc ? 'vencida' : ''}">📅 Prometeu p/ ${fmtData(c.promessa.data)}${c.promessa.valor ? ` · ${brl(c.promessa.valor)}` : ''}${venc ? ' (passou)' : ''}</span>`;
  }
  return html;
}

function planosDoAluno(a) {
  const nomes = listas[grupo].planos || [];
  const u = [...new Set(a.parcelasVis.map(p => nomes[p.pl]).filter(Boolean))];
  return u.length > 2 ? `${u.slice(0, 2).join(' · ')} +${u.length - 2}` : u.join(' · ');
}

function renderLista() {
  const tb = document.getElementById('tb-alunos');
  if (!filtrados.length) {
    tb.innerHTML = '<tr><td colspan="5" class="tabela-msg">Nenhum aluno com esses filtros.</td></tr>';
    document.getElementById('l-mais-wrap').classList.add('hidden');
    return;
  }
  const classeF = { '1-30': 'f1', '31-60': 'f2', '61-90': 'f3', '90+': 'f4' };
  tb.innerHTML = filtrados.slice(0, mostrando).map((a, i) => `
    <tr class="${a.celular ? '' : 'cb-sem-cel'}">
      <td><span class="cb-aluno-nome" data-abrir="${i}">${esc(a.nome)}</span>${a.modoEnviar ? '<span class="cb-tag-jur">PARA O ADVOGADO — NÃO COBRAR</span>' : a.modoAdv ? `<span class="cb-tag-jur">${a.tipoAdvogado === 'advogado' ? 'ACORDO COM ADVOGADO' : 'DÉBITO JUDICIAL'} — NÃO COBRAR</span>` : a.comAdvogado ? `<span class="cb-tag-acordo" title="${esc((a.planosAdvogado || []).join(', '))} — essas parcelas são do advogado; as da lista são normais">também tem acordo c/ advogado</span>` : ''}
        <div class="cb-sub">${esc(a.cursos.map(nomeCurso).join(' / '))} · ${esc(a.fone || 'sem celular no Edubox')}</div></td>
      <td>${plural(a.parcelasVis.length, 'parcela', 'parcelas')}<span class="cb-atraso ${classeF[faixaDe(a.diasVis)]}" title="dias desde a parcela mais antiga">${a.diasVis} dias de atraso</span>
        <div class="cb-sub">desde ${fmtData(a.maisAntigoVis)}</div>
        <span class="cb-plano">${esc(planosDoAluno(a))}</span></td>
      <td class="num"><b>${brl(a.apVis)}</b><small class="cb-orig">original ${brl(a.totalVis)}</small></td>
      <td>${badgeCobranca(a)}</td>
      <td class="acoes-col">
        ${podeEditar && !a.modoAdv ? (a.celular
          ? `<button type="button" class="btn-acao zap" data-zap="${i}" title="Enviar pelo WhatsApp pro celular do aluno (cadastro do Edubox)">💬 WhatsApp</button>`
          : '<span class="cb-sem-cel-aviso" title="Só usamos o celular do próprio aluno no Edubox — nunca de pais/responsáveis">📵 Sem celular no Edubox — atualizar o cadastro</span>') : ''}
        <button type="button" class="btn-acao" data-abrir="${i}" title="Parcelas, histórico e registrar ligação/negociação/promessa">📋 Detalhes</button>
      </td>
    </tr>`).join('');
  document.getElementById('l-mais-wrap').classList.toggle('hidden', filtrados.length <= mostrando);
}

// ---------- WHATSAPP ----------
async function garantirModelos() {
  if (!modelos) modelos = await apiFetch('/cobranca/edubox/modelos');
  return modelos;
}

function preencher(texto, a) {
  const nomeT = a.nome.toLowerCase().replace(/(^|\s)\S/g, x => x.toUpperCase());
  const lista = a.parcelasVis.map(p => `• Venc. ${fmtData(p.v)} — ${brl(p.valor)} (hoje ${brl(aPagarParcela(p.valor, p.v))} com juros e multa)`).join('\n');
  const vars = {
    saudacao: (() => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; })(),
    nome: nomeT, primeiro_nome: nomeT.split(' ')[0], valor_total: brl(a.totalVis), valor_a_pagar: brl(a.apVis),
    qtd_parcelas: plural(a.parcelasVis.length, 'parcela', 'parcelas'), lista_parcelas: lista,
    vencimento_mais_antigo: fmtData(a.maisAntigoVis), dias_atraso: String(a.diasVis), curso: a.cursos.map(nomeCurso).join(' / ')
  };
  return texto.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// Qual mensagem do Financeiro serve pra esse aluno (02/10/2026):
//  - 1 parcela atrasada -> "1 mensalidade vencida"
//  - tem renegociação ou parcela de semestre anterior -> "Renegociação e semestres anteriores"
//  - senão (várias, todas do semestre atual) -> "Mensalidades do semestre vencidas"
function modeloSugerido(a) {
  const nomes = (listas[grupo] && listas[grupo].planos) || [];
  const atual = semestreAtual();
  let id;
  if (a.parcelasVis.length === 1) id = 'uma_parcela';
  else if (a.parcelasVis.some(p => p.s < atual || /RENEGOCIA/i.test(nomes[p.pl] || ''))) id = 'acumulo';
  else id = 'semestre';
  return modelos.find(m => m.id === id) ? id : modelos[0].id;
}

async function abrirZap(i) {
  const a = filtrados[i];
  if (!a || a.modoAdv || !a.celular) return; // só o celular do próprio aluno (Edubox)
  try { await garantirModelos(); } catch (e) { showToast(e.message, 'error'); return; }
  alunoAberto = { ...a, idx: i };
  document.getElementById('zap-sub').innerHTML = `<b>${esc(a.nome)}</b> · ${plural(a.parcelasVis.length, 'parcela', 'parcelas')} · a pagar ${brl(a.apVis)} (original ${brl(a.totalVis)}) · ${a.diasVis} dias de atraso`;
  const sel = document.getElementById('zap-modelo');
  sel.innerHTML = modelos.map(m => `<option value="${esc(m.id)}">${esc(m.nome)}</option>`).join('');
  sel.value = modeloSugerido(a);
  document.getElementById('zap-numero').value = a.celular ? a.celular.replace(/^55/, '') : '';
  document.getElementById('zap-texto').value = preencher(modelos.find(m => m.id === sel.value).texto, a);
  document.getElementById('zap-ok').classList.add('hidden');
  document.getElementById('zap-proximo').classList.add('hidden');
  document.getElementById('zap-enviar').classList.remove('hidden');
  document.getElementById('modal-zap').classList.remove('hidden');
}

function linkZap(numero, texto) {
  const celular = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  // No computador abre o WhatsApp Web direto (o wa.me pergunta se quer abrir o app).
  return celular
    ? `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`
    : `https://web.whatsapp.com/send?phone=${numero}&text=${encodeURIComponent(texto)}`;
}

async function enviarZap() {
  const a = alunoAberto;
  const dig = document.getElementById('zap-numero').value.replace(/\D/g, '');
  if (dig.length < 10) { showToast('Informe o celular com DDD.', 'error'); return; }
  const numero = dig.length <= 11 ? '55' + dig : dig;
  const texto = document.getElementById('zap-texto').value;
  // mesma aba toda vez: o WhatsApp Web não abre uma aba nova por aluno
  window.open(linkZap(numero, texto), 'orbita-whatsapp');
  const btn = document.getElementById('zap-enviar');
  btn.disabled = true;
  try {
    await registrarAcao(a, { tipo: 'whatsapp', mensagem: texto, observacoes: `Mensagem enviada para ${numero.replace(/^55/, '')} (${document.getElementById('zap-modelo').selectedOptions[0].textContent}).` });
    document.getElementById('zap-ok').classList.remove('hidden');
    document.getElementById('zap-enviar').classList.add('hidden');
    const prox = proximoNaoCobrado(a.idx);
    if (prox >= 0) document.getElementById('zap-proximo').classList.remove('hidden');
    renderLista();
  } catch (err) {
    showToast(`Mensagem aberta, mas não registrou: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function proximoNaoCobrado(depoisDe) {
  for (let i = depoisDe + 1; i < filtrados.length; i++) {
    if (filtrados[i].celular && !filtrados[i].modoAdv && !situacaoCobranca(filtrados[i]).semana) return i;
  }
  return -1;
}

async function registrarAcao(a, dados) {
  const nova = await apiFetch('/cobranca/edubox/acoes', {
    method: 'POST',
    body: JSON.stringify({ chave: a.chave, nomeAluno: a.nome, grupo, ...dados })
  });
  // atualiza o controle local sem recarregar a lista inteira
  const ctl = listas[grupo].controle;
  if (['whatsapp', 'ligacao', 'email', 'contato', 'negociacao', 'promessa_pagamento'].includes(dados.tipo)) {
    const atual = ctl[a.chave] || { n: 0 };
    ctl[a.chave] = { ...atual, em: nova.criadoEm, por: currentUserNome || nova.criadoPorNome, tipo: dados.tipo, n: (atual.n || 0) + 1,
      ...(dados.tipo === 'promessa_pagamento' ? { promessa: { data: dados.promessaData, valor: nova.promessaValor } } : {}) };
  }
  return nova;
}

// ---------- DETALHE DO ALUNO ----------
async function abrirAluno(i) {
  const a = filtrados[i];
  if (!a) return;
  alunoAberto = { ...a, idx: i };
  document.getElementById('al-nome').textContent = a.nome;
  document.getElementById('al-sub').innerHTML = `CPF ${esc(a.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'))} · ${a.fone ? esc(a.fone) : '<span class="cb-sem-cel-aviso">📵 Sem celular no Edubox — atualizar o cadastro antes de cobrar (nunca usar contato de pais/responsáveis)</span>'} · ${esc(a.cursos.map(nomeCurso).join(' / '))}`;
  const nomesPl = listas[grupo].planos || [];
  const pg = a.pagamento || {};
  document.getElementById('al-sub').innerHTML += ` · ${pg.ultimo ? `último pagamento ${fmtData(pg.ultimo)}` : 'sem pagamento registrado'}${pg.pago90 > 0 ? ` (${brl(pg.pago90)} em 90 dias)` : ''}`;
  document.getElementById('al-parcelas').innerHTML = a.parcelasVis.map(p =>
    `<div><span>${fmtData(p.v)} <small class="cb-sub">(${esc(p.s)})</small>${p.j ? '<span class="cb-tag-jur">JUR</span>' : ''}<small class="cb-plano">${esc(nomesPl[p.pl] || '')}</small></span><b>${brl(aPagarParcela(p.valor, p.v))}<small class="cb-orig">original ${brl(p.valor)}</small></b></div>`).join('') +
    `<div class="total"><span>Total a pagar</span><span>${brl(a.apVis)}<small class="cb-orig">original ${brl(a.totalVis)}</small></span></div>`;
  document.getElementById('form-acao').classList.toggle('hidden', !podeEditar);
  document.getElementById('ac-tipo').value = 'ligacao';
  document.getElementById('ac-promessa').classList.add('hidden');
  document.getElementById('ac-obs').value = '';
  document.getElementById('ac-data').value = '';
  document.getElementById('ac-valor').value = '';
  document.getElementById('modal-aluno').classList.remove('hidden');
  carregarHistorico(a);
}

async function carregarHistorico(a) {
  const el = document.getElementById('al-historico');
  el.innerHTML = '<div class="tabela-msg">Carregando...</div>';
  try {
    const lista = await apiFetch(`/cobranca/edubox/acoes/${encodeURIComponent(a.chave)}`);
    if (!lista.length) { el.innerHTML = '<div class="tabela-msg">Nenhuma ação registrada ainda.</div>'; return; }
    el.innerHTML = lista.map(x => {
      const [ic, nome] = TIPOS[x.tipo] || ['•', x.tipo];
      const extra = x.tipo === 'promessa_pagamento' && x.promessaData ? ` — para ${fmtData(x.promessaData)}${x.promessaValor ? ` · ${brl(x.promessaValor)}` : ''}` : '';
      return `<div class="cb-hist-item">
        <span class="ic">${ic}</span>
        <div class="corpo">
          <b>${esc(nome)}</b>${esc(extra)}
          <div class="quando">${x.criadoEm ? fmtDataHora(x.criadoEm) : ''} · ${esc(x.criadoPorNome || '')}</div>
          ${x.observacoes ? `<div class="obs">${esc(x.observacoes)}</div>` : ''}
          ${x.mensagem ? `<details><summary>ver mensagem enviada</summary><div>${esc(x.mensagem)}</div></details>` : ''}
        </div>
        ${podeEditar ? `<button type="button" class="btn-icon" data-del="${esc(x.id)}" title="Excluir (lançado errado)">🗑</button>` : ''}
      </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<div class="tabela-msg">Erro: ${esc(err.message)}</div>`;
  }
}

async function salvarAcao(ev) {
  ev.preventDefault();
  const a = alunoAberto;
  const tipo = document.getElementById('ac-tipo').value;
  const dados = { tipo, observacoes: document.getElementById('ac-obs').value };
  if (tipo === 'promessa_pagamento') {
    dados.promessaData = document.getElementById('ac-data').value;
    dados.promessaValor = document.getElementById('ac-valor').value;
    if (!dados.promessaData) { showToast('Informe a data em que vai pagar.', 'error'); return; }
  }
  const btn = document.getElementById('ac-salvar');
  btn.disabled = true;
  try {
    await registrarAcao(a, dados);
    showToast('Ação registrada.');
    document.getElementById('ac-obs').value = '';
    carregarHistorico(a);
    renderLista();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function excluirAcao(id) {
  if (!confirm('Excluir esta ação do histórico?')) return;
  try {
    await apiFetch(`/cobranca/edubox/acoes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    // recarrega o controle (o "cobrado em" pode ter mudado)
    const L = await apiFetch(`/cobranca/edubox/alunos?grupo=${grupo}`);
    listas[grupo].controle = L.controle;
    carregarHistorico(alunoAberto);
    filtrarLista();
    showToast('Ação excluída.');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ---------- MODELOS ----------
async function abrirModelos() {
  try { await garantirModelos(); } catch (e) { showToast(e.message, 'error'); return; }
  renderModelos(modelos);
  document.getElementById('modal-modelos').classList.remove('hidden');
}

function renderModelos(lista) {
  document.getElementById('modelos-lista').innerHTML = lista.map(m => `
    <div class="cb-modelo" data-id="${esc(m.id)}">
      <div class="cb-modelo-topo"><input type="text" class="m-nome" value="${esc(m.nome)}" placeholder="Nome do modelo">
        <button type="button" class="btn-icon" data-remover title="Remover modelo">🗑</button></div>
      <textarea class="m-texto" rows="6">${esc(m.texto)}</textarea>
    </div>`).join('');
}

function lerModelosDaTela() {
  return [...document.querySelectorAll('#modelos-lista .cb-modelo')].map(el => ({
    id: el.dataset.id, nome: el.querySelector('.m-nome').value, texto: el.querySelector('.m-texto').value
  }));
}

async function salvarModelos() {
  try {
    modelos = await apiFetch('/cobranca/edubox/modelos', { method: 'PUT', body: JSON.stringify({ modelos: lerModelosDaTela() }) });
    document.getElementById('modal-modelos').classList.add('hidden');
    showToast('Modelos salvos.');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ---------- FECHAMENTO SEMANAL ----------
async function renderSemana() {
  const seg = semanaRef ? dataLocal(semanaRef) : segunda();
  const dom = somaDias(seg, 6);
  const atual = iso(segunda()) === iso(seg);
  document.getElementById('s-rotulo').textContent = `Semana de ${fmtData(iso(seg))} a ${fmtData(iso(dom))}${atual ? ' (atual)' : ''}`;
  document.getElementById('s-proxima').disabled = atual;
  let dados = atual ? painel : semanaDados;
  if (!atual && (!semanaDados || semanaDados.semana.inicio !== iso(seg))) {
    document.getElementById('s-lados').innerHTML = '<div class="card cb-lado"><div class="tabela-msg">Carregando...</div></div>';
    try {
      semanaDados = await apiFetch(`/cobranca/edubox/painel?semana=${iso(seg)}`);
      dados = semanaDados;
    } catch (err) {
      document.getElementById('s-lados').innerHTML = `<div class="card cb-lado"><div class="tabela-msg">Erro: ${esc(err.message)}</div></div>`;
      return;
    }
  }
  const sem = dados.semana;
  const b = somaBaixas(sem.baixas);
  // Início/fim da semana pelo RESUMO SEMANAL (cobranca_edubox/semanas): o
  // atrasado de segunda 00h, na mesma regra do resto da tela (semestre pelo
  // vencimento, só matrícula ativa). As "fotos" antigas (cobranca_edubox_
  // historico) são só reserva — as de antes de 01/10/2026 estão na regra
  // velha e misturavam as duas contas (02/10).
  if (!semanasDados) {
    try { semanasDados = (await apiFetch('/cobranca/edubox/semanas')).semanas || {}; } catch (e) { semanasDados = {}; }
  }
  const iniSemana = semanasDados[iso(seg)]?.[grupo]?.[semestre]?.ini || null;
  const fimSemana = atual ? null : (semanasDados[iso(somaDias(seg, 7))]?.[grupo]?.[semestre]?.ini || null);
  const chaveLado = (lado) => (lado === 'financeiro' ? 'f' : 'j');
  // Se a 1ª "foto" do vencido é do meio da semana (PC desligado na segunda, ou
  // o começo do controle), a conta usa só o recebido a partir dela.
  const fotoAtrasada = !iniSemana && sem.fotoInicio && sem.fotoInicio.data > sem.inicio;
  const bConta = fotoAtrasada ? somaBaixas(sem.baixas.filter(d => d.data >= sem.fotoInicio.data)) : b;
  const valorFoto = (foto, lado) => foto?.vencido?.[semestre]?.[grupo]?.[lado];
  const fimFonte = atual ? null : sem.fotoFim;
  const avisos = [];
  if (iniSemana) { /* conta completa pelo resumo semanal: sem aviso */ }
  else if (!sem.fotoInicio) avisos.push('Não há registro do vencido no começo desta semana (o controle começou a ser gravado em 30/09/2026 ou o PC de atualização estava desligado). Os recebimentos estão completos.');
  else if (fotoAtrasada) avisos.push(`O primeiro registro do vencido nesta semana é de ${fmtDataHora(sem.fotoInicio.geradoEm)} (o PC de atualização não rodou antes disso). A conta abaixo parte desse momento; o "Recebido total na semana" e as tabelas mostram a semana inteira.`);
  document.getElementById('s-aviso').innerHTML = avisos.map(t => `<div class="cb-aviso">${esc(t)}</div>`).join('');

  const lados = [['financeiro', '💼 Financeiro'], ['juridico', '⚖️ Advogado + Débito judicial']];
  document.getElementById('s-lados').innerHTML = lados.map(([lado, titulo]) => {
    const inicio = iniSemana ? iniSemana[chaveLado(lado)] : valorFoto(sem.fotoInicio, lado);
    const fim = atual ? (recorte()?.[lado]?.vencido?.valor ?? 0)
      : (fimSemana ? fimSemana[chaveLado(lado)] : valorFoto(fimFonte, lado));
    const recAtraso = bConta[`${lado}Atraso`];
    const recTotal = b[lado];
    const temConta = inicio !== undefined && fim !== undefined;
    const novos = temConta ? fim - inicio + recAtraso : null;
    const quandoIni = iniSemana ? `${fmtData(iso(seg))} às 00h` : (sem.fotoInicio ? fmtDataHora(sem.fotoInicio.geradoEm) : '');
    const quandoFim = atual ? fmtDataHora(painel.geradoEm)
      : (fimSemana ? `${fmtData(iso(somaDias(seg, 7)))} às 00h` : (fimFonte ? fmtDataHora(fimFonte.geradoEm) : ''));
    return `<div class="card cb-lado">
      <h3>${titulo}</h3>
      <div class="cb-conta"><span>🔴 ${fotoAtrasada ? 'Atrasado no 1º registro da semana' : 'Atrasado na segunda-feira'}<small>o que faltava receber em ${quandoIni || '—'}</small></span><b>${inicio !== undefined ? brl(inicio) : '—'}</b></div>
      <div class="cb-conta menos"><span>− Pagaram mensalidades atrasadas<small>dinheiro que entrou de parcela já vencida (diminui o atraso)</small></span><b>${brl(recAtraso)}</b></div>
      <div class="cb-conta mais"><span>+ Novas mensalidades que venceram sem pagar<small>e ajustes: renegociações, cancelamentos (aumenta o atraso)</small></span><b>${novos !== null ? brl(novos) : '—'}</b></div>
      <div class="cb-conta resultado"><span>= 🔴 ${atual ? 'Atrasado agora' : 'Atrasado no fim da semana'}<small>${quandoFim}</small></span><b>${fim !== undefined ? brl(fim) : '—'}</b></div>
      <div class="cb-conta"><span>🟢 Todo o dinheiro que entrou na semana<small>atrasadas + mensalidades pagas em dia</small></span><b>${brl(recTotal)}</b></div>
    </div>`;
  }).join('');

  carregarRetorno(iso(seg), iso(dom));

  // por dia
  const dias = [];
  for (let i = 0; i < 7; i++) {
    const d = iso(somaDias(seg, i));
    const reg = sem.baixas.find(x => x.data === d);
    const t = reg ? somaBaixas([reg]) : { financeiro: 0, juridico: 0 };
    dias.push([d, t]);
  }
  const DS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  document.getElementById('s-dias').innerHTML = dias.map(([d, t], i) =>
    `<tr><td>${DS[i]} ${fmtData(d).slice(0, 5)}</td><td class="num">${brl(t.financeiro)}</td><td class="num">${brl(t.juridico)}</td><td class="num"><b>${brl(t.financeiro + t.juridico)}</b></td></tr>`).join('') +
    `<tr class="mes-linha"><td><b>Total</b></td><td class="num"><b>${brl(b.financeiro)}</b></td><td class="num"><b>${brl(b.juridico)}</b></td><td class="num"><b>${brl(b.financeiro + b.juridico)}</b></td></tr>`;

  // por tipo de baixa e por curso — no semestre escolhido (o agente grava em
  // porSemestre desde 02/10/2026) ou no total ("Todos os semestres")
  let semDadoSemestre = false;
  const somaMapa = (campo) => {
    const m = {};
    const add = (k, lado, v) => { m[k] = m[k] || { financeiro: 0, juridico: 0 }; m[k][lado] += v; };
    for (const d of sem.baixas) {
      if (semestre === 'todos') {
        for (const lado of ['financeiro', 'juridico']) for (const [k, v] of Object.entries(d[grupo][lado][campo] || {})) add(k, lado, v);
        continue;
      }
      const ps = d.porSemestre?.[semestre]?.[grupo];
      if (!ps) continue;
      if (!ps[campo]) { if (ps.financeiro || ps.juridico) semDadoSemestre = true; continue; }
      for (const [k, v] of Object.entries(ps[campo])) { add(k, 'financeiro', v.financeiro); add(k, 'juridico', v.juridico); }
    }
    return Object.entries(m).sort((x, y) => (y[1].financeiro + y[1].juridico) - (x[1].financeiro + x[1].juridico));
  };
  const tipos = somaMapa('porTipo');
  const aguardando = (cols) => `<tr><td colspan="${cols}" class="tabela-msg">Separação por semestre disponível a partir da próxima atualização do Edubox.</td></tr>`;
  document.getElementById('s-tipos').innerHTML = semDadoSemestre && !tipos.length ? aguardando(3) : (tipos.length
    ? tipos.map(([k, v]) => `<tr><td>${esc(k.charAt(0) + k.slice(1).toLowerCase())}</td><td class="num">${brl(v.financeiro)}</td><td class="num">${brl(v.juridico)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="tabela-msg">Nenhum recebimento.</td></tr>');
  const cursos = somaMapa('porCurso');
  document.getElementById('s-cursos').innerHTML = semDadoSemestre && !cursos.length ? aguardando(4) : (cursos.length
    ? cursos.map(([k, v]) => `<tr><td>${esc(nomeCurso(k))}</td><td class="num">${brl(v.financeiro)}</td><td class="num">${brl(v.juridico)}</td><td class="num"><b>${brl(v.financeiro + v.juridico)}</b></td></tr>`).join('')
    : '<tr><td colspan="4" class="tabela-msg">Nenhum recebimento.</td></tr>');
}

// Retorno das cobranças da semana (pro Fábio): quantos alunos o Financeiro
// cobrou, por quem, por qual canal, promessas, e quem pagou depois.
async function carregarRetorno(ini, fim) {
  const kpis = document.getElementById('s-retorno-kpis');
  const tb = document.getElementById('s-retorno');
  tb.innerHTML = '<tr><td colspan="5" class="tabela-msg">Carregando...</td></tr>';
  kpis.innerHTML = '';
  let r;
  try { r = await apiFetch(`/cobranca/edubox/retorno?inicio=${ini}&fim=${fim}`); } catch (err) {
    tb.innerHTML = `<tr><td colspan="5" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
    return;
  }
  const lista = r.alunos.filter(x => (x.grupo || 'graduacao') === grupo).sort((a, b) => b.pagouDepois - a.pagouDepois || a.nome.localeCompare(b.nome));
  const pagaram = lista.filter(x => x.pagouDepois > 0);
  const totalPago = pagaram.reduce((s, x) => s + x.pagouDepois, 0);
  const canais = {};
  const pessoas = {};
  lista.forEach(x => x.acoes.forEach(ac => {
    canais[ac.tipo] = (canais[ac.tipo] || 0) + 1;
    const p = (ac.por || '—').split(' ')[0];
    pessoas[p] = (pessoas[p] || 0) + 1;
  }));
  const promessas = lista.filter(x => x.promessa).length;
  kpis.innerHTML = `
    <div><span>Alunos cobrados</span><b>${lista.length}</b></div>
    <div><span>Pagaram depois da cobrança</span><b>${pagaram.length}</b> <small class="cb-sub">${lista.length ? Math.round(pagaram.length / lista.length * 100) : 0}%</small></div>
    <div><span>🟢 Quanto eles pagaram</span><b>${brl(totalPago)}</b></div>
    <div><span>Promessas</span><b>${promessas}</b></div>
    <div><span>Por canal</span><small>${Object.entries(canais).map(([k, n]) => `${(TIPOS[k] || ['•'])[0]} ${n}`).join(' · ') || '—'}</small></div>
    <div><span>Por pessoa</span><small>${Object.entries(pessoas).map(([k, n]) => `${esc(k)} ${n}`).join(' · ') || '—'}</small></div>`;
  if (!lista.length) {
    tb.innerHTML = `<tr><td colspan="5" class="tabela-msg">Nenhuma cobrança registrada nesta semana (${nomeGrupo()}).</td></tr>`;
    return;
  }
  tb.innerHTML = lista.map(x => `<tr>
    <td>${esc(x.nome)}</td>
    <td>${x.acoes.map(ac => `${(TIPOS[ac.tipo] || ['•'])[0]} ${fmtDataHora(ac.em)}`).join('<br>')}</td>
    <td>${esc([...new Set(x.acoes.map(ac => (ac.por || '').split(' ')[0]))].join(', '))}</td>
    <td>${x.promessa ? `${fmtData(x.promessa.data)}${x.promessa.valor ? ` · ${brl(x.promessa.valor)}` : ''}` : '—'}</td>
    <td class="num">${x.pagouDepois > 0 ? `<b style="color:#047857">${brl(x.pagouDepois)}</b>` : '—'}</td>
  </tr>`).join('');
}

// ---------- IMPRESSÃO ----------
function imprimir() {
  const titulos = { diretor: 'Cobrança — Visão do diretor', painel: 'Cobrança — Painel', lista: 'Cobrança — Lista de alunos', semana: 'Cobrança — Fechamento semanal' };
  document.getElementById('print-titulo').textContent = titulos[visao];
  const partes = [nomeGrupo(), nomeSemestre()];
  if (visao === 'semana') partes.push(document.getElementById('s-rotulo').textContent);
  if (visao === 'lista') {
    for (const id of ['l-controle', 'l-lado', 'l-faixa', 'l-curso']) {
      const s = document.getElementById(id);
      if (s.value) partes.push(s.selectedOptions[0].textContent);
    }
    const de = document.getElementById('l-venc-de').value, ate = document.getElementById('l-venc-ate').value;
    if (de || ate) partes.push(`vencimento ${de ? fmtData(de) : '...'} a ${ate ? fmtData(ate) : '...'}`);
    const pl = document.getElementById('l-plano').value.trim();
    if (pl) partes.push(`plano: ${pl}`);
    mostrando = filtrados.length;
    renderLista();
  }
  if (painel?.status?.ultimaAtualizacao) partes.push(`dados do Edubox de ${fmtDataHora(painel.status.ultimaAtualizacao)}`);
  document.getElementById('print-filtros').textContent = partes.join(' · ');
  const agora = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  document.getElementById('print-data-emissao').textContent = `Emitido em ${agora}${currentUserNome ? ` por ${currentUserNome}` : ''}`;
  window.print();
}

// ---------- EVENTOS ----------
// ---------- BAIXAR RELATÓRIO (08/10/2026) ----------
// Gera um arquivo HTML que abre sozinho no navegador, no estilo do relatório da consultoria: o
// Panorama do grupo e período escolhidos no topo, com os gráficos e a dica ao passar o mouse.
// Só números agregados — o Panorama não tem nome de aluno (e, por garantia, qualquer coluna de
// aluno é retirada). Usa o que a tela já carregou: nenhuma consulta nova ao Edubox.
async function baixarRelatorio() {
  const btn = document.getElementById('btn-baixar-relatorio');
  btn.disabled = true;
  try {
    if (visao !== 'panorama') trocarVisao('panorama');
    // espera o Panorama terminar de desenhar
    for (let i = 0; i < 40 && !document.querySelector('#p-kpis .kpi-card'); i++) await new Promise(r => setTimeout(r, 150));
    await new Promise(r => setTimeout(r, 400));
    const secao = document.getElementById('visao-panorama').cloneNode(true);
    secao.querySelectorAll('button, .cb-pan-tog, .kpi-lupa, .cb-aluno-nome, .acoes-col, .hidden').forEach(e => e.remove());
    secao.removeAttribute('class');
    const aviso = secao.querySelector('#p-aviso');
    if (aviso) aviso.innerHTML = aviso.innerHTML.replace(/\s*Muda com o (semestre|período) escolhido acima\.?/i, '');

    // estilos da página (mesmo servidor) embutidos no arquivo
    let css = '';
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      if (!link.href.startsWith(location.origin)) continue;
      try { css += await (await fetch(link.href)).text() + '\n'; } catch (e) { /* segue sem esse arquivo */ }
    }

    const agora = new Date();
    const periodo = semestre === 'consultoria' ? `${anoAtual()}, ano inteiro (Visão consultoria, 4 grupos)` : nomeSemestre();
    const titulo = `Inadimplência — ${nomeGrupo()} — ${periodo}`;
    const dadosDe = painel?.status?.ultimaAtualizacao ? fmtDataHora(painel.status.ultimaAtualizacao) : '';
    const scriptDica = `(function(){var d=document.createElement('div');d.className='cb-dica';document.body.appendChild(d);
var SEL='[data-dica], .cb-pan-faixa, .cb-faixa, .cb-rank';
function esc(t){return String(t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function linhas(a){if(a.dataset&&a.dataset.dica)return a.dataset.dica.split('|');var n=a.querySelector(':scope > span'),b=a.querySelector(':scope > b');if(!b)return null;var sm=b.querySelector('small');var v=[].slice.call(b.childNodes).filter(function(x){return x!==sm;}).map(function(x){return x.textContent;}).join('').trim();return [(n?n.textContent:'').trim(),v].concat(sm?sm.textContent.replace(/\\s+/g,' ').trim().split(' · '):[]);}
function show(a,x,y){var l=linhas(a);if(!l||!l[0]){d.style.opacity=0;return;}d.innerHTML='<div class="t">'+esc(l[0])+'</div>'+(l[1]?'<b>'+esc(l[1])+'</b>':'')+l.slice(2).map(function(t){return '<div>'+esc(t)+'</div>';}).join('');d.style.opacity=1;var w=d.offsetWidth,h=d.offsetHeight,L=x+14,T=y+14;if(L+w>innerWidth-8)L=x-w-14;if(T+h>innerHeight-8)T=y-h-14;d.style.left=L+'px';d.style.top=T+'px';}
document.addEventListener('mousemove',function(e){var a=e.target.closest&&e.target.closest(SEL);if(a)show(a,e.clientX,e.clientY);else d.style.opacity=0;});
document.addEventListener('touchstart',function(e){var a=e.target.closest&&e.target.closest(SEL);if(a){var t=e.touches[0];show(a,t.clientX,t.clientY);}else d.style.opacity=0;},{passive:true});})();`;

    const html = `<!DOCTYPE html><html lang="pt-br"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${css}
body{margin:0;background:#eceff4}.rel-pagina{max-width:1180px;margin:0 auto;padding:16px}
.rel-topo{background:#12294d;color:#fff;border-radius:14px;padding:1.2rem 1.5rem;margin-bottom:1rem}
.rel-topo small{color:#aebdd6;font-size:.75rem}.rel-topo h1{font-family:Archivo,sans-serif;font-weight:800;font-size:1.6rem;margin:.2rem 0}
.rel-topo p{margin:0;color:#c3d0e4;font-size:.85rem}.rel-rodape{color:#8793a6;font-size:.75rem;line-height:1.6;margin:1.5rem 0 1rem;border-top:1px solid #e3e8f0;padding-top:.8rem}
@media print{body{background:#fff}.rel-pagina{max-width:none}}
</style></head>
<body class="cb-rel"><div class="layout-content rel-pagina">
<div class="rel-topo"><small>FATEC Ivaiporã · Contas a receber · Mensalidades</small><h1>${esc(titulo)}</h1>
<p>Gerado em ${esc(agora.toLocaleString('pt-BR'))}${dadosDe ? ` · dados do Edubox de ${esc(dadosDe)}` : ''} · por ${esc(currentUserNome || '')}</p></div>
${secao.outerHTML}
<div class="rel-rodape"><b>Como ler.</b> Atrasado = mensalidade que venceu e não foi paga (valor original, sem juros, salvo indicação). % de inadimplência = atrasado ÷ o que já venceu no período. Curva ABC: A = alunos que somam até 80% do atrasado, B até 95%, C o restante. Semestre pela data de vencimento (jan–jun = 1º, jul–dez = 2º). Relatório sem identificação de alunos, gerado pelo Órbita a partir do Edubox.</div>
</div><script>${scriptDica}<\/script></body></html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    const nomeArq = `relatorio-inadimplencia-${grupo}-${(semestre === 'consultoria' ? anoAtual() + '-ano' : (mes || semestre)).replace(/[^0-9a-z.-]/gi, '')}-${iso(agora)}.html`;
    a.href = URL.createObjectURL(blob); a.download = nomeArq;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    showToast(`Relatório baixado: ${nomeArq}`);
  } catch (err) {
    showToast(`Não foi possível gerar o relatório: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function trocarVisao(v) {
  visao = v;
  if (semestre === 'consultoria' && v !== 'panorama') {   // a visão consultoria só existe no Panorama
    semestre = semestreAtual();
    sincronizarCaixasPeriodo();
  }
  document.querySelectorAll('#visoes button').forEach(b => b.classList.toggle('ativa', b.dataset.visao === v));
  for (const x of ['diretor', 'panorama', 'painel', 'lista', 'semana']) document.getElementById(`visao-${x}`).classList.toggle('hidden', x !== v);
  if (painel && !painel.vazio) renderTudo();
}

function wireEventos() {
  document.getElementById('p-cursos').addEventListener('click', (e) => {
    const linha = e.target.closest('.cb-rank-link');
    if (!linha) return;
    cursoPedido = linha.dataset.curso;
    trocarVisao('lista');
  });
  ligarDicas();
  document.getElementById('abas-grupo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-grupo]');
    if (!b) return;
    grupo = b.dataset.grupo;
    document.querySelectorAll('#abas-grupo .aba').forEach(x => x.classList.toggle('ativa', x === b));
    document.getElementById('l-curso').value = '';
    if (painel && !painel.vazio) renderTudo();
  });
  document.getElementById('visoes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-visao]');
    if (b) trocarVisao(b.dataset.visao);
  });
  document.getElementById('sel-mes').addEventListener('change', (e) => {
    mes = e.target.value;
    renderTudo();
  });
  document.getElementById('sel-ano').addEventListener('change', (e) => {
    const anoEscolhido = e.target.value;
    montarPeriodo(anoEscolhido);
    const sel = document.getElementById('sel-sem-periodo');
    // No ano atual, parte pro semestre vigente (não pro 1º da lista) — é o
    // que a tela já mostrava por padrão antes de ter essa caixa (08/10/2026).
    const preferido = anoEscolhido === anoAtual() ? semestreAtual().split('.')[1] : null;
    if (preferido && [...sel.options].some(o => o.value === preferido)) sel.value = preferido;
    else if (sel.options.length) sel.value = sel.options[0].value;
    aplicarCaixasPeriodo();
  });
  document.getElementById('sel-sem-periodo').addEventListener('change', aplicarCaixasPeriodo);
  document.getElementById('p-curso-metric').addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    panMetric = b.dataset.m;
    document.querySelectorAll('#p-curso-metric button').forEach(x => x.classList.toggle('ativa', x === b));
    renderPanorama();
  });
  document.getElementById('p-divisao').addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]'); if (!b) return;
    consBase = b.dataset.b;
    renderPanorama();
  });
  // "ver a conta" — delegado no container do Panorama/Visão consultoria,
  // porque os botões 🔍 são recriados a cada render.
  document.getElementById('visao-panorama').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ver-conta]');
    if (!b) return;
    abrirDetalheCobranca(b.dataset.verConta, b.dataset.verExtra);
  });
  document.getElementById('btn-fechar-detalhe-total').addEventListener('click', () => document.getElementById('modal-detalhe-total').classList.add('hidden'));
  document.getElementById('btn-atualizar').addEventListener('click', atualizarAgora);
  document.getElementById('tb-semestres').addEventListener('click', (e) => {
    const tr = e.target.closest('[data-sem]');
    if (!tr) return;
    semestre = tr.dataset.sem;
    sincronizarCaixasPeriodo();
    mostrando = POR_PAGINA;
    renderTudo();
  });
  document.getElementById('btn-imprimir').addEventListener('click', imprimir);
  document.getElementById('btn-baixar-relatorio').addEventListener('click', baixarRelatorio);
  document.getElementById('btn-modelos').addEventListener('click', abrirModelos);

  // lista
  let t;
  document.getElementById('l-busca').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { mostrando = POR_PAGINA; filtrarLista(); }, 250); });
  for (const id of ['l-controle', 'l-lado', 'l-faixa', 'l-curso', 'l-pagando', 'l-venc-de', 'l-venc-ate']) {
    document.getElementById(id).addEventListener('change', () => { mostrando = POR_PAGINA; filtrarLista(); });
  }
  let tp;
  document.getElementById('l-plano').addEventListener('input', () => { clearTimeout(tp); tp = setTimeout(() => { mostrando = POR_PAGINA; filtrarLista(); }, 300); });
  document.getElementById('l-mais').addEventListener('click', () => { mostrando += POR_PAGINA; renderLista(); });
  document.getElementById('tb-alunos').addEventListener('click', (e) => {
    const z = e.target.closest('[data-zap]');
    if (z) { abrirZap(Number(z.dataset.zap)); return; }
    const a = e.target.closest('[data-abrir]');
    if (a) abrirAluno(Number(a.dataset.abrir));
  });

  // whatsapp
  document.getElementById('zap-modelo').addEventListener('change', (e) => {
    const m = modelos.find(x => x.id === e.target.value);
    if (m) document.getElementById('zap-texto').value = preencher(m.texto, alunoAberto);
  });
  document.getElementById('zap-enviar').addEventListener('click', enviarZap);
  document.getElementById('zap-fechar').addEventListener('click', () => document.getElementById('modal-zap').classList.add('hidden'));
  document.getElementById('zap-proximo').addEventListener('click', () => {
    const i = proximoNaoCobrado(alunoAberto.idx);
    if (i < 0) { document.getElementById('modal-zap').classList.add('hidden'); return; }
    if (i >= mostrando) { mostrando = i + 1; renderLista(); }
    abrirZap(i);
  });

  // detalhe do aluno
  document.getElementById('al-fechar').addEventListener('click', () => document.getElementById('modal-aluno').classList.add('hidden'));
  document.getElementById('ac-tipo').addEventListener('change', (e) => {
    document.getElementById('ac-promessa').classList.toggle('hidden', e.target.value !== 'promessa_pagamento');
    if (e.target.value === 'promessa_pagamento' && !document.getElementById('ac-valor').value) document.getElementById('ac-valor').value = alunoAberto.totalVis;
  });
  document.getElementById('form-acao').addEventListener('submit', salvarAcao);
  document.getElementById('al-historico').addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]');
    if (d) excluirAcao(d.dataset.del);
  });

  // modelos
  document.getElementById('modelos-novo').addEventListener('click', () => {
    renderModelos([...lerModelosDaTela(), { id: `m${Date.now()}`, nome: '', texto: '' }]);
  });
  document.getElementById('modelos-lista').addEventListener('click', (e) => {
    const r = e.target.closest('[data-remover]');
    if (r) r.closest('.cb-modelo').remove();
  });
  document.getElementById('modelos-cancelar').addEventListener('click', () => document.getElementById('modal-modelos').classList.add('hidden'));
  document.getElementById('modelos-salvar').addEventListener('click', salvarModelos);

  // semana
  document.getElementById('s-anterior').addEventListener('click', () => {
    const base = semanaRef ? dataLocal(semanaRef) : segunda();
    semanaRef = iso(somaDias(base, -7));
    renderSemana();
  });
  document.getElementById('s-proxima').addEventListener('click', () => {
    const base = semanaRef ? dataLocal(semanaRef) : segunda();
    const prox = somaDias(base, 7);
    semanaRef = iso(prox) >= iso(segunda()) ? null : iso(prox);
    renderSemana();
  });
  document.getElementById('s-atual').addEventListener('click', () => { semanaRef = null; renderSemana(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['modal-zap', 'modal-aluno', 'modal-modelos', 'modal-detalhe-total'].forEach(id => document.getElementById(id).classList.add('hidden'));
  });
}
