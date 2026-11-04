import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';
import { getEffectiveLevel } from '../../core/permissions.js';
import { criarOficio, oficioNaLinha, opcaoEscolhida, imprimirRelatorio, avatar } from '../comercial-comum.js';

// ==========================================================================
// AULÕES - PALESTRAS (Comercial) — 04/11/2026: os módulos "Aulões - Redações" e
// "Palestras" viraram UMA agenda, pra o Comercial ver num lugar só onde cada um
// vai estar. Os dados continuam em comercial_auloes e comercial_palestras, com
// as rotas de antes (/api/auloes e /api/palestras): a tela junta as duas listas
// por data e o formulário mostra os campos do tipo escolhido.
// ==========================================================================

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

const MODULO = 'auloes';
// Nível padrão quando config/permissions ainda não tem a chave do módulo
// (mesmo valor do defaultPermissions do backend).
const NIVEL_PADRAO = { adm_l2: 3, comercial: 3 };
// Situação: aulão grava agendado/realizado/cancelado, palestra agendada/realizada/cancelada.
// Na tela é tudo uma coisa só (_st = forma masculina).
const ST_LABEL = { agendado: 'A realizar', realizado: 'Realizado', cancelado: 'Cancelado' };
const ST_PALESTRA = { agendado: 'agendada', realizado: 'realizada', cancelado: 'cancelada' };
const TIPO_INFO = { aulao: { api: '/auloes', nome: 'Aulão', icone: '🎓' }, palestra: { api: '/palestras', nome: 'Palestra', icone: '🎤' } };
const TRANSPORTE_LABEL = { comercial: 'Equipe Comercial', outro: 'Outro motorista', proprio: 'Deslocamento próprio', nao_necessario: 'Não será necessário', verificar: 'A verificar' };
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
// Tem que ficar aqui em cima: initApp() roda antes do fim do arquivo quando
// já há login em cache (caminho rápido) e wireEventos() usa estas constantes.
const FILTROS = ['busca', 'filtro-tipo', 'filtro-cidade', 'filtro-turno', 'filtro-status'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const ORDEM_TURNO = ['MANHÃ', 'MANHÃ E TARDE', 'MANHÃ, TARDE E NOITE', 'DIA TODO', 'TARDE', 'TARDE E NOITE', 'NOITE'];

let currentUser = null;
let currentUserNome = '';
let appInitialized = false;
let initializedRole = null;

let itens = [];            // aulões e palestras juntos, já normalizados (ver normalizar)
let periodoAtual = '';
let emEdicao = null;       // item aberto no formulário (null = novo)
let tipoForm = 'aulao';
let equipe = null;         // [{uid, nome}] do Comercial
let pessoaFiltro = '';     // chave do nome escolhido em "Quem do Comercial vai"
let soSemTransporte = false;
const oficios = {};        // seção "Ofício" do formulário, uma por tipo (base /auloes ou /palestras)

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(options.headers || {}) };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erro na API: ${res.status}`);
  }
  return res.json();
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
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Datas em 'AAAA-MM-DD' — Date local ao meio-dia pra não cair um dia pelo fuso.
function dataLocal(s) {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d, 12);
}
function fmtData(s) {
  if (!s) return '';
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a}`;
}
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const hoje = () => isoLocal(new Date());

function turnoClasse(t) {
  if (!t) return '';
  if (t.startsWith('MANHÃ')) return 'turno-manha';
  if (t.startsWith('TARDE')) return 'turno-tarde';
  if (t.startsWith('NOITE')) return 'turno-noite';
  return '';
}

function nomeProprio(nome) {
  const minusculas = ['da', 'de', 'do', 'das', 'dos', 'e'];
  return (nome || '').toLowerCase().split(/\s+/).filter(Boolean)
    .map((p, i) => (i > 0 && minusculas.includes(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// Cidade/palestrante/pessoa comparados sem acento/maiúscula ("Jardim alegre" x "Jardim Alegre").
const chave = (v) => (v || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Palestra que ainda vai acontecer e não tem quem leve.
const semTransporte = (i) => i._tipo === 'palestra' && i._st === 'agendado' && i.transporte === 'verificar' && (!i.data || i.data >= hoje());

// ==========================================
// AUTH GUARD
// ==========================================
const cached = getCachedAuth();
if (cached && (cached.role === 'adm_l1' || cached.role === 'adm_l2' || cached.role === 'comercial')) {
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
    if (role === 'adm_l1') {
      level = 3;
    } else {
      try {
        const perms = await apiFetchComRetentativa('/usuarios/config/permissions');
        const doCargo = perms[role] || {};
        const semConfig = doCargo[MODULO] === undefined && !(meuOverrides && meuOverrides[MODULO] !== undefined);
        level = semConfig ? (NIVEL_PADRAO[role] || 1) : getEffectiveLevel(doCargo, meuOverrides, MODULO);
      } catch (e) {
        level = NIVEL_PADRAO[role] || 1;
      }
    }
    if (level < 2) {
      window.location.href = '../../meu-espaco/index.html';
      return;
    }
    document.body.classList.toggle('hide-execute', level < 3);
    if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
      initializedRole = role;
      initApp(user, role);
    }
  } catch (err) {
    console.error('Erro na revalidação de auth:', err);
  }
});

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;
  currentUserNome = currentUserNome || user.displayName || '';

  setupLayout(user, role, MODULO, async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');
  montarPeriodos();
  wireEventos();
}

// Períodos: próximos, semestres, o ano e cada mês (as planilhas eram por mês).
function montarPeriodos() {
  const ano = new Date().getFullYear();
  const opcoes = [
    [`${hoje()}|`, 'Próximos (de hoje em diante)'],
    [`${ano}-07-01|${ano}-12-31`, `Semestre ${ano}.2`],
    [`${ano}-01-01|${ano}-06-30`, `Semestre ${ano}.1`],
    [`${ano}-01-01|${ano}-12-31`, `Ano ${ano} inteiro`]
  ];
  MESES.forEach((m, i) => {
    const fim = new Date(ano, i + 1, 0).getDate();
    const mm = String(i + 1).padStart(2, '0');
    opcoes.push([`${ano}-${mm}-01|${ano}-${mm}-${fim}`, `${m.charAt(0).toUpperCase() + m.slice(1)} de ${ano}`]);
  });
  opcoes.push([`${ano + 1}-01-01|${ano + 1}-06-30`, `Semestre ${ano + 1}.1`]);
  opcoes.push([`${ano + 1}-01-01|${ano + 1}-12-31`, `Ano ${ano + 1} inteiro`]);
  document.getElementById('sel-periodo').innerHTML = '<option value="">Selecione o período...</option>' +
    opcoes.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
}

function wireEventos() {
  // Só busca depois que a pessoa escolhe o período (economia de leitura).
  document.getElementById('sel-periodo').addEventListener('change', (e) => {
    periodoAtual = e.target.value;
    document.getElementById('btn-copiar-agenda').classList.toggle('hidden', !periodoAtual);
    document.getElementById('btn-imprimir').classList.toggle('hidden', !periodoAtual);
    if (periodoAtual) carregar();
    else {
      document.getElementById('conteudo').classList.add('hidden');
      document.getElementById('msg-inicial').classList.remove('hidden');
    }
  });

  FILTROS.forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener(el.type === 'text' ? 'input' : 'change', renderTudo);
  });
  document.getElementById('pessoas-bar').addEventListener('click', (e) => {
    const chip = e.target.closest('.curso-chip');
    if (!chip) return;
    pessoaFiltro = chip.dataset.pessoa;
    renderTudo();
  });
  document.getElementById('btn-limpar-filtros').addEventListener('click', () => {
    FILTROS.forEach(id => { document.getElementById(id).value = ''; });
    pessoaFiltro = '';
    soSemTransporte = false;
    renderTudo();
  });
  document.getElementById('alerta-transporte').addEventListener('click', (e) => {
    if (!e.target.closest('button')) return;
    FILTROS.forEach(id => { document.getElementById(id).value = ''; });
    pessoaFiltro = '';
    soSemTransporte = true;
    renderTudo();
  });

  document.getElementById('btn-novo-aulao').addEventListener('click', () => abrirModal(null, 'aulao'));
  document.getElementById('btn-novo-palestra').addEventListener('click', () => abrirModal(null, 'palestra'));
  document.getElementById('btn-imprimir').addEventListener('click', () => imprimirRelatorio([
    `Período: ${opcaoEscolhida('sel-periodo')}`,
    opcaoEscolhida('filtro-tipo') && `Tipo: ${opcaoEscolhida('filtro-tipo')}`,
    pessoaFiltro && `Quem vai: ${nomePessoa(pessoaFiltro)}`,
    opcaoEscolhida('filtro-cidade') && `Cidade: ${opcaoEscolhida('filtro-cidade')}`,
    opcaoEscolhida('filtro-turno') && `Turno: ${opcaoEscolhida('filtro-turno')}`,
    opcaoEscolhida('filtro-status') && `Situação: ${opcaoEscolhida('filtro-status')}`,
    soSemTransporte && 'Só palestras sem quem leve o palestrante',
    document.getElementById('busca').value.trim() && `Busca: "${document.getElementById('busca').value.trim()}"`,
    `${document.querySelectorAll('#tabela-corpo tr:not(.mes-linha):not(:has(.tabela-msg))').length} compromisso(s)`
  ], currentUserNome || currentUser.email));
  document.getElementById('btn-cancelar-modal').addEventListener('click', fecharModal);
  document.getElementById('form-agenda').addEventListener('submit', salvar);
  document.getElementById('btn-excluir').addEventListener('click', () => emEdicao && excluir(emEdicao._key));
  for (const tipo of ['aulao', 'palestra']) {
    oficios[tipo] = criarOficio({
      base: TIPO_INFO[tipo].api, apiFetch, showToast, esc,
      aoMudar: (id, oficio) => { const i = itens.find(x => x._tipo === tipo && x.id === id); if (i) { i.oficio = oficio; renderTudo(); } }
    });
  }
  document.getElementById('btn-copiar-agenda').addEventListener('click', copiarAgenda);
  document.querySelectorAll('input[name="tipo-item"]').forEach(r => r.addEventListener('change', () => { tipoForm = r.value; aplicarTipoForm(); }));
  document.querySelectorAll('input[name="transporte"]').forEach(r => r.addEventListener('change', atualizarTransporte));
  document.getElementById('f-sem-data').addEventListener('change', atualizarSemData);
  // Local já visitado: puxa a cidade sozinho.
  document.getElementById('f-local').addEventListener('change', (e) => {
    const achado = itens.find(i => chave(i._local) === chave(e.target.value));
    const cidade = document.getElementById('f-cidade');
    if (achado && !cidade.value) cidade.value = achado.cidade;
  });

  document.getElementById('tabela-corpo').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-acao]');
    if (!btn) return;
    const { acao } = btn.dataset;
    // o link do ofício (comercial-comum.js) vem com data-id; os outros botões, com data-key
    const i = btn.dataset.key ? itens.find(x => x._key === btn.dataset.key) : itens.find(x => x.id === btn.dataset.id);
    const key = i && i._key;
    if (!i) return;
    if (acao === 'editar') abrirModal(key);
    else if (acao === 'excluir') excluir(key);
    else if (acao === 'oficio') oficios[i._tipo].ver(i.id);
    else mudarStatus(key, acao);
  });
}

// ==========================================
// CARGA: as duas listas, juntas
// ==========================================
// Deixa aulão e palestra com os mesmos "campos de tela" (prefixo _), sem mexer nos campos gravados.
function normalizar(raw, tipo) {
  const i = { ...raw, _tipo: tipo, _key: `${tipo}:${raw.id}` };
  if (tipo === 'aulao') {
    i._st = raw.status;
    i._local = raw.colegio || '';
    i._sub = raw.tipo || 'Aulão';
    i._hora = raw.horario || '';
    i._contato = raw.contatoColegio || '';
    // quem vai: marcados (responsaveis); registro antigo importado só tem o texto `responsavel`
    const marcados = (raw.responsaveis || []).map(p => p.nome);
    i._pessoas = marcados.length ? marcados : String(raw.responsavel || '').split(/\s*[,/]\s*|\s+e\s+/i).map(s => s.trim()).filter(Boolean);
    i._levam = [];
  } else {
    i._st = { agendada: 'agendado', realizada: 'realizado', cancelada: 'cancelado' }[raw.status] || raw.status;
    i._local = raw.local || '';
    i._sub = 'Palestra';
    i._hora = raw.horaInicio || '';
    i._contato = raw.contatoLocal || '';
    i._levam = raw.transporte === 'comercial' ? (raw.responsaveis || []).map(p => p.nome) : [];
    i._pessoas = [...new Set([...(raw.envolvidos || []).map(p => p.nome), ...i._levam])];
  }
  i._pessoasChaves = i._pessoas.map(chave);
  return i;
}

function ordenar() {
  itens.sort((a, b) => (a.data || '9999').localeCompare(b.data || '9999')
    || (a._hora || '').localeCompare(b._hora || '')
    || ORDEM_TURNO.indexOf(a.turno) - ORDEM_TURNO.indexOf(b.turno));
}

async function carregar() {
  document.getElementById('msg-inicial').classList.add('hidden');
  document.getElementById('conteudo').classList.remove('hidden');
  document.getElementById('tabela-corpo').innerHTML = '<tr><td colspan="7" class="tabela-msg">Carregando...</td></tr>';
  const [de, ate] = periodoAtual.split('|');
  const qs = `?de=${de}${ate ? `&ate=${ate}` : ''}`;
  const [a, p] = await Promise.allSettled([apiFetch(`/auloes${qs}`), apiFetch(`/palestras${qs}`)]);
  if (a.status === 'rejected' && p.status === 'rejected') {
    document.getElementById('tabela-corpo').innerHTML = `<tr><td colspan="7" class="tabela-msg">Erro ao carregar: ${esc(a.reason.message)}</td></tr>`;
    return;
  }
  if (a.status === 'rejected') showToast(`Os aulões não carregaram: ${a.reason.message}`, 'error');
  if (p.status === 'rejected') showToast(`As palestras não carregaram: ${p.reason.message}`, 'error');
  itens = [
    ...(a.status === 'fulfilled' ? a.value : []).map(x => normalizar(x, 'aulao')),
    ...(p.status === 'fulfilled' ? p.value : []).map(x => normalizar(x, 'palestra'))
  ];
  ordenar();
  renderTudo();
}

// ==========================================
// FILTROS + RENDER
// ==========================================
function lerFiltros() {
  return {
    busca: document.getElementById('busca').value.trim().toLowerCase(),
    tipo: document.getElementById('filtro-tipo').value,
    cidade: document.getElementById('filtro-cidade').value,
    turno: document.getElementById('filtro-turno').value,
    status: document.getElementById('filtro-status').value,
    pessoa: pessoaFiltro,
    semTransporte: soSemTransporte
  };
}

function passa(i, f, ignorar = '') {
  if (f.tipo === 't:aulao' && i._tipo !== 'aulao') return false;
  if (f.tipo === 't:palestra' && i._tipo !== 'palestra') return false;
  if (f.tipo.startsWith('s:') && !(i._tipo === 'aulao' && i._sub === f.tipo.slice(2))) return false;
  if (ignorar !== 'pessoa' && f.pessoa && !i._pessoasChaves.includes(f.pessoa)) return false;
  if (f.cidade && chave(i.cidade) !== chave(f.cidade)) return false;
  if (f.turno && i.turno !== f.turno) return false;
  if (ignorar !== 'status' && f.status && i._st !== f.status) return false;
  if (f.semTransporte && !semTransporte(i)) return false;
  if (f.busca) {
    const txt = `${i._local} ${i.turma || ''} ${i.tema || ''} ${i.palestrante || ''} ${i.motorista || ''} ${i._pessoas.join(' ')} ${i.observacoes || ''} ${i._contato} ${i.solicitacaoTexto || ''} ${i._sub}`.toLowerCase();
    if (!txt.includes(f.busca)) return false;
  }
  return true;
}

// Uma opção por valor (sem duplicar por acento/maiúscula), com a grafia mais comum.
function unicosNormalizados(valores) {
  const porChave = {};
  valores.forEach(v => {
    v = (v || '').trim();
    if (!v) return;
    const k = chave(v);
    porChave[k] = porChave[k] || {};
    porChave[k][v] = (porChave[k][v] || 0) + 1;
  });
  return Object.values(porChave).map(v => Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]).sort((a, b) => a.localeCompare(b));
}

function preencherSelect(id, opcoes, rotuloTodos) {
  const sel = document.getElementById(id);
  const atual = sel.value;
  sel.innerHTML = `<option value="">${rotuloTodos}</option>` + opcoes.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  if (opcoes.some(([v]) => v === atual)) sel.value = atual;
}

function nomePessoa(k) {
  const achado = itens.flatMap(i => i._pessoas).find(n => chave(n) === k);
  return nomeProprio(achado || k);
}

function renderTudo() {
  const cidades = unicosNormalizados(itens.map(i => i.cidade));
  const subtipos = unicosNormalizados(itens.filter(i => i._tipo === 'aulao').map(i => i._sub));
  preencherSelect('filtro-tipo', [['t:aulao', '🎓 Só aulões'], ...subtipos.map(s => [`s:${s}`, `   ${s}`]), ['t:palestra', '🎤 Só palestras']], 'Aulões e palestras');
  preencherSelect('filtro-cidade', cidades.map(c => [c, c]), 'Todas as cidades');
  preencherSelect('filtro-turno', [...new Set(itens.map(i => i.turno).filter(Boolean))].sort((a, b) => ORDEM_TURNO.indexOf(a) - ORDEM_TURNO.indexOf(b)).map(t => [t, t]), 'Todos os turnos');
  document.getElementById('lista-locais').innerHTML = unicosNormalizados(itens.map(i => i._local)).map(v => `<option value="${esc(v)}">`).join('');
  document.getElementById('lista-cidades').innerHTML = cidades.map(v => `<option value="${esc(v)}">`).join('');
  document.getElementById('lista-palestrantes').innerHTML = unicosNormalizados(itens.map(i => i.palestrante)).map(v => `<option value="${esc(v)}">`).join('');
  document.getElementById('lista-motoristas').innerHTML = unicosNormalizados(itens.filter(i => i.transporte === 'outro').map(i => i.motorista)).map(v => `<option value="${esc(v)}">`).join('');

  const f = lerFiltros();

  // Alerta: palestras futuras sem quem leve (independe dos filtros).
  const pendentes = itens.filter(semTransporte).length;
  const alerta = document.getElementById('alerta-transporte');
  alerta.classList.toggle('hidden', !pendentes);
  alerta.innerHTML = pendentes ? `⚠️ ${pendentes} palestra(s) ainda sem definição de quem leva o palestrante. <button type="button">Ver quais</button>` : '';

  // KPIs (respeitam os filtros, menos a situação — é o que eles contam).
  const base = itens.filter(i => passa(i, f, 'status'));
  const ativos = base.filter(i => i._st !== 'cancelado');
  const nA = ativos.filter(i => i._tipo === 'aulao').length, nP = ativos.length - nA;
  document.getElementById('kpi-total').textContent = ativos.length;
  document.getElementById('kpi-divisao').textContent = `${nA} aulão(ões) · ${nP} palestra(s)`;
  document.getElementById('kpi-agendado').textContent = base.filter(i => i._st === 'agendado').length;
  const daqui7 = isoLocal(new Date(Date.now() + 7 * 86400000));
  const semana = base.filter(i => i._st === 'agendado' && i.data && i.data >= hoje() && i.data <= daqui7).length;
  document.getElementById('kpi-semana').textContent = semana ? `${semana} nos próximos 7 dias` : '';
  document.getElementById('kpi-realizado').textContent = base.filter(i => i._st === 'realizado').length;
  const canc = base.length - ativos.length;
  document.getElementById('kpi-cancelados').textContent = canc ? `+ ${canc} cancelado(s)` : '';
  document.getElementById('kpi-verificar').textContent = base.filter(semTransporte).length;
  document.getElementById('kpi-locais').textContent = new Set(ativos.map(i => chave(i._local))).size;
  document.getElementById('kpi-cidades').textContent = `${new Set(ativos.map(i => chave(i.cidade))).size} cidade(s)`;

  // Botões por pessoa do Comercial (com quantidade, respeitando os outros filtros).
  const semPessoa = itens.filter(i => passa(i, f, 'pessoa') && i._st !== 'cancelado');
  const porPessoa = {};
  semPessoa.forEach(i => i._pessoasChaves.forEach(k => { if (k) porPessoa[k] = (porPessoa[k] || 0) + 1; }));
  const semNinguem = semPessoa.filter(i => !i._pessoas.length).length;
  const chip = (k, rotulo, n) => `<button type="button" class="curso-chip ap-chip-pessoa ${f.pessoa === k ? 'ativo' : ''}" data-pessoa="${esc(k)}">${k ? avatar(rotulo) : ''}${esc(rotulo)} <span class="curso-chip-qtd">${n}</span></button>`;
  const pessoas = Object.entries(porPessoa).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (f.pessoa && !porPessoa[f.pessoa]) pessoas.push([f.pessoa, 0]);
  document.getElementById('pessoas-bar').innerHTML = chip('', 'Todos', semPessoa.length)
    + pessoas.map(([k, n]) => chip(k, nomePessoa(k).split(' ').slice(0, 2).join(' '), n)).join('')
    + (semNinguem ? `<span class="ap-ninguem" title="Compromissos a realizar sem ninguém do Comercial marcado">sem ninguém do Comercial: ${semNinguem}</span>` : '');

  const lista = itens.filter(i => passa(i, f));
  const filtrando = Object.values(f).some(v => v);
  document.getElementById('btn-limpar-filtros').classList.toggle('hidden', !filtrando);
  document.getElementById('filtro-resumo').innerHTML = filtrando
    ? `Mostrando <strong>${lista.length}</strong> de ${itens.length} compromissos do período${f.pessoa ? ` · <b>${esc(nomePessoa(f.pessoa))}</b>` : ''}${f.semTransporte ? ' · só palestras sem quem leve' : ''}`
    : '';
  renderTabela(lista);
}

function quemLevaHtml(i) {
  let txt;
  if (i.transporte === 'comercial') txt = `🚗 Leva: ${esc(nomeProprio(i.motorista))}`;
  else if (i.transporte === 'outro') txt = `🚗 Leva: ${esc(i.motorista || 'outro motorista')}`;
  else if (i.transporte === 'proprio') txt = '🚙 Deslocamento próprio';
  else if (i.transporte === 'nao_necessario') txt = 'Sem transporte';
  else txt = '⚠️ Transporte a verificar';
  return `<span class="pl-leva tp-${i.transporte}">${txt}</span>` + (i.pagarDeslocamento ? '<span class="pl-pagar">💰 pagar deslocamento</span>' : '');
}

function renderTabela(lista) {
  const corpo = document.getElementById('tabela-corpo');
  if (!lista.length) {
    corpo.innerHTML = `<tr><td colspan="7" class="tabela-msg">${itens.length ? 'Nenhum compromisso com esses filtros.' : 'Nada agendado nesse período. Use "Agendar aulão" ou "Agendar palestra".'}</td></tr>`;
    return;
  }
  // Agrupado por mês; palestras sem data vão no fim, em "Data a definir".
  const grupos = {};
  lista.forEach(i => { const k = i.data ? i.data.slice(0, 7) : 'zz-sem-data'; (grupos[k] = grupos[k] || []).push(i); });
  const h = hoje();
  corpo.innerHTML = Object.keys(grupos).sort().map(k => {
    const titulo = k === 'zz-sem-data' ? 'Data a definir' : `Mês de ${MESES[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
    const cab = `<tr class="mes-linha ${k === 'zz-sem-data' ? 'sem-data' : ''}"><td colspan="7">${titulo}<span class="mes-qtd">${grupos[k].length} compromisso(s)</span></td></tr>`;
    return cab + grupos[k].map(i => {
      const passado = i.data && i.data < h;
      const esqueceu = passado && i._st === 'agendado';
      let acoes = '';
      if (i._st === 'agendado') {
        acoes += `<button class="btn-acao ok" data-acao="realizado" data-key="${i._key}">✓ Realizado</button>`;
        acoes += `<button class="btn-acao desistir" data-acao="cancelado" data-key="${i._key}">Cancelar</button>`;
      } else {
        acoes += `<button class="btn-acao" data-acao="agendado" data-key="${i._key}" title="Voltar para a realizar">↺</button>`;
      }
      acoes += `<button class="btn-acao" data-acao="editar" data-key="${i._key}">Editar</button>`;
      acoes += `<button class="btn-acao desistir" data-acao="excluir" data-key="${i._key}" title="Excluir">🗑</button>`;
      const quando = i.data
        ? `<div class="ae-dia">${fmtData(i.data)}${i.data === h ? '<span class="ae-hoje">HOJE</span>' : ''}</div><div class="ct-sub">${DIAS[dataLocal(i.data).getDay()]}${i._tipo === 'palestra' && i.horario ? ' · ' + esc(i.horario) : (i._hora ? ' · ' + i._hora : '')}</div>`
        : `<div class="ae-dia">${esc(i.dataPrevista || 'A definir')}</div>${i.horario ? `<div class="ct-sub">${esc(i.horario)}</div>` : ''}`;
      const turno = i._tipo === 'aulao' && i.turno ? `<div><span class="turno-badge ${turnoClasse(i.turno)}">${esc(i.turno)}</span></div>` : '';
      const oque = `<span class="ap-tipo ap-${i._tipo}">${TIPO_INFO[i._tipo].icone} ${esc(i._tipo === 'aulao' ? i._sub : 'Palestra')}</span>${turno}`;
      const onde = `<div class="pl-local">${esc(i._local)}</div><div class="ct-sub">📍 ${esc(i.cidade)}</div>${i.observacoes ? `<div class="ct-sub" title="${esc(i.observacoes)}">📝 ${esc(i.observacoes.length > 45 ? i.observacoes.slice(0, 45) + '…' : i.observacoes)}</div>` : ''}${oficioNaLinha(i, esc, fmtData)}`;
      const detalhes = i._tipo === 'aulao'
        ? [i.turma && `Turma: ${esc(i.turma)}`, i.palestrante && `Com: ${esc(i.palestrante)}`, i.publicoEstimado && `~${i.publicoEstimado} alunos`].filter(Boolean).join('<br>') || '<span class="ct-vazio">—</span>'
        : `<span class="cm-pessoa" style="min-width:0">${avatar(i.palestrante)}<span><span class="pl-palestrante">${esc(i.palestrante) || '—'}</span>${i.tema ? `<div class="pl-tema">${esc(i.tema)}</div>` : ''}</span></span>`;
      const vai = (i._pessoas.length ? `<div class="ap-vai">${i._pessoas.map(n => `<span class="ap-pessoa">${avatar(n)}${esc(nomeProprio(n).split(' ').slice(0, 2).join(' '))}</span>`).join('')}</div>` : '<span class="ct-vazio">ninguém do Comercial marcado</span>')
        + (i._tipo === 'palestra' ? `<div>${quemLevaHtml(i)}</div>` : '')
        + (i.atividadeId ? '<div class="ae-agenda-ok" title="Está na agenda do Meu Espaço">📅 na agenda</div>' : '');
      return `
        <tr class="${passado && i._st !== 'agendado' ? 'linha-passada' : ''}">
          <td>${quando}</td>
          <td class="ap-col-oque">${oque}</td>
          <td class="ap-col-onde">${onde}</td>
          <td class="ap-detalhes">${detalhes}</td>
          <td class="ap-col-vai">${vai}</td>
          <td><span class="status-badge st-${i._st}">${ST_LABEL[i._st] || i._st}</span>${esqueceu ? '<div class="ae-atencao" title="Data já passou — marque se foi realizado">aconteceu?</div>' : ''}</td>
          <td class="acoes-col action-execute">${acoes}</td>
        </tr>`;
    }).join('');
  }).join('');
}

// ==========================================
// FORMULÁRIO (um só, com os campos do tipo escolhido)
// ==========================================
async function carregarEquipe() {
  if (equipe) return;
  try { equipe = await apiFetch('/auloes/equipe'); } catch (e) {
    try { equipe = await apiFetch('/palestras/equipe'); } catch (e2) { equipe = []; }
  }
}

function renderEquipe(boxId, selecionados) {
  const box = document.getElementById(boxId);
  if (!equipe.length) { box.innerHTML = '<span class="ct-sub">Não foi possível carregar a equipe do Comercial.</span>'; return; }
  box.innerHTML = equipe.map(p => `
    <label class="equipe-chip"><input type="checkbox" value="${p.uid}" ${selecionados.includes(p.uid) ? 'checked' : ''}>${esc(nomeProprio(p.nome))}</label>`).join('');
}
const marcados = (boxId) => [...document.querySelectorAll(`#${boxId} input:checked`)].map(x => x.value);

function transporteEscolhido() {
  return document.querySelector('input[name="transporte"]:checked')?.value || 'verificar';
}
function atualizarTransporte() {
  const t = transporteEscolhido();
  document.getElementById('grupo-leva').classList.toggle('hidden', t !== 'comercial');
  document.getElementById('grupo-motorista').classList.toggle('hidden', t !== 'outro');
}
function atualizarSemData() {
  const semData = tipoForm === 'palestra' && document.getElementById('f-sem-data').checked;
  document.getElementById('grupo-data-prevista').classList.toggle('hidden', !semData || tipoForm !== 'palestra');
  document.getElementById('f-data').disabled = semData;
  if (semData) document.getElementById('f-data').value = '';
}

// Mostra só os campos do tipo e ajusta rótulos.
function aplicarTipoForm() {
  const aulao = tipoForm === 'aulao';
  document.querySelectorAll('#form-agenda .so-aulao').forEach(el => el.classList.toggle('hidden', !aulao));
  document.querySelectorAll('#form-agenda .so-palestra').forEach(el => el.classList.toggle('hidden', aulao));
  document.querySelectorAll('input[name="tipo-item"]').forEach(r => { r.checked = r.value === tipoForm; });
  document.getElementById('lbl-local').textContent = aulao ? 'Colégio *' : 'Instituição / local *';
  document.getElementById('f-local').style.textTransform = aulao ? 'uppercase' : '';
  document.getElementById('lbl-palestrante').textContent = aulao ? 'Professor / palestrante' : 'Palestrante(s)';
  document.getElementById('lbl-vai-dica').textContent = aulao ? 'vai ao colégio' : 'palestra, apoia ou acompanha';
  document.getElementById('f-turno').required = aulao;
  const novo = !emEdicao;
  document.getElementById('modal-titulo').textContent = novo ? (aulao ? 'Agendar aulão' : 'Agendar palestra') : (aulao ? 'Editar aulão' : 'Editar palestra');
  document.getElementById('btn-excluir').textContent = aulao ? 'Excluir aulão' : 'Excluir palestra';
  // a seção Ofício é a do tipo (rota /auloes ou /palestras); a outra fica sem item
  oficios[aulao ? 'palestra' : 'aulao'].preencher(null);
  oficios[tipoForm].preencher(emEdicao && emEdicao._tipo === tipoForm ? emEdicao : null);
  atualizarTransporte();
  atualizarSemData();
}

async function abrirModal(key, tipoNovo) {
  // Não espera a equipe pra abrir (no Vercel a 1ª chamada pode levar segundos).
  const equipePronta = carregarEquipe();
  const i = key ? itens.find(x => x._key === key) : null;
  emEdicao = i;
  tipoForm = i ? i._tipo : tipoNovo;
  document.getElementById('modal-ultima-alt').textContent = i && i.updatedBy
    ? `Agendado por ${i.createdBy} · última alteração: ${i.updatedBy} em ${new Date(i.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : '';
  // tipo só se escolhe no agendamento novo (cada um fica numa lista própria)
  document.querySelectorAll('input[name="tipo-item"]').forEach(r => { r.disabled = !!i; });
  document.getElementById('f-tipo-travado').classList.toggle('hidden', !i);

  const set = (campo, v) => { document.getElementById(campo).value = v ?? ''; };
  set('f-local', i?._local);
  set('f-cidade', i?.cidade);
  set('f-data', i?.data);
  set('f-hora', i?._hora);
  set('f-turno', i?.turno);
  set('f-subtipo', i ? (i._tipo === 'aulao' ? i.tipo : '') : 'Aulão de redação');
  set('f-turma', i?.turma);
  set('f-publico', i?.publicoEstimado);
  set('f-palestrante', i?.palestrante);
  set('f-contato-aulao', i?._tipo === 'aulao' ? i.contatoColegio : '');
  set('f-contato-palestra', i?._tipo === 'palestra' ? i.contatoLocal : '');
  set('f-tema', i?.tema);
  set('f-data-prevista', i?.dataPrevista);
  set('f-horario-texto', i?._tipo === 'palestra' ? i.horario : '');
  set('f-motorista', i?.transporte === 'outro' ? i.motorista : '');
  set('f-status', i?._st || 'agendado');
  set('f-obs', i?.observacoes);
  document.getElementById('f-sem-data').checked = !!(i && i._tipo === 'palestra' && !i.data);
  document.getElementById('f-pagar').checked = !!i?.pagarDeslocamento;
  const t = i?._tipo === 'palestra' ? i.transporte : 'comercial';
  document.querySelectorAll('input[name="transporte"]').forEach(r => { r.checked = r.value === t; });

  // Quem vai: aulão = responsaveis (novo: já marca quem está agendando); palestra = envolvidos.
  const vai = i ? (i._tipo === 'aulao' ? (i.responsaveis || []) : (i.envolvidos || [])).map(p => p.uid) : (tipoNovo === 'aulao' ? [currentUser.uid] : []);
  const levam = i?._tipo === 'palestra' && i.transporte === 'comercial' ? (i.responsaveis || []).map(p => p.uid) : [];
  const desenharEquipe = () => { renderEquipe('f-vai', vai); renderEquipe('f-leva', levam); };
  if (equipe) desenharEquipe();
  else {
    ['f-vai', 'f-leva'].forEach(b => { document.getElementById(b).innerHTML = '<span class="ct-sub">Carregando equipe...</span>'; });
    equipePronta.then(() => { if (emEdicao === i) desenharEquipe(); });
  }
  document.getElementById('grupo-status').classList.toggle('hidden', !i);
  document.getElementById('btn-excluir').classList.toggle('hidden', !i);
  aplicarTipoForm();
  document.getElementById('modal-agenda').classList.remove('hidden');
  document.getElementById('f-local').focus();
}

function fecharModal() {
  document.getElementById('modal-agenda').classList.add('hidden');
}

function corpoDoForm() {
  const v = (id) => document.getElementById(id).value;
  const st = v('f-status');
  if (tipoForm === 'aulao') {
    if (!v('f-data')) throw new Error('Informe a data.');
    if (!v('f-turno')) throw new Error('Informe o turno.');
    return {
      data: v('f-data'), turno: v('f-turno'), horario: v('f-hora'), colegio: v('f-local'), cidade: v('f-cidade'),
      tipo: v('f-subtipo'), turma: v('f-turma'), responsaveisUids: marcados('f-vai'), palestrante: v('f-palestrante'),
      contatoColegio: v('f-contato-aulao'), publicoEstimado: v('f-publico'), status: st, observacoes: v('f-obs'),
      ...oficios.aulao.campos()
    };
  }
  const semData = document.getElementById('f-sem-data').checked;
  if (!semData && !v('f-data')) throw new Error('Informe a data ou marque "Ainda sem data".');
  if (semData && !v('f-data-prevista').trim()) throw new Error('Informe a previsão (ex.: "Novembro").');
  const transporte = transporteEscolhido();
  const responsaveisUids = marcados('f-leva');
  if (transporte === 'comercial' && !responsaveisUids.length) throw new Error('Marque quem da equipe vai levar o palestrante.');
  return {
    local: v('f-local'), cidade: v('f-cidade'), data: semData ? '' : v('f-data'), dataPrevista: semData ? v('f-data-prevista') : '',
    horaInicio: v('f-hora'), horario: v('f-horario-texto'), palestrante: v('f-palestrante'), tema: v('f-tema'),
    transporte, responsaveisUids, envolvidosUids: marcados('f-vai'),
    motorista: v('f-motorista'), pagarDeslocamento: document.getElementById('f-pagar').checked,
    contatoLocal: v('f-contato-palestra'), status: ST_PALESTRA[st] || st, observacoes: v('f-obs'),
    ...oficios.palestra.campos()
  };
}

async function salvar(e) {
  e.preventDefault();
  let body;
  try { body = corpoDoForm(); } catch (err) { showToast(err.message, 'error'); return; }
  const tipo = tipoForm;
  const api = TIPO_INFO[tipo].api;
  const btn = document.getElementById('btn-salvar');
  btn.disabled = true;
  try {
    const arquivo = await oficios[tipo].prepararArquivo();
    const salvo = emEdicao
      ? await apiFetch(`${api}/${emEdicao.id}`, { method: 'PUT', body: JSON.stringify(body) })
      : await apiFetch(api, { method: 'POST', body: JSON.stringify(body) });
    substituir(normalizar(salvo, tipo));
    fecharModal();
    showToast(emEdicao ? 'Alterações salvas.' : (tipo === 'aulao' ? 'Aulão agendado.' : 'Palestra agendada.'));
    if (arquivo) await enviarOficio(tipo, salvo.id, arquivo);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// O agendamento já foi salvo: se o ofício falhar, avisa sem desfazer o resto.
async function enviarOficio(tipo, id, arquivo) {
  try {
    await oficios[tipo].enviar(id, arquivo);
    showToast('Ofício anexado.');
  } catch (err) {
    showToast(`Agendamento salvo, mas o ofício não foi anexado: ${err.message}`, 'error');
  }
}

function substituir(item) {
  const idx = itens.findIndex(x => x._key === item._key);
  if (idx >= 0) itens[idx] = item; else itens.push(item);
  ordenar();
  renderTudo();
}

function rotulo(i) {
  return `${i._tipo === 'aulao' ? 'o aulão' : 'a palestra'} em ${i._local} (${fmtData(i.data) || i.dataPrevista || 'sem data'})`;
}

async function mudarStatus(key, st) {
  const i = itens.find(x => x._key === key);
  if (!i) return;
  if (st === 'cancelado' && !confirm(`Cancelar ${rotulo(i)}?`)) return;
  const status = i._tipo === 'palestra' ? ST_PALESTRA[st] : st;
  try {
    substituir(normalizar(await apiFetch(`${TIPO_INFO[i._tipo].api}/${i.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }), i._tipo));
    showToast(`${i._local} → ${ST_LABEL[st]}`);
  } catch (err) { showToast(err.message, 'error'); }
}

async function excluir(key) {
  const i = itens.find(x => x._key === key);
  if (!i || !confirm(`Excluir ${rotulo(i)}?\n\nIsso não pode ser desfeito. (Se só não vai acontecer, use "Cancelar".)`)) return;
  try {
    await apiFetch(`${TIPO_INFO[i._tipo].api}/${i.id}`, { method: 'DELETE' });
    itens = itens.filter(x => x._key !== key);
    fecharModal();
    renderTudo();
    showToast(i._tipo === 'aulao' ? 'Aulão excluído.' : 'Palestra excluída.');
  } catch (err) { showToast(err.message, 'error'); }
}

// Agenda filtrada em texto, por mês — pronta pra colar no WhatsApp.
async function copiarAgenda() {
  const f = lerFiltros();
  const lista = itens.filter(i => passa(i, f) && i._st !== 'cancelado');
  if (!lista.length) { showToast('Nada para copiar com esses filtros.', 'error'); return; }
  const linhas = [`*AGENDA AULÕES E PALESTRAS - FATEC*${f.pessoa ? ` — ${nomePessoa(f.pessoa)}` : ''}`];
  let grupo = '';
  lista.forEach(i => {
    const k = i.data ? i.data.slice(0, 7) : 'sem';
    if (k !== grupo) {
      grupo = k;
      linhas.push('', k === 'sem' ? '*DATA A DEFINIR*' : `*${MESES[Number(k.slice(5, 7)) - 1].toUpperCase()} ${k.slice(0, 4)}*`);
    }
    const quando = i.data ? `${fmtData(i.data).slice(0, 5)} (${DIAS[dataLocal(i.data).getDay()]})` : (i.dataPrevista || 'a definir');
    const hora = i._tipo === 'aulao' ? [i.turno, i._hora].filter(Boolean).join(' ') : (i.horario || i._hora);
    const oque = i._tipo === 'aulao' ? `🎓 ${i._sub}` : `🎤 Palestra${i.tema ? `: ${i.tema}` : ''}`;
    const partes = [`${quando}${hora ? ` ${hora}` : ''}`, oque, `${i._local} (${i.cidade})`];
    if (i.palestrante) partes.push(i.palestrante);
    if (i._pessoas.length) partes.push(`vai: ${i._pessoas.map(nomeProprio).join(', ')}`);
    if (i._tipo === 'palestra') {
      partes.push(i.transporte === 'comercial' || i.transporte === 'outro' ? `leva: ${nomeProprio(i.motorista)}` : (i.transporte === 'verificar' ? 'transporte: A VERIFICAR' : TRANSPORTE_LABEL[i.transporte]));
    }
    linhas.push(`• ${partes.filter(Boolean).join(' – ')}${i._st === 'realizado' ? ' ✅' : ''}`);
  });
  const txt = linhas.join('\n');
  try { await navigator.clipboard.writeText(txt); } catch (e) {
    const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  showToast(`Agenda copiada (${lista.length} compromisso(s)).`);
}
