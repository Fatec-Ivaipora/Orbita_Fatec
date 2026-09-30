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
const FAIXAS = [['1-30', 'Até 30 dias', '#facc15'], ['31-60', '31 a 60 dias', '#fb923c'], ['61-90', '61 a 90 dias', '#ef4444'], ['90+', 'Mais de 90 dias', '#7f1d1d']];
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
let visao = 'painel';
let semestre = '';
let painel = null;          // resposta de /painel (semana atual)
let semanaRef = null;       // 'AAAA-MM-DD' da semana do fechamento (null = atual)
let semanaDados = null;
const listas = {};          // grupo -> { alunos, controle, geradoEm }
let filtrados = [];
let mostrando = POR_PAGINA;
let modelos = null;
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
function nomeSemestre() { return semestre === 'todos' ? 'Todos os semestres' : `Semestre ${semestre}`; }
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

function montarSemestres() {
  const sel = document.getElementById('sel-semestre');
  const lista = (painel.semestres || []).filter(s => /^\d{4}\.\d$/.test(s));
  if (!semestre) semestre = lista.includes(semestreAtual()) ? semestreAtual() : 'todos';
  sel.innerHTML = `<option value="todos">Todos os semestres (acumulado)</option>` +
    lista.map(s => `<option value="${s}">Semestre ${s}</option>`).join('');
  sel.value = semestre;
}

function renderTudo() {
  if (visao === 'painel') renderPainel();
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
function recorte() {
  const r = painel?.resumo?.[semestre]?.[grupo];
  return r || null;
}
// Jurídico é sempre o acumulado (ver somaBaixas).
function recorteJuridico() {
  return painel?.resumo?.todos?.[grupo] || null;
}

// Soma das baixas de uma lista de dias, no grupo/semestre escolhidos.
function somaBaixas(dias) {
  const t = { financeiro: 0, juridico: 0, financeiroAtraso: 0, juridicoAtraso: 0 };
  for (const d of dias) {
    if (semestre === 'todos') {
      t.financeiro += d[grupo].financeiro.valor; t.juridico += d[grupo].juridico.valor;
      t.financeiroAtraso += d[grupo].financeiro.emAtraso; t.juridicoAtraso += d[grupo].juridico.emAtraso;
    } else {
      // Jurídico não filtra por semestre: no Edubox o acordo fica no semestre
      // da dívida original (2017, 2021...), nunca no semestre atual.
      const s = d.porSemestre?.[semestre]?.[grupo];
      if (s) { t.financeiro += s.financeiro; t.financeiroAtraso += s.financeiroAtraso; }
      t.juridico += d[grupo].juridico.valor; t.juridicoAtraso += d[grupo].juridico.emAtraso;
    }
  }
  return t;
}

function renderPainel() {
  const r = recorte();
  const vazio = { valor: 0, alunos: 0, parcelas: 0 };
  const v = r ? r.vencido : vazio;
  const rj = recorteJuridico();
  const fin = r ? r.financeiro.vencido : vazio;
  const jur = rj ? rj.juridico.vencido : vazio;
  const finAdv = (r && r.financeiroComAdvogado) || vazio;
  // Quem está com advogado não pode ser cobrado pelo Financeiro.
  document.getElementById('k-vencido').textContent = brl(fin.valor - finAdv.valor);
  document.getElementById('k-vencido-hint').textContent = `${plural(fin.alunos - finAdv.alunos, 'aluno', 'alunos')} · ${plural(fin.parcelas - finAdv.parcelas, 'parcela', 'parcelas')} · sem quem está com advogado`;
  document.getElementById('k-jur').textContent = brl(jur.valor);
  document.getElementById('k-jur-hint').textContent = `${plural(jur.alunos, 'aluno', 'alunos')} · ${brl(rj ? rj.juridico.aVencer.valor : 0)} a vencer · todos os semestres`;
  document.getElementById('k-fin').textContent = brl(finAdv.valor);
  document.getElementById('k-fin-hint').textContent = `${plural(finAdv.alunos, 'aluno', 'alunos')} — NÃO cobrar: está com o advogado`;
  const aviso = document.getElementById('aviso-advogado');
  aviso.classList.toggle('hidden', semestre === 'todos');
  aviso.textContent = `Semestre ${semestre}: os valores do Financeiro são deste semestre. O Jurídico / advogado aparece sempre com todos os semestres, porque no Edubox o acordo fica registrado no semestre da dívida original.`;

  const b = somaBaixas(painel.semana.baixas);
  const hojeISO = iso(new Date());
  const bh = somaBaixas(painel.semana.baixas.filter(d => d.data === hojeISO));
  document.getElementById('k-recebido').textContent = brl(b.financeiro + b.juridico);
  document.getElementById('k-recebido-hint').textContent = `Financeiro ${brl(b.financeiro)} · Jurídico ${brl(b.juridico)} · hoje ${brl(bh.financeiro + bh.juridico)}`;

  const maxF = Math.max(1, ...FAIXAS.map(([k]) => r ? r.faixas[k].valor : 0));
  document.getElementById('faixas').innerHTML = FAIXAS.map(([k, rot, cor]) => {
    const f = r ? r.faixas[k] : vazio;
    return `<div class="cb-faixa"><span>${rot}</span><div class="cb-faixa-barra"><span style="width:${(f.valor / maxF) * 100}%;background:${cor}"></span></div><b>${brl(f.valor)}<small>${plural(f.alunos, 'aluno', 'alunos')}</small></b></div>`;
  }).join('');

  const av = r ? r.aVencer : vazio;
  document.getElementById('a-vencer').innerHTML = `
    <div><span>Financeiro${semestre !== 'todos' ? ` (${semestre})` : ''}</span><b>${brl(r ? r.financeiro.aVencer.valor : 0)}</b> <small class="cb-sub">${plural(r ? r.financeiro.aVencer.alunos : 0, 'aluno', 'alunos')}</small></div>
    <div><span>Jurídico (todos os semestres)</span><b>${brl(rj ? rj.juridico.aVencer.valor : 0)}</b> <small class="cb-sub">${plural(rj ? rj.juridico.aVencer.alunos : 0, 'aluno', 'alunos')}</small></div>
    <div style="grid-column:1/-1"><span>Total a vencer</span><b>${brl((r ? r.financeiro.aVencer.valor : 0) + (rj ? rj.juridico.aVencer.valor : 0))}</b></div>`;

  // por plano jurídico (acumulado) + recebido na semana
  const planos = rj ? Object.entries(rj.planosJuridico || {}) : [];
  const recPlano = {};
  for (const d of painel.semana.baixas) for (const [k, val] of Object.entries(d[grupo].juridico.porPlano || {})) recPlano[k] = (recPlano[k] || 0) + val;
  const tp = document.getElementById('tb-planos');
  tp.innerHTML = planos.length
    ? planos.sort((a, b2) => b2[1].vencido.valor - a[1].vencido.valor).map(([k, x]) =>
        `<tr><td>${esc(k)}</td><td class="num">${x.vencido.alunos}</td><td class="num"><b>${brl(x.vencido.valor)}</b></td><td class="num">${brl(x.aVencer.valor)}</td><td class="num">${brl(recPlano[k] || 0)}</td></tr>`).join('') +
      `<tr class="mes-linha"><td><b>Total</b></td><td class="num"><b>${jur.alunos}</b></td><td class="num"><b>${brl(jur.valor)}</b></td><td class="num"><b>${brl(rj.juridico.aVencer.valor)}</b></td><td class="num"><b>${brl(Object.values(recPlano).reduce((s2, x) => s2 + x, 0))}</b></td></tr>`
    : '<tr><td colspan="5" class="tabela-msg">Nenhum aluno com advogado neste grupo.</td></tr>';

  const cursos = r ? Object.entries(r.porCurso).sort((a, b2) => b2[1].vencido.valor - a[1].vencido.valor) : [];
  const tb = document.getElementById('tb-cursos');
  if (!cursos.length) { tb.innerHTML = '<tr><td colspan="5" class="tabela-msg">Nada vencido neste recorte.</td></tr>'; return; }
  tb.innerHTML = cursos.map(([c, x]) => `<tr><td>${esc(nomeCurso(c))}</td><td class="num">${x.vencido.alunos}</td><td class="num">${brl(x.financeiroVencido.valor)}</td><td class="num">${brl(x.juridicoVencido.valor)}</td><td class="num"><b>${brl(x.vencido.valor)}</b></td></tr>`).join('') +
    `<tr class="mes-linha"><td><b>Total</b></td><td class="num"><b>${v.alunos}</b></td><td class="num"><b>${brl(fin.valor)}</b></td><td class="num"><b>${brl(jur.valor)}</b></td><td class="num"><b>${brl(v.valor)}</b></td></tr>`;
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
  const cursos = [...new Set(listas[grupo].alunos.flatMap(a => a.cursos))].sort();
  const selC = document.getElementById('l-curso');
  const atualC = selC.value;
  selC.innerHTML = '<option value="">Todos os cursos</option>' + cursos.map(c => `<option value="${esc(c)}">${esc(nomeCurso(c))}</option>`).join('');
  selC.value = cursos.includes(atualC) ? atualC : '';
  mostrando = POR_PAGINA;
  filtrarLista();
}

function faixaDe(dias) { return dias <= 30 ? '1-30' : dias <= 60 ? '31-60' : dias <= 90 ? '61-90' : '90+'; }

// Aluno com só as parcelas do semestre / lado escolhidos.
// modo 'cobrar': só quem NÃO está com advogado (o Financeiro não pode cobrar
// quem está), parcelas do semestre escolhido. modo 'advogado': só quem está,
// todas as parcelas vencidas (o acordo fica no semestre da dívida original).
function recortarAluno(a, modo) {
  const hoje = Date.now();
  if ((modo === 'advogado') !== !!a.comAdvogado) return null;
  const parcelas = modo === 'advogado' ? a.parcelas : a.parcelas.filter(p => semestre === 'todos' || p.s === semestre);
  if (!parcelas.length) return null;
  const total = parcelas.reduce((s, p) => s + p.valor, 0);
  const maisAntigo = parcelas[0].v;
  const dias = Math.round((hoje - dataLocal(maisAntigo).getTime()) / 86400000);
  return { ...a, parcelasVis: parcelas, totalVis: Math.round(total * 100) / 100, maisAntigoVis: maisAntigo, diasVis: dias, temJuridico: parcelas.some(p => p.j) };
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
  const agoraISO = new Date().toISOString();

  filtrados = [];
  for (const bruto of L.alunos) {
    const a = recortarAluno(bruto, lado);
    if (!a) continue;
    if (curso && !a.cursos.includes(curso)) continue;
    if (faixa && faixaDe(a.diasVis) !== faixa) continue;
    if (busca && !a.nome.toLowerCase().includes(busca) && !(buscaDig.length >= 3 && a.cpf.includes(buscaDig))) continue;
    const { c, semana } = situacaoCobranca(a);
    if (ctl === 'nao-semana' && semana) continue;
    if (ctl === 'sim-semana' && !semana) continue;
    if (ctl === 'nunca' && c) continue;
    if (ctl === 'nao-15' && c && diasDesde(c.em) < 15) continue;
    if (ctl === 'nao-30' && c && diasDesde(c.em) < 30) continue;
    if (ctl === 'promessa' && !(c && c.promessa)) continue;
    filtrados.push(a);
  }
  filtrados.sort((x, y) => y.totalVis - x.totalVis);

  const total = filtrados.reduce((s, a) => s + a.totalVis, 0);
  const cobradosSemana = filtrados.filter(a => situacaoCobranca(a).semana).length;
  if (lado === 'advogado') {
    document.getElementById('l-contadores').innerHTML = `
      <span>⚖️ <b>${filtrados.length}</b> alunos com o advogado · <b>${brl(total)}</b> vencido</span>
      <span>O Financeiro <b>não cobra</b> esses alunos — só consulta e registra observações</span>
      <span class="cb-sub">Lista do Edubox de ${fmtDataHora(L.geradoEm)}</span>`;
    renderLista();
    return;
  }
  document.getElementById('l-contadores').innerHTML = `
    <span><b>${filtrados.length}</b> alunos · <b>${brl(total)}</b></span>
    <span>✅ Cobrados nesta semana: <b>${cobradosSemana}</b></span>
    <span>⏳ Faltam cobrar: <b>${filtrados.length - cobradosSemana}</b></span>
    <span class="cb-sub">Lista do Edubox de ${fmtDataHora(L.geradoEm)}</span>`;
  renderLista(agoraISO);
}

function badgeCobranca(a) {
  if (a.comAdvogado) return `<span class="cb-cobrado antigo">⚖️ Com o advogado</span><div class="cb-sub">${esc((a.planosAdvogado || []).join(', ').toLowerCase())}</div>`;
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
      <td><span class="cb-aluno-nome" data-abrir="${i}">${esc(a.nome)}</span>${a.comAdvogado ? `<span class="cb-tag-jur" title="${esc((a.planosAdvogado || []).join(', '))}">COM ADVOGADO — NÃO COBRAR</span>` : ''}
        <div class="cb-sub">${esc(a.cursos.map(nomeCurso).join(' / '))} · ${esc(a.fone || 'sem telefone')}</div></td>
      <td>${plural(a.parcelasVis.length, 'parcela', 'parcelas')}<span class="cb-atraso ${classeF[faixaDe(a.diasVis)]}">${a.diasVis} dias</span>
        <div class="cb-sub">desde ${fmtData(a.maisAntigoVis)}</div></td>
      <td class="num"><b>${brl(a.totalVis)}</b></td>
      <td>${badgeCobranca(a)}</td>
      <td class="acoes-col">
        ${podeEditar && !a.comAdvogado ? `<button type="button" class="btn-acao zap" data-zap="${i}" title="${a.celular ? 'Enviar cobrança pelo WhatsApp' : 'Sem celular no Edubox'}">💬 WhatsApp</button>` : ''}
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
  const lista = a.parcelasVis.map(p => `• Venc. ${fmtData(p.v)} — ${brl(p.valor)}`).join('\n');
  const vars = {
    nome: nomeT, primeiro_nome: nomeT.split(' ')[0], valor_total: brl(a.totalVis),
    qtd_parcelas: plural(a.parcelasVis.length, 'parcela', 'parcelas'), lista_parcelas: lista,
    vencimento_mais_antigo: fmtData(a.maisAntigoVis), dias_atraso: String(a.diasVis), curso: a.cursos.map(nomeCurso).join(' / ')
  };
  return texto.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function modeloSugerido(a) {
  const id = a.diasVis > 30 ? 'cobranca' : 'lembrete';
  return modelos.find(m => m.id === id) ? id : modelos[0].id;
}

async function abrirZap(i) {
  const a = filtrados[i];
  if (!a || a.comAdvogado) return;
  try { await garantirModelos(); } catch (e) { showToast(e.message, 'error'); return; }
  alunoAberto = { ...a, idx: i };
  document.getElementById('zap-sub').innerHTML = `<b>${esc(a.nome)}</b> · ${plural(a.parcelasVis.length, 'parcela', 'parcelas')} · ${brl(a.totalVis)} · ${a.diasVis} dias de atraso`;
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
    if (filtrados[i].celular && !filtrados[i].comAdvogado && !situacaoCobranca(filtrados[i]).semana) return i;
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
  document.getElementById('al-sub').innerHTML = `CPF ${esc(a.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'))} · ${esc(a.fone || 'sem telefone')} · ${esc(a.cursos.map(nomeCurso).join(' / '))}`;
  document.getElementById('al-parcelas').innerHTML = a.parcelasVis.map(p =>
    `<div><span>${fmtData(p.v)} <small class="cb-sub">(${esc(p.s)})</small>${p.j ? '<span class="cb-tag-jur">JUR</span>' : ''}</span><b>${brl(p.valor)}</b></div>`).join('') +
    `<div class="total"><span>Total</span><span>${brl(a.totalVis)}</span></div>`;
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
  // Se a 1ª "foto" do vencido é do meio da semana (PC desligado na segunda, ou
  // o começo do controle), a conta usa só o recebido a partir dela.
  const fotoAtrasada = sem.fotoInicio && sem.fotoInicio.data > sem.inicio;
  const bConta = fotoAtrasada ? somaBaixas(sem.baixas.filter(d => d.data >= sem.fotoInicio.data)) : b;
  const valorFoto = (foto, lado) => foto?.vencido?.[lado === 'juridico' ? 'todos' : semestre]?.[grupo]?.[lado];
  const fimFonte = atual ? null : sem.fotoFim;
  const avisos = [];
  if (!sem.fotoInicio) avisos.push('Não há registro do vencido no começo desta semana (o controle começou a ser gravado em 30/09/2026 ou o PC de atualização estava desligado). Os recebimentos estão completos.');
  else if (fotoAtrasada) avisos.push(`O primeiro registro do vencido nesta semana é de ${fmtDataHora(sem.fotoInicio.geradoEm)} (o PC de atualização não rodou antes disso). A conta abaixo parte desse momento; o "Recebido total na semana" e as tabelas mostram a semana inteira.`);
  document.getElementById('s-aviso').innerHTML = avisos.map(t => `<div class="cb-aviso">${esc(t)}</div>`).join('');

  const lados = [['financeiro', '💼 Financeiro'], ['juridico', `⚖️ Jurídico / advogado${semestre !== 'todos' ? ' <small class="cb-sub">(todos os semestres)</small>' : ''}`]];
  document.getElementById('s-lados').innerHTML = lados.map(([lado, titulo]) => {
    const inicio = valorFoto(sem.fotoInicio, lado);
    const fim = atual ? ((lado === 'juridico' ? recorteJuridico() : recorte())?.[lado]?.vencido?.valor ?? 0) : valorFoto(fimFonte, lado);
    const recAtraso = bConta[`${lado}Atraso`];
    const recTotal = b[lado];
    const temConta = inicio !== undefined && fim !== undefined;
    const novos = temConta ? fim - inicio + recAtraso : null;
    const quandoIni = sem.fotoInicio ? fmtDataHora(sem.fotoInicio.geradoEm) : '';
    const quandoFim = atual ? fmtDataHora(painel.geradoEm) : (fimFonte ? fmtDataHora(fimFonte.geradoEm) : '');
    return `<div class="card cb-lado">
      <h3>${titulo}</h3>
      <div class="cb-conta"><span>${fotoAtrasada ? 'Vencido no 1º registro da semana' : 'Começou a semana com'}<small>vencido em ${quandoIni || '—'}</small></span><b>${inicio !== undefined ? brl(inicio) : '—'}</b></div>
      <div class="cb-conta menos"><span>− Recebido de parcelas vencidas<small>pagou depois do vencimento</small></span><b>${brl(recAtraso)}</b></div>
      <div class="cb-conta mais"><span>+ Entrou em atraso / ajustes<small>novos vencimentos, renegociações, cancelamentos</small></span><b>${novos !== null ? brl(novos) : '—'}</b></div>
      <div class="cb-conta resultado"><span>${atual ? 'Vencido agora' : 'Terminou a semana com'}<small>${quandoFim}</small></span><b>${fim !== undefined ? brl(fim) : '—'}</b></div>
      <div class="cb-conta"><span>Recebido total na semana<small>inclui parcelas pagas em dia</small></span><b>${brl(recTotal)}</b></div>
    </div>`;
  }).join('');

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

  // por tipo e por curso: só no acumulado (o Edubox não separa isso por semestre aqui)
  const somaMapa = (campo) => {
    const m = {};
    for (const d of sem.baixas) for (const lado of ['financeiro', 'juridico']) {
      for (const [k, v] of Object.entries(d[grupo][lado][campo] || {})) {
        m[k] = m[k] || { financeiro: 0, juridico: 0 };
        m[k][lado] += v;
      }
    }
    return Object.entries(m).sort((x, y) => (y[1].financeiro + y[1].juridico) - (x[1].financeiro + x[1].juridico));
  };
  const soAcumulado = '<tr><td colspan="4" class="tabela-msg">Disponível em "Todos os semestres".</td></tr>';
  const tipos = somaMapa('porTipo');
  document.getElementById('s-tipos').innerHTML = semestre !== 'todos' ? soAcumulado : (tipos.length
    ? tipos.map(([k, v]) => `<tr><td>${esc(k.charAt(0) + k.slice(1).toLowerCase())}</td><td class="num">${brl(v.financeiro)}</td><td class="num">${brl(v.juridico)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="tabela-msg">Nenhum recebimento.</td></tr>');
  const cursos = somaMapa('porCurso');
  document.getElementById('s-cursos').innerHTML = semestre !== 'todos' ? soAcumulado : (cursos.length
    ? cursos.map(([k, v]) => `<tr><td>${esc(nomeCurso(k))}</td><td class="num">${brl(v.financeiro)}</td><td class="num">${brl(v.juridico)}</td><td class="num"><b>${brl(v.financeiro + v.juridico)}</b></td></tr>`).join('')
    : '<tr><td colspan="4" class="tabela-msg">Nenhum recebimento.</td></tr>');
}

// ---------- IMPRESSÃO ----------
function imprimir() {
  const titulos = { painel: 'Cobrança — Painel', lista: 'Cobrança — Lista de alunos', semana: 'Cobrança — Fechamento semanal' };
  document.getElementById('print-titulo').textContent = titulos[visao];
  const partes = [nomeGrupo(), nomeSemestre()];
  if (visao === 'semana') partes.push(document.getElementById('s-rotulo').textContent);
  if (visao === 'lista') {
    for (const id of ['l-controle', 'l-lado', 'l-faixa', 'l-curso']) {
      const s = document.getElementById(id);
      if (s.value) partes.push(s.selectedOptions[0].textContent);
    }
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
function trocarVisao(v) {
  visao = v;
  document.querySelectorAll('#visoes button').forEach(b => b.classList.toggle('ativa', b.dataset.visao === v));
  for (const x of ['painel', 'lista', 'semana']) document.getElementById(`visao-${x}`).classList.toggle('hidden', x !== v);
  if (painel && !painel.vazio) renderTudo();
}

function wireEventos() {
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
  document.getElementById('sel-semestre').addEventListener('change', (e) => {
    semestre = e.target.value;
    mostrando = POR_PAGINA;
    renderTudo();
  });
  document.getElementById('btn-atualizar').addEventListener('click', atualizarAgora);
  document.getElementById('btn-imprimir').addEventListener('click', imprimir);
  document.getElementById('btn-modelos').addEventListener('click', abrirModelos);

  // lista
  let t;
  document.getElementById('l-busca').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { mostrando = POR_PAGINA; filtrarLista(); }, 250); });
  for (const id of ['l-controle', 'l-lado', 'l-faixa', 'l-curso']) {
    document.getElementById(id).addEventListener('change', () => { mostrando = POR_PAGINA; filtrarLista(); });
  }
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
    ['modal-zap', 'modal-aluno', 'modal-modelos'].forEach(id => document.getElementById(id).classList.add('hidden'));
  });
}
