import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';
import { getEffectiveLevel } from '../../core/permissions.js';
import { opcaoEscolhida, imprimirRelatorio } from '../../comercial/comercial-comum.js';

// ==========================================================================
// Agenda Interna Fatec IVP (auditório e salas). Secretaria + ADM editam;
// todo mundo consulta e pode "Solicitar reserva" (fica pendente até a
// Secretaria aprovar). Visões: semana, mês e semestre/lista.
// Tudo que initApp usa de forma síncrona fica declarado aqui em cima (o
// initApp roda antes do fim do arquivo quando há login em cache).
// ==========================================================================
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

const MODULO = 'agenda-espacos';
const NIVEL_PADRAO = { adm_l2: 3, sec: 3 }; // demais: 2 (consulta)
const TODAS = 'Todas as salas';
const DIAS_CURTOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const DIAS_LONGOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const PALETA = ['#0F4EB8', '#0e7490', '#047857', '#b45309', '#be185d', '#4338ca', '#15803d', '#c2410c', '#0369a1', '#7c2d12', '#6d28d9', '#a16207'];
const FILTROS = ['busca', 'filtro-espaco', 'filtro-tipo', 'filtro-status'];

// Modelo de resposta que a Secretaria já manda pra órgão externo (e-mail ou
// WhatsApp) — "Resposta ao ofício" preenche com ofício, espaço, datas e horários.
const OBSERVACOES_OFICIO = [
  'Fica por responsabilidade do ocupante a limpeza do local após o uso, assim como também trazer os materiais de higiene e uso próprio (PAPEL HIGIÊNICO, PAPEL TOALHA, ÁLCOOL EM GEL E SABONETE LÍQUIDO).',
  'Fica de responsabilidade do ocupante fazer a recepção do evento e direcionamento para os espaços de acomodação.',
  'Fica por responsabilidade do ocupante a limpeza dos banheiros, salas/auditório e pátio utilizados após o uso.',
  'Fica por responsabilidade do ocupante trazer os materiais que serão utilizados na palestra.',
  'Fica por responsabilidade do ocupante respeitar os horários de entrada e saída do local.',
  'Não será disponibilizada a cozinha da IES para armazenamento de alimentos.',
  'A IES tem disponível apenas 01 mesa que está no pátio, para servir o café (se necessário); caso a mesma não comporte, fica de responsabilidade do organizador providenciar outra mesa do tamanho que considerar necessário.',
  'A acomodação e retirada dos materiais adicionais deverão acontecer no dia do evento, devendo-se respeitar os horários disponibilizados para realização do evento.'
];

let currentUser = null;
let currentUserNome = '';
let appInitialized = false;
let initializedRole = null;

let espacos = [];
let reservas = [];
let podeEditar = false;
let visao = 'semana';
let referencia = new Date();       // semana/mês exibidos
let semestreSel = '';
let emEdicao = null;               // reserva aberta no formulário
let coordenadores = null;          // [{uid, nome}] — sugestão no "Responsável" (só quem edita)
const cacheDia = {};               // disponibilidade por data (formulário)

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(options.headers || {}) };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error || `Erro na API: ${res.status}`);
    e.conflitos = j.conflitos || [];
    throw e;
  }
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

// Datas sempre 'AAAA-MM-DD' — Date local ao meio-dia (evita pular dia pelo fuso).
function dataLocal(s) { const [a, m, d] = s.split('-').map(Number); return new Date(a, m - 1, d, 12); }
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fmtData(s) { const [a, m, d] = s.split('-'); return `${d}/${m}/${a}`; }
const hoje = () => iso(new Date());
function inicioSemana(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function somaDias(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function semestreDe(d) { return `${d.getFullYear()}.${d.getMonth() < 6 ? 1 : 2}`; }
function intervaloSemestre(s) { const [a, n] = s.split('.'); return n === '1' ? [`${a}-01-01`, `${a}-06-30`] : [`${a}-07-01`, `${a}-12-31`]; }

function corDo(espaco) {
  if (espaco === 'Auditório') return '#6d28d9';
  if (espaco === TODAS) return '#b91c1c';
  const i = Math.max(0, espacos.indexOf(espaco));
  return PALETA[i % PALETA.length];
}
function estiloCor(espaco) {
  const c = corDo(espaco);
  return `--cor:${c};--cor-fundo:${c}14;`;
}

// ---------- AUTH ----------
const cached = getCachedAuth();
if (cached) {
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
    let level = 2;
    if (role === 'adm_l1') level = 3;
    else {
      try {
        const perms = await apiFetchComRetentativa('/usuarios/config/permissions');
        const doCargo = perms[role] || {};
        const semConfig = doCargo[MODULO] === undefined && !(meuOverrides && meuOverrides[MODULO] !== undefined);
        level = semConfig ? (NIVEL_PADRAO[role] || 2) : getEffectiveLevel(doCargo, meuOverrides, MODULO);
      } catch (e) { level = NIVEL_PADRAO[role] || 2; }
    }
    if (level < 2) { window.location.href = '../../meu-espaco/index.html'; return; }
    if (!appInitialized || initializedRole !== role) {
      initializedRole = role;
      initApp(user, role);
    }
    if (!espacos.length) carregarTudo();
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
  montarSemestres();
  wireEventos();
}

function montarSemestres() {
  const agora = new Date();
  const atual = semestreDe(agora);
  const [a] = atual.split('.').map(Number);
  const lista = [`${a - 1}.2`, `${a}.1`, `${a}.2`, `${a + 1}.1`, `${a + 1}.2`];
  semestreSel = atual;
  document.getElementById('sel-semestre').innerHTML = lista.map(s => `<option value="${s}" ${s === atual ? 'selected' : ''}>Semestre ${s}</option>`).join('');
}

// Espaços + período inicial (semana atual — agenda pequena, busca só a semana).
async function carregarTudo() {
  try {
    await auth.authStateReady();
    if (auth.currentUser) currentUser = auth.currentUser;
    espacos = await apiFetch('/agenda-espacos/espacos');
    const opts = espacos.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
    document.getElementById('f-espaco').innerHTML = opts;
    document.getElementById('filtro-espaco').innerHTML = '<option value="">Todos os espaços</option>' + opts;
    await carregarPeriodo();
  } catch (err) {
    document.getElementById('agenda').innerHTML = `<div class="card"><div class="tabela-msg">Erro ao carregar: ${esc(err.message)}</div></div>`;
  }
}

function intervaloAtual() {
  if (visao === 'semana') { const i = inicioSemana(referencia); return [iso(i), iso(somaDias(i, 6))]; }
  if (visao === 'mes') {
    const primeiro = new Date(referencia.getFullYear(), referencia.getMonth(), 1, 12);
    const ini = inicioSemana(primeiro);
    const ultimo = new Date(referencia.getFullYear(), referencia.getMonth() + 1, 0, 12);
    const fim = somaDias(inicioSemana(ultimo), 6);
    return [iso(ini), iso(fim)];
  }
  return intervaloSemestre(semestreSel);
}

async function carregarPeriodo() {
  const [de, ate] = intervaloAtual();
  atualizarRotulo();
  document.getElementById('agenda').innerHTML = '<div class="card"><div class="tabela-msg">Carregando agenda...</div></div>';
  try {
    const r = await apiFetch(`/agenda-espacos?de=${de}&ate=${ate}`);
    reservas = r.reservas;
    ajustarPermissao(r.podeEditar);
    renderTudo();
    if (podeEditar) atualizarContadorPedidos();
  } catch (err) {
    document.getElementById('agenda').innerHTML = `<div class="card"><div class="tabela-msg">Erro ao carregar: ${esc(err.message)}</div></div>`;
  }
}

function ajustarPermissao(editor) {
  podeEditar = !!editor;
  document.getElementById('btn-novo-texto').textContent = podeEditar ? 'Nova reserva' : 'Solicitar reserva';
  document.getElementById('btn-espacos').classList.toggle('hidden', !podeEditar);
  document.getElementById('btn-pedidos').classList.toggle('hidden', !podeEditar);
  document.getElementById('kpi-pendentes-hint').textContent = podeEditar ? 'clique em "Pedidos" para aprovar' : 'aguardando a Secretaria';
  document.getElementById('subtitulo').textContent = podeEditar
    ? 'Auditório e salas — você pode criar, editar e aprovar pedidos'
    : 'Auditório e salas — consulte a disponibilidade e solicite uma reserva';
}

async function atualizarContadorPedidos() {
  try {
    const p = await apiFetch('/agenda-espacos/pendentes');
    document.getElementById('qtd-pedidos').textContent = p.length;
    return p;
  } catch (e) { return []; }
}

function atualizarRotulo() {
  const el = document.getElementById('rotulo-periodo');
  document.getElementById('nav-periodo').classList.toggle('hidden', visao === 'lista');
  document.getElementById('sel-semestre').classList.toggle('hidden', visao !== 'lista');
  if (visao === 'semana') {
    const i = inicioSemana(referencia), f = somaDias(i, 6);
    el.textContent = `${String(i.getDate()).padStart(2, '0')}/${String(i.getMonth() + 1).padStart(2, '0')} a ${String(f.getDate()).padStart(2, '0')}/${String(f.getMonth() + 1).padStart(2, '0')}/${f.getFullYear()}`;
  } else if (visao === 'mes') {
    el.textContent = `${MESES[referencia.getMonth()].charAt(0).toUpperCase() + MESES[referencia.getMonth()].slice(1)} de ${referencia.getFullYear()}`;
  }
}

// ---------- EVENTOS ----------
function wireEventos() {
  document.getElementById('f-responsavel').addEventListener('input', avisoCoordenador);
  document.getElementById('f-responsavel-coord').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nome]');
    if (!b) return;
    document.getElementById('f-responsavel').value = b.dataset.nome;
    avisoCoordenador();
  });
  document.querySelectorAll('#visoes button').forEach(b => b.addEventListener('click', () => {
    visao = b.dataset.visao;
    document.querySelectorAll('#visoes button').forEach(x => x.classList.toggle('ativa', x === b));
    carregarPeriodo();
  }));
  document.getElementById('btn-anterior').addEventListener('click', () => navegar(-1));
  document.getElementById('btn-proximo').addEventListener('click', () => navegar(1));
  document.getElementById('btn-hoje').addEventListener('click', () => { referencia = new Date(); carregarPeriodo(); });
  document.getElementById('sel-semestre').addEventListener('change', (e) => { semestreSel = e.target.value; carregarPeriodo(); });

  FILTROS.forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener(el.type === 'text' ? 'input' : 'change', renderTudo);
  });
  document.getElementById('espacos-bar').addEventListener('click', (e) => {
    const chip = e.target.closest('.curso-chip');
    if (!chip) return;
    document.getElementById('filtro-espaco').value = chip.dataset.espaco;
    renderTudo();
  });
  document.getElementById('btn-limpar-filtros').addEventListener('click', () => {
    FILTROS.forEach(id => { document.getElementById(id).value = ''; });
    renderTudo();
  });

  document.getElementById('agenda').addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (item) { abrirReserva(reservas.find(r => r.id === item.dataset.id)); return; }
    const dia = e.target.closest('[data-dia]');
    if (dia) abrirNova(dia.dataset.dia);
  });

  document.getElementById('btn-novo').addEventListener('click', () => abrirNova(null));
  document.getElementById('btn-cancelar-modal').addEventListener('click', () => fechar('modal-reserva'));
  document.getElementById('form-reserva').addEventListener('submit', salvar);
  ['f-espaco', 'f-data', 'f-inicio', 'f-fim'].forEach(id => document.getElementById(id).addEventListener('change', mostrarDisponibilidade));
  document.getElementById('f-repetir').addEventListener('change', () => {
    const r = document.getElementById('f-repetir').value;
    document.getElementById('grupo-ate').classList.toggle('hidden', !r);
    document.getElementById('grupo-fds').classList.toggle('hidden', r !== 'dia');
  });

  document.getElementById('f-tipo').addEventListener('change', atualizarGrupoExterno);
  document.getElementById('btn-fechar-resposta').addEventListener('click', () => fechar('modal-resposta'));
  ['resposta-texto', 'resposta-assunto'].forEach(id => document.getElementById(id).addEventListener('input', () => { if (reservaResposta) atualizarLinksResposta(reservaResposta); }));
  document.getElementById('btn-resposta-copiar').addEventListener('click', async () => {
    const t = document.getElementById('resposta-texto');
    try { await navigator.clipboard.writeText(t.value); } catch (e) { t.select(); document.execCommand('copy'); }
    showToast('Resposta copiada!');
  });

  // Responder pedido (aprovar/recusar)
  document.getElementById('decisao-confirmar').addEventListener('click', confirmarDecisao);
  document.getElementById('decisao-fechar').addEventListener('click', () => {
    fechar('modal-decisao');
    if (decisao && decisao.daPedidos) abrirPedidos();
  });
  document.getElementById('decisao-motivo').addEventListener('input', atualizarMensagemDecisao);
  document.getElementById('decisao-motivos').addEventListener('change', (e) => {
    if (e.target.name !== 'motivo-rapido') return;
    document.getElementById('decisao-motivo').value = MOTIVOS_RECUSA[Number(e.target.value)];
    atualizarMensagemDecisao();
  });
  document.getElementById('decisao-texto').addEventListener('input', atualizarLinksDecisao);
  document.getElementById('decisao-copiar').addEventListener('click', async () => {
    const t = document.getElementById('decisao-texto');
    try { await navigator.clipboard.writeText(t.value); } catch (e) { t.select(); document.execCommand('copy'); }
    showToast('Mensagem copiada!');
  });

  document.getElementById('btn-pedidos').addEventListener('click', abrirPedidos);
  document.getElementById('btn-fechar-pedidos').addEventListener('click', () => fechar('modal-pedidos'));
  document.getElementById('lista-pedidos').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-acao]');
    if (!b) return;
    if (b.dataset.acao === 'ver') { fechar('modal-pedidos'); abrirReservaPorId(b.dataset.id); }
    else { fechar('modal-pedidos'); abrirDecisao(pedidosCache.find(p => p.id === b.dataset.id), b.dataset.acao, true); }
  });

  document.getElementById('btn-espacos').addEventListener('click', () => {
    document.getElementById('f-espacos').value = espacos.join('\n');
    abrir('modal-espacos');
  });
  document.getElementById('btn-fechar-espacos').addEventListener('click', () => fechar('modal-espacos'));
  document.getElementById('form-espacos').addEventListener('submit', salvarEspacos);

  document.getElementById('btn-imprimir').addEventListener('click', () => imprimirRelatorio([
    visao === 'lista' ? `Semestre ${semestreSel}` : document.getElementById('rotulo-periodo').textContent,
    opcaoEscolhida('filtro-espaco') && `Espaço: ${opcaoEscolhida('filtro-espaco')}`,
    opcaoEscolhida('filtro-tipo'),
    opcaoEscolhida('filtro-status'),
    document.getElementById('busca').value.trim() && `Busca: "${document.getElementById('busca').value.trim()}"`
  ], currentUserNome || currentUser.email));
}

function navegar(passo) {
  if (visao === 'semana') referencia = somaDias(referencia, 7 * passo);
  else referencia = new Date(referencia.getFullYear(), referencia.getMonth() + passo, 1, 12);
  carregarPeriodo();
}

// ---------- FILTROS ----------
function lerFiltros() {
  return {
    busca: document.getElementById('busca').value.trim().toLowerCase(),
    espaco: document.getElementById('filtro-espaco').value,
    tipo: document.getElementById('filtro-tipo').value,
    status: document.getElementById('filtro-status').value
  };
}

function passa(r, f, ignorar = '') {
  if (f.status === 'meus') { if (!r.pedidoPor || r.pedidoPor.uid !== currentUser.uid) return false; }
  else if (f.status) { if (r.status !== f.status) return false; }
  else if (!['confirmada', 'pendente'].includes(r.status)) return false;
  if (ignorar !== 'espaco' && f.espaco && r.espaco !== f.espaco && r.espaco !== TODAS) return false;
  if (f.tipo && r.tipo !== f.tipo) return false;
  if (f.busca && !`${r.evento} ${r.responsavel} ${r.setor} ${r.observacoes} ${r.espaco}`.toLowerCase().includes(f.busca)) return false;
  return true;
}

function renderTudo() {
  const f = lerFiltros();
  const lista = reservas.filter(r => passa(r, f));
  const [de, ate] = intervaloAtual();
  const noPeriodo = (r) => visao !== 'mes' || (r.data >= iso(new Date(referencia.getFullYear(), referencia.getMonth(), 1, 12)) && r.data <= iso(new Date(referencia.getFullYear(), referencia.getMonth() + 1, 0, 12)));
  const doPeriodo = lista.filter(noPeriodo);
  const confirmadas = doPeriodo.filter(r => r.status === 'confirmada');
  document.getElementById('kpi-total').textContent = confirmadas.length;
  const ext = confirmadas.filter(r => r.tipo === 'externo').length;
  document.getElementById('kpi-externos').textContent = `${confirmadas.length - ext} internos · ${ext} externos`;
  document.getElementById('kpi-auditorio').textContent = new Set(confirmadas.filter(r => r.espaco === 'Auditório').map(r => r.data)).size;
  document.getElementById('kpi-pendentes').textContent = reservas.filter(r => r.status === 'pendente' && noPeriodo(r)).length;
  const deHoje = reservas.filter(r => r.data === hoje() && r.status === 'confirmada');
  document.getElementById('kpi-hoje').textContent = deHoje.length;
  document.getElementById('kpi-hoje-hint').textContent = deHoje.length ? deHoje.slice(0, 2).map(r => `${r.inicio} ${r.espaco}`).join(' · ') : 'nada reservado hoje';

  // Botões por espaço (com quantidade no período, respeitando os outros filtros)
  const semEspaco = reservas.filter(r => passa(r, f, 'espaco') && noPeriodo(r));
  const porEspaco = {};
  semEspaco.forEach(r => { porEspaco[r.espaco] = (porEspaco[r.espaco] || 0) + 1; });
  const chip = (v, rot, n) => `<button type="button" class="curso-chip ${f.espaco === v ? 'ativo' : ''}" data-espaco="${esc(v)}">${esc(rot)} <span class="curso-chip-qtd">${n}</span></button>`;
  document.getElementById('espacos-bar').innerHTML = chip('', 'Todos os espaços', semEspaco.length) +
    Object.entries(porEspaco).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([e, n]) => chip(e, e, n)).join('');

  const filtrando = Object.values(f).some(Boolean);
  document.getElementById('btn-limpar-filtros').classList.toggle('hidden', !filtrando);
  document.getElementById('filtro-resumo').innerHTML = filtrando ? `Mostrando <strong>${doPeriodo.length}</strong> de ${reservas.filter(noPeriodo).length} reservas do período` : '';

  document.getElementById('lista-responsaveis').innerHTML = [...new Set(reservas.map(r => r.responsavel).filter(Boolean))].sort().map(v => `<option value="${esc(v)}">`).join('');
  document.getElementById('lista-limpeza').innerHTML = [...new Set(['Fatec', ...reservas.map(r => r.limpeza).filter(Boolean)])].map(v => `<option value="${esc(v)}">`).join('');

  if (visao === 'semana') renderSemana(lista, de);
  else if (visao === 'mes') renderMes(lista, de, ate);
  else renderLista(lista);
}

function tagsDe(r) {
  return (r.status === 'pendente' ? '<span class="ae-tag pend">PEDIDO</span>' : '')
    + (r.status === 'recusada' ? '<span class="ae-tag rec">RECUSADO</span>' : '')
    + (r.status === 'cancelada' ? '<span class="ae-tag rec">CANCELADO</span>' : '')
    + (r.tipo === 'externo' ? '<span class="ae-tag ext">EXTERNO</span>' : '');
}

function renderSemana(lista, de) {
  const ini = dataLocal(de);
  const cols = [];
  for (let i = 0; i < 7; i++) {
    const d = somaDias(ini, i), k = iso(d);
    const doDia = lista.filter(r => r.data === k).sort((a, b) => a.inicio.localeCompare(b.inicio));
    cols.push(`
      <div class="ae-dia ${k === hoje() ? 'hoje' : ''} ${d.getDay() % 6 === 0 ? 'fds' : ''}">
        <div class="ae-dia-topo"><strong>${DIAS_LONGOS[d.getDay()]}</strong><span>${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}</span></div>
        <div class="ae-dia-corpo" data-dia="${k}" title="Clique num espaço vazio para ${podeEditar ? 'reservar' : 'solicitar'} neste dia">
          ${doDia.length ? doDia.map(r => `
            <div class="ae-item ${r.status}" data-id="${r.id}" style="${estiloCor(r.espaco)}">
              <div class="ae-item-hora">${r.inicio} – ${r.fim}${tagsDe(r)}</div>
              <div class="ae-item-evento">${esc(r.evento)}</div>
              <div class="ae-item-espaco">📍 ${esc(r.espaco)}</div>
              ${r.responsavel ? `<div class="ae-item-resp">${esc(r.responsavel)}</div>` : ''}
            </div>`).join('') : '<div class="ae-vazio">livre</div>'}
        </div>
      </div>`);
  }
  document.getElementById('agenda').innerHTML = `<div class="ae-semana">${cols.join('')}</div>`;
}

function renderMes(lista, de, ate) {
  const mesAtual = referencia.getMonth();
  const cels = [];
  for (let d = dataLocal(de); iso(d) <= ate; d = somaDias(d, 1)) {
    const k = iso(d);
    const doDia = lista.filter(r => r.data === k).sort((a, b) => a.inicio.localeCompare(b.inicio));
    cels.push(`
      <div class="ae-cel ${d.getMonth() !== mesAtual ? 'fora' : ''} ${k === hoje() ? 'hoje' : ''}" data-dia="${k}">
        <div class="ae-cel-dia">${d.getDate()}</div>
        ${doDia.slice(0, 3).map(r => `<span class="ae-chip ${r.status}" data-id="${r.id}" style="${estiloCor(r.espaco)}" title="${esc(`${r.inicio}–${r.fim} · ${r.espaco} · ${r.evento}`)}">${r.inicio} ${esc(r.espaco)} · ${esc(r.evento)}</span>`).join('')}
        ${doDia.length > 3 ? `<span class="ae-mais">+${doDia.length - 3} mais</span>` : ''}
      </div>`);
  }
  document.getElementById('agenda').innerHTML = `
    <div class="ae-mes">
      <div class="ae-mes-cab">${['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map(d => `<div>${d}</div>`).join('')}</div>
      <div class="ae-mes-grade">${cels.join('')}</div>
    </div>`;
}

function renderLista(lista) {
  if (!lista.length) {
    document.getElementById('agenda').innerHTML = '<div class="card"><div class="tabela-msg">Nenhuma reserva nesse semestre com esses filtros.</div></div>';
    return;
  }
  const porMes = {};
  lista.forEach(r => { (porMes[r.data.slice(0, 7)] = porMes[r.data.slice(0, 7)] || []).push(r); });
  const linhas = Object.keys(porMes).sort().map(k => {
    const [a, m] = k.split('-');
    return `<tr class="mes-linha"><td colspan="6">Mês de ${MESES[Number(m) - 1]} ${a}<span class="mes-qtd">${porMes[k].length} reserva(s)</span></td></tr>` +
      porMes[k].map(r => `
        <tr data-id="${r.id}" style="cursor:pointer">
          <td><div class="ae-dia-lista"><strong>${fmtData(r.data).slice(0, 5)}</strong> <span class="ct-sub">${DIAS_CURTOS[dataLocal(r.data).getDay()]}</span></div><div class="ct-sub">${r.inicio} – ${r.fim}</div></td>
          <td><span class="ae-item-espaco" style="${estiloCor(r.espaco)}">● ${esc(r.espaco)}</span></td>
          <td><strong>${esc(r.evento)}</strong>${tagsDe(r)}${r.observacoes ? `<div class="ct-sub">📝 ${esc(r.observacoes.slice(0, 60))}</div>` : ''}</td>
          <td>${esc(r.responsavel) || '<span class="ct-vazio">—</span>'}${r.setor ? `<div class="ct-sub">${esc(r.setor)}</div>` : ''}</td>
          <td>${r.pessoas ?? '<span class="ct-vazio">—</span>'}</td>
          <td>${esc(r.limpeza) || '<span class="ct-vazio">—</span>'}</td>
        </tr>`).join('');
  }).join('');
  document.getElementById('agenda').innerHTML = `
    <div class="card"><div class="tabela-wrap"><table class="data-table">
      <thead><tr><th>Data</th><th>Espaço</th><th>Evento</th><th>Responsável</th><th>Pessoas</th><th>Limpeza</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table></div></div>`;
}

// ---------- COORDENADOR NA AGENDA ----------
// Mesma regra do servidor (agenda-espacos.js > acharCoordenador): reserva de
// coordenador vai pra agenda do Meu Espaço dele. Aqui só avisa na tela.
const IGNORAR_NOME = new Set(['prof', 'profa', 'professor', 'professora', 'coord', 'coordenador', 'coordenadora',
  'coordenacao', 'dr', 'dra', 'de', 'da', 'do', 'das', 'dos', 'e', 'curso']);
function tokensNome(nome) {
  return (nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !IGNORAR_NOME.has(t));
}
function acharCoordenador(texto) {
  const t = tokensNome(texto);
  if (!t.length || !coordenadores) return null;
  const c = coordenadores.filter(x => {
    const n = tokensNome(x.nome);
    if (!n.length) return false;
    return t.join(' ') === n.join(' ') || (t.length >= 2 && t.every(y => n.includes(y))) || (n.length >= 2 && n.every(y => t.includes(y)));
  });
  return c.length === 1 ? c[0] : null;
}
async function carregarCoordenadores() {
  if (coordenadores || !podeEditar) return;
  try { coordenadores = await apiFetch('/agenda-espacos/coordenadores'); } catch (e) { coordenadores = []; }
  const lista = document.getElementById('lista-responsaveis');
  const ja = new Set([...lista.options].map(o => o.value));
  lista.insertAdjacentHTML('afterbegin', coordenadores.filter(c => !ja.has(c.nome)).map(c => `<option value="${esc(c.nome)}">Coordenador(a)</option>`).join(''));
  avisoCoordenador();
}
// Secretaria costuma digitar só o primeiro nome ("Vanessa") — não dá pra
// garantir que é a coordenadora (tem Vanessa em outro setor). Se o primeiro
// nome bate com UM coordenador, pergunta; o clique completa o nome.
function sugestaoCoordenador(texto) {
  const t = tokensNome(texto);
  if (t.length !== 1 || !coordenadores) return null;
  const c = coordenadores.filter(x => tokensNome(x.nome)[0] === t[0]);
  return c.length === 1 ? c[0] : null;
}
function avisoCoordenador() {
  const el = document.getElementById('f-responsavel-coord');
  if (!podeEditar) {
    // coordenador pedindo pra si: o servidor reconhece pelo login
    el.innerHTML = '';
    return;
  }
  const texto = document.getElementById('f-responsavel').value;
  const c = acharCoordenador(texto);
  if (c) { el.innerHTML = `📅 Coordenador(a) — vai para a agenda do Meu Espaço de <b>${esc(c.nome)}</b>.`; return; }
  const s = sugestaoCoordenador(texto);
  el.innerHTML = s
    ? `É o(a) coordenador(a) <b>${esc(s.nome)}</b>? <button type="button" class="btn-secondary ae-btn-coord" data-nome="${esc(s.nome)}">Sim, usar</button> <span>(aí vai para a agenda dele(a))</span>`
    : '';
}

// ---------- FORMULÁRIO ----------
function abrir(id) { document.getElementById(id).classList.remove('hidden'); }
function fechar(id) { document.getElementById(id).classList.add('hidden'); }

function preencher(r) {
  const set = (id, v) => { document.getElementById(id).value = v ?? ''; };
  set('f-evento', r?.evento); set('f-espaco', r?.espaco || espacos[0]); set('f-data', r?.data);
  set('f-inicio', r?.inicio); set('f-fim', r?.fim); set('f-tipo', r?.tipo || 'interno');
  set('f-responsavel', r ? r.responsavel : currentUserNome); set('f-setor', r?.setor); set('f-pessoas', r?.pessoas);
  set('f-limpeza', r ? r.limpeza : 'Fatec'); set('f-equipamentos', r?.equipamentos); set('f-obs', r?.observacoes);
  set('f-oficio', r?.oficio); set('f-contato-externo', r?.contatoExterno);
  atualizarGrupoExterno();
  set('f-repetir', ''); set('f-ate', '');
  document.getElementById('grupo-ate').classList.add('hidden');
  document.getElementById('grupo-fds').classList.add('hidden');
  document.getElementById('erro-reserva').classList.add('hidden');
  avisoCoordenador();
  carregarCoordenadores();
}

function atualizarGrupoExterno() {
  document.getElementById('grupo-externo').classList.toggle('hidden', document.getElementById('f-tipo').value !== 'externo');
}

// ---------- RESPOSTA AO OFÍCIO (órgão externo) ----------
function artigoDo(espaco) {
  return /^(Sala|Tutoria)/i.test(espaco) ? 'da' : 'do';
}
function fmtHora(h) { return h.replace(':', 'h'); }

function montarResposta(r) {
  // Mesmo pedido em várias datas (grupoId) sai numa resposta só.
  const doGrupo = r.grupoId ? reservas.filter(x => x.grupoId === r.grupoId && x.status === 'confirmada') : [];
  const itens = (doGrupo.length ? doGrupo : [r]).sort((a, b) => a.data.localeCompare(b.data) || a.inicio.localeCompare(b.inicio));
  const h = new Date().getHours();
  const saudacao = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const varias = new Set(itens.map(i => i.data)).size > 1;
  const inicio = r.oficio ? `Em resposta ao ofício Nº ${r.oficio}` : 'Em resposta à sua solicitação';
  const datas = itens.map(i => `${fmtData(i.data)} (${DIAS_LONGOS[dataLocal(i.data).getDay()]}): ${fmtHora(i.inicio)} às ${fmtHora(i.fim)}`);
  const texto = [
    `${saudacao},`,
    '',
    `${inicio}, foi autorizado pela direção a utilização ${artigoDo(r.espaco)} ${r.espaco} ${varias ? 'nas datas solicitadas' : 'na data solicitada'}${r.evento ? ` para o evento "${r.evento}"` : ''}, só pedimos a atenção às observações abaixo:`,
    '',
    ...OBSERVACOES_OFICIO.map(o => `• ${o}`),
    '',
    varias ? 'Datas e horários:' : 'Data e horário:',
    ...datas,
    '',
    'Atenciosamente,',
    'Secretaria — Fatec Ivaiporã'
  ].join('\n');
  document.getElementById('resposta-assunto').value = `Resposta ${r.oficio ? `ao ofício Nº ${r.oficio}` : 'à solicitação'} — uso ${artigoDo(r.espaco)} ${r.espaco}`;
  document.getElementById('resposta-texto').value = texto;
  document.getElementById('resposta-sub').textContent = `${r.setor || 'Órgão externo'}${r.contatoExterno ? ' · ' + r.contatoExterno : ''} — modelo já preenchido, dá pra ajustar antes de enviar.`;
  atualizarLinksResposta(r);
  abrir('modal-resposta');
}

function atualizarLinksResposta(r) {
  const txt = document.getElementById('resposta-texto').value;
  const assunto = document.getElementById('resposta-assunto').value;
  const contato = (r.contatoExterno || '').trim();
  const dig = contato.replace(/\D/g, '');
  // WhatsApp: no computador abre o WhatsApp Web direto no navegador (o wa.me
  // perguntava se queria abrir o aplicativo); no celular, o app.
  const celular = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const numero = dig.length >= 10 && !contato.includes('@') ? (dig.length <= 11 ? '55' + dig : dig) : '';
  const zap = document.getElementById('btn-resposta-zap');
  zap.href = celular
    ? `https://wa.me/${numero}?text=${encodeURIComponent(txt)}`
    : `https://web.whatsapp.com/send?${numero ? `phone=${numero}&` : ''}text=${encodeURIComponent(txt)}`;
  // E-mail: a Fatec usa Gmail (Google Workspace) — abre a tela de escrever do
  // Gmail já preenchida. O mailto: não fazia nada sem programa de e-mail no PC.
  const email = contato.includes('@') ? contato : '';
  document.getElementById('btn-resposta-email').href =
    `https://mail.google.com/mail/?view=cm&fs=1${email ? `&to=${encodeURIComponent(email)}` : ''}&su=${encodeURIComponent(assunto)}&body=${encodeURIComponent(txt)}`;
}

let reservaResposta = null;

// ---------- RESPONDER PEDIDO (aprovar / recusar) com mensagem padrão ----------
const MOTIVOS_RECUSA = [
  'O espaço já está reservado nesse horário',
  'Data indisponível',
  'Capacidade do espaço insuficiente para o público',
  'Evento da instituição no mesmo dia'
];
let decisao = null; // { r, acao, daPedidos, feita }

function primeiroNomeDe(nome) {
  const p = (nome || '').trim().split(/\s+/)[0] || '';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

function dadosDoPedido(r) {
  return [
    `📌 Evento: ${r.evento}`,
    `📍 Espaço: ${r.espaco}`,
    `📅 Data: ${DIAS_LONGOS[dataLocal(r.data).getDay()]}, ${fmtData(r.data)}`,
    `⏰ Horário: ${r.inicio} às ${r.fim}`
  ];
}

function mensagemPadrao(r, acao, motivo) {
  const nome = primeiroNomeDe(r.pedidoPor ? r.pedidoPor.nome : r.responsavel);
  if (acao === 'confirmada') {
    return [
      `Olá${nome ? `, ${nome}` : ''}! Tudo bem? 😊`,
      '',
      'Seu pedido de reserva foi *APROVADO* ✅',
      '',
      ...dadosDoPedido(r),
      '',
      'A reserva já está confirmada na Agenda Interna Fatec IVP (Órbita).',
      'Pedimos que respeite os horários de entrada e saída e deixe o espaço organizado após o uso.',
      '',
      'Qualquer dúvida, é só falar com a Secretaria.',
      'Secretaria — Fatec Ivaiporã'
    ].join('\n');
  }
  return [
    `Olá${nome ? `, ${nome}` : ''}, tudo bem?`,
    '',
    'Infelizmente não foi possível atender o seu pedido de reserva:',
    '',
    ...dadosDoPedido(r),
    '',
    `Motivo: ${motivo || '(informe o motivo)'}`,
    '',
    'Se quiser, consulte os horários e espaços livres na Agenda Interna Fatec IVP (Órbita) e faça um novo pedido.',
    '',
    'Secretaria — Fatec Ivaiporã'
  ].join('\n');
}

function abrirDecisao(r, acao, daPedidos = false) {
  if (!r) return;
  decisao = { r, acao, daPedidos, feita: false };
  const recusa = acao === 'recusada';
  const modal = document.getElementById('modal-decisao');
  modal.classList.toggle('recusa', recusa);
  modal.classList.toggle('aceite', !recusa);
  document.getElementById('decisao-titulo').textContent = recusa ? '✕ Recusar pedido' : '✓ Aprovar pedido';
  document.getElementById('decisao-resumo').innerHTML = `
    <strong>${esc(r.evento)}</strong>${r.tipo === 'externo' ? ' <span class="ae-tag ext">EXTERNO</span>' : ''}<br>
    📍 ${esc(r.espaco)} · 📅 ${DIAS_LONGOS[dataLocal(r.data).getDay()]}, ${fmtData(r.data)} · ⏰ ${r.inicio} às ${r.fim}<br>
    Pedido por <strong style="font-size:inherit">${esc(r.pedidoPor ? r.pedidoPor.nome : '—')}</strong>${r.pedidoPor && r.pedidoPor.email ? ` · ${esc(r.pedidoPor.email)}` : ''}${r.pessoas ? ` · ${r.pessoas} pessoas` : ''}`;
  document.getElementById('decisao-motivo-box').classList.toggle('hidden', !recusa);
  document.getElementById('decisao-motivo').value = '';
  document.getElementById('decisao-motivos').innerHTML = MOTIVOS_RECUSA.map((m, i) =>
    `<label class="equipe-chip"><input type="radio" name="motivo-rapido" value="${i}">${esc(m)}</label>`).join('');
  document.getElementById('decisao-texto').value = mensagemPadrao(r, acao, '');
  document.getElementById('decisao-erro').classList.add('hidden');
  document.getElementById('decisao-ok').classList.add('hidden');
  document.getElementById('decisao-envio').classList.add('bloqueado');
  const btn = document.getElementById('decisao-confirmar');
  btn.classList.remove('hidden');
  btn.disabled = false;
  btn.textContent = recusa ? 'Confirmar recusa' : 'Confirmar aprovação';
  atualizarLinksDecisao();
  abrir('modal-decisao');
}

function atualizarMensagemDecisao() {
  if (!decisao || decisao.acao !== 'recusada') return;
  document.getElementById('decisao-texto').value = mensagemPadrao(decisao.r, 'recusada', document.getElementById('decisao-motivo').value.trim());
  atualizarLinksDecisao();
}

function atualizarLinksDecisao() {
  if (!decisao) return;
  const r = decisao.r;
  const txt = document.getElementById('decisao-texto').value;
  const assunto = `${decisao.acao === 'recusada' ? 'Pedido de reserva não aprovado' : 'Pedido de reserva aprovado'} — ${r.espaco} ${fmtData(r.data)}`;
  const celular = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  document.getElementById('decisao-zap').href = celular
    ? `https://wa.me/?text=${encodeURIComponent(txt)}`
    : `https://web.whatsapp.com/send?text=${encodeURIComponent(txt)}`;
  const email = r.pedidoPor && r.pedidoPor.email ? r.pedidoPor.email : '';
  document.getElementById('decisao-gmail').href =
    `https://mail.google.com/mail/?view=cm&fs=1${email ? `&to=${encodeURIComponent(email)}` : ''}&su=${encodeURIComponent(assunto)}&body=${encodeURIComponent(txt)}`;
}

async function confirmarDecisao() {
  if (!decisao || decisao.feita) return;
  const { r, acao } = decisao;
  const motivo = document.getElementById('decisao-motivo').value.trim();
  const erro = document.getElementById('decisao-erro');
  erro.classList.add('hidden');
  if (acao === 'recusada' && !motivo) {
    erro.textContent = 'Escolha ou escreva o motivo da recusa.';
    erro.classList.remove('hidden');
    return;
  }
  const btn = document.getElementById('decisao-confirmar');
  btn.disabled = true;
  try {
    await apiFetch(`/agenda-espacos/${r.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: acao, motivo }) });
    decisao.feita = true;
    btn.classList.add('hidden');
    const ok = document.getElementById('decisao-ok');
    ok.textContent = acao === 'recusada'
      ? '✓ Pedido recusado. Agora é só enviar a mensagem para quem pediu:'
      : '✓ Reserva confirmada na agenda. Agora é só enviar a mensagem para quem pediu:';
    ok.classList.remove('hidden');
    document.getElementById('decisao-envio').classList.remove('bloqueado');
    Object.keys(cacheDia).forEach(k => delete cacheDia[k]);
    fechar('modal-reserva');
    await carregarPeriodo();
  } catch (err) {
    erro.textContent = err.message + (err.conflitos && err.conflitos.length ? '\n' + err.conflitos.map(c => '• ' + c).join('\n') : '');
    erro.classList.remove('hidden');
    btn.disabled = false;
  }
}

let pedidosCache = [];

function abrirNova(dia) {
  emEdicao = null;
  preencher(null);
  if (dia) document.getElementById('f-data').value = dia;
  const espacoFiltro = document.getElementById('filtro-espaco').value;
  if (espacoFiltro) document.getElementById('f-espaco').value = espacoFiltro;
  document.getElementById('modal-titulo').textContent = podeEditar ? 'Nova reserva' : 'Solicitar reserva';
  document.getElementById('modal-info').textContent = podeEditar ? '' : 'Seu pedido fica "pendente" na agenda até a Secretaria aprovar ou recusar. Acompanhe em "Meus pedidos".';
  document.getElementById('grupo-repetir').classList.remove('hidden');
  document.getElementById('acoes-esq').innerHTML = '';
  document.getElementById('btn-salvar').classList.remove('hidden');
  document.getElementById('btn-salvar').textContent = podeEditar ? 'Salvar reserva' : 'Enviar pedido';
  document.getElementById('form-reserva').classList.remove('ae-leitura');
  abrir('modal-reserva');
  mostrarDisponibilidade();
  document.getElementById('f-evento').focus();
}

async function abrirReservaPorId(id) {
  let r = reservas.find(x => x.id === id);
  if (!r) { const p = await atualizarContadorPedidos(); r = p.find(x => x.id === id); }
  if (r) abrirReserva(r);
}

function abrirReserva(r) {
  if (!r) return;
  emEdicao = r;
  preencher(r);
  const meuPedido = r.pedidoPor && r.pedidoPor.uid === currentUser.uid;
  const status = { confirmada: 'Confirmada', pendente: 'Pedido pendente', recusada: 'Recusada', cancelada: 'Cancelada' }[r.status];
  document.getElementById('modal-titulo').textContent = podeEditar ? 'Reserva' : 'Detalhes da reserva';
  document.getElementById('modal-info').innerHTML = [
    `<strong>${status}</strong>`,
    r.pedidoPor ? `pedido por ${esc(r.pedidoPor.nome)}` : '',
    r.aprovadoPor ? `aprovado por ${esc(r.aprovadoPor)}` : '',
    r.status === 'recusada' && r.motivoRecusa ? `motivo: ${esc(r.motivoRecusa)}` : '',
    `última alteração: ${esc(r.updatedBy)} em ${new Date(r.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
  ].filter(Boolean).join(' · ');
  document.getElementById('grupo-repetir').classList.add('hidden');
  const acoes = [];
  if (podeEditar) {
    if (r.status === 'pendente') acoes.push('<button type="button" class="aprovar" data-st="confirmada">✓ Aprovar</button>', '<button type="button" class="recusar" data-st="recusada">Recusar</button>');
    if (r.status === 'confirmada' && r.tipo === 'externo') acoes.push('<button type="button" class="resposta" data-st="resposta">✉️ Resposta ao ofício</button>');
    if (r.status === 'confirmada') acoes.push('<button type="button" class="recusar" data-st="cancelada">Cancelar reserva</button>');
    if (['recusada', 'cancelada'].includes(r.status)) acoes.push('<button type="button" data-st="confirmada">Reativar</button>');
    acoes.push('<button type="button" class="excluir" data-st="excluir" title="Apaga de vez">🗑</button>');
  } else if (meuPedido && r.status === 'pendente') {
    acoes.push('<button type="button" class="recusar" data-st="cancelar-pedido">Cancelar meu pedido</button>');
  }
  const box = document.getElementById('acoes-esq');
  box.innerHTML = acoes.join('');
  box.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      if (b.dataset.st === 'resposta') { reservaResposta = r; montarResposta(r); return; }
      if (r.status === 'pendente' && ['confirmada', 'recusada'].includes(b.dataset.st)) { abrirDecisao(r, b.dataset.st); return; }
      mudarStatus(r.id, b.dataset.st);
    };
  });
  document.getElementById('btn-salvar').classList.toggle('hidden', !podeEditar);
  document.getElementById('btn-salvar').textContent = 'Salvar alterações';
  document.getElementById('form-reserva').classList.toggle('ae-leitura', !podeEditar);
  abrir('modal-reserva');
  mostrarDisponibilidade();
}

function gerarDatas() {
  const data = document.getElementById('f-data').value;
  const rep = document.getElementById('f-repetir').value;
  const ate = document.getElementById('f-ate').value;
  if (!data) return [];
  if (!rep || !ate || ate <= data) return [data];
  const fds = document.getElementById('f-fds').checked;
  const datas = [];
  for (let d = dataLocal(data); iso(d) <= ate && datas.length < 120; d = somaDias(d, rep === 'semana' ? 7 : 1)) {
    if (rep === 'dia' && !fds && d.getDay() % 6 === 0) continue;
    datas.push(iso(d));
  }
  return datas;
}

async function mostrarDisponibilidade() {
  const box = document.getElementById('disponibilidade');
  const espaco = document.getElementById('f-espaco').value;
  const data = document.getElementById('f-data').value;
  const ini = document.getElementById('f-inicio').value;
  const fim = document.getElementById('f-fim').value;
  if (!espaco || !data) { box.innerHTML = ''; return; }
  if (!cacheDia[data]) {
    try { cacheDia[data] = await apiFetch(`/agenda-espacos/dia/${data}`); } catch (e) { box.innerHTML = ''; return; }
  }
  const doEspaco = cacheDia[data].filter(r => (r.espaco === espaco || r.espaco === TODAS || espaco === TODAS) && (!emEdicao || r.id !== emEdicao.id))
    .sort((a, b) => a.inicio.localeCompare(b.inicio));
  const dia = `${DIAS_LONGOS[dataLocal(data).getDay()]}, ${fmtData(data)}`;
  if (!doEspaco.length) { box.innerHTML = `<div class="ae-disp-box livre">✓ ${esc(espaco)} está livre o dia todo (${dia}).</div>`; return; }
  const choca = ini && fim && doEspaco.some(r => r.status === 'confirmada' && r.inicio < fim && ini < r.fim);
  box.innerHTML = `<div class="ae-disp-box ${choca ? 'ocupado' : ''}">
    ${choca ? '⚠️ Esse horário já está ocupado.' : 'Já marcado nesse espaço'} (${dia}):
    <ul>${doEspaco.map(r => `<li><strong>${r.inicio}–${r.fim}</strong> · ${esc(r.evento)}${r.espaco !== espaco ? ` (${esc(r.espaco)})` : ''}${r.status === 'pendente' ? ' — <em>pedido pendente</em>' : ''}</li>`).join('')}</ul>
  </div>`;
}

async function salvar(e) {
  e.preventDefault();
  const v = (id) => document.getElementById(id).value;
  const body = {
    evento: v('f-evento'), espaco: v('f-espaco'), inicio: v('f-inicio'), fim: v('f-fim'), tipo: v('f-tipo'),
    responsavel: v('f-responsavel'), setor: v('f-setor'), pessoas: v('f-pessoas'), limpeza: v('f-limpeza'),
    equipamentos: v('f-equipamentos'), observacoes: v('f-obs'),
    oficio: v('f-oficio'), contatoExterno: v('f-contato-externo')
  };
  const erroBox = document.getElementById('erro-reserva');
  erroBox.classList.add('hidden');
  const btn = document.getElementById('btn-salvar');
  btn.disabled = true;
  try {
    if (emEdicao) {
      const r = await apiFetch(`/agenda-espacos/${emEdicao.id}`, { method: 'PUT', body: JSON.stringify({ ...body, data: v('f-data') }) });
      showToast(`Reserva atualizada.${r.coordenador ? ` Está na agenda de ${r.coordenador}.` : ''}`);
    } else {
      const datas = gerarDatas();
      const r = await apiFetch(podeEditar ? '/agenda-espacos' : '/agenda-espacos/pedidos', { method: 'POST', body: JSON.stringify({ ...body, datas }) });
      showToast((podeEditar
        ? `Reserva salva${r.criadas.length > 1 ? ` (${r.criadas.length} datas)` : ''}.`
        : 'Pedido enviado! A Secretaria vai aprovar ou recusar.') + (r.coordenador ? ` Já está na agenda de ${r.coordenador}.` : ''));
      if (r.avisos && r.avisos.length) showToast(`Atenção: há pedido pendente no mesmo horário (${r.avisos.length}).`, 'error');
    }
    Object.keys(cacheDia).forEach(k => delete cacheDia[k]);
    fechar('modal-reserva');
    await carregarPeriodo();
  } catch (err) {
    erroBox.textContent = err.message + (err.conflitos && err.conflitos.length ? '\n' + err.conflitos.map(c => '• ' + c).join('\n') : '');
    erroBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function mudarStatus(id, acao, daJanelaPedidos = false) {
  try {
    if (acao === 'excluir') {
      if (!confirm('Excluir esta reserva de vez? (Para só desmarcar, use "Cancelar reserva".)')) return;
      await apiFetch(`/agenda-espacos/${id}`, { method: 'DELETE' });
      showToast('Reserva excluída.');
    } else if (acao === 'cancelar-pedido') {
      if (!confirm('Cancelar o seu pedido?')) return;
      await apiFetch(`/agenda-espacos/pedidos/${id}`, { method: 'DELETE' });
      showToast('Pedido cancelado.');
    } else {
      let motivo = '';
      if (acao === 'recusada') {
        motivo = prompt('Motivo da recusa (aparece pra quem pediu):', '') ?? null;
        if (motivo === null) return;
      }
      if (acao === 'cancelada' && !confirm('Cancelar esta reserva? Ela deixa de ocupar o espaço.')) return;
      await apiFetch(`/agenda-espacos/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: acao, motivo }) });
      showToast({ confirmada: 'Reserva confirmada.', recusada: 'Pedido recusado.', cancelada: 'Reserva cancelada.' }[acao]);
    }
    Object.keys(cacheDia).forEach(k => delete cacheDia[k]);
    fechar('modal-reserva');
    await carregarPeriodo();
    if (daJanelaPedidos) abrirPedidos();
  } catch (err) {
    showToast(err.message + (err.conflitos && err.conflitos.length ? ' — ' + err.conflitos[0] : ''), 'error');
  }
}

async function abrirPedidos() {
  const box = document.getElementById('lista-pedidos');
  box.innerHTML = '<div class="tabela-msg">Carregando...</div>';
  abrir('modal-pedidos');
  const pedidos = await atualizarContadorPedidos();
  pedidosCache = pedidos;
  box.innerHTML = pedidos.length ? pedidos.map(p => `
    <div class="ae-lista-pedido">
      <div>
        <strong>${esc(p.evento)}</strong>${p.tipo === 'externo' ? '<span class="ae-tag ext">EXTERNO</span>' : ''}
        <div class="ct-sub">📅 ${DIAS_LONGOS[dataLocal(p.data).getDay()]}, ${fmtData(p.data)} · ${p.inicio}–${p.fim} · 📍 ${esc(p.espaco)}</div>
        <div class="ct-sub">Pedido por ${esc(p.pedidoPor ? p.pedidoPor.nome : '—')}${p.responsavel ? ` · responsável: ${esc(p.responsavel)}` : ''}${p.pessoas ? ` · ${p.pessoas} pessoas` : ''}</div>
      </div>
      <div class="ae-acoes-esq">
        <button type="button" data-acao="ver" data-id="${p.id}">Ver</button>
        <button type="button" class="aprovar" data-acao="confirmada" data-id="${p.id}">✓ Aprovar</button>
        <button type="button" class="recusar" data-acao="recusada" data-id="${p.id}">Recusar</button>
      </div>
    </div>`).join('') : '<div class="tabela-msg">Nenhum pedido aguardando. 🎉</div>';
}

async function salvarEspacos(e) {
  e.preventDefault();
  const lista = document.getElementById('f-espacos').value.split('\n').map(s => s.trim()).filter(Boolean);
  try {
    espacos = await apiFetch('/agenda-espacos/espacos', { method: 'PUT', body: JSON.stringify({ espacos: lista }) });
    const opts = espacos.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    document.getElementById('f-espaco').innerHTML = opts;
    document.getElementById('filtro-espaco').innerHTML = '<option value="">Todos os espaços</option>' + opts;
    fechar('modal-espacos');
    showToast('Espaços salvos.');
    renderTudo();
  } catch (err) { showToast(err.message, 'error'); }
}
