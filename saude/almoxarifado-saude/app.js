import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

// Mesmo limite usado no backend (src/rotas/almoxarifado-saude.js) pra classificar "vencendo"
const DIAS_VENCENDO = 60;

let currentUser = null;
let currentRole = null;
let userLevel = 1;
let appInitialized = false;
let initializedRole = null;

let categoriaAtual = 'Consumível';
let viewAtual = 'Consumível';
let itens = [];
let localizacoes = [];
let salas = [];
let proximoCursor = null;
let hasMaisAtual = false;
let carregandoMais = false;
let buscaDebounce = null;

let itemAtual = null;       // item aberto no modal de movimentação
let lotesAtuais = [];       // lotes do item aberto no modal de movimentação
let historicoAtual = [];
let tipoMovAtual = 'entrada';
let modoEntradaAtual = 'novo';

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {})
  };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erro na API: ${res.status}`);
  }
  return res.json();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ==========================================
// AUTH GUARD E INICIALIZAÇÃO
// ==========================================
const cached = getCachedAuth();
if (cached && (cached.role === 'adm_l1' || cached.role === 'adm_l2')) {
  currentUser = cached.user;
  currentRole = cached.role;
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
    try {
      const userData = await apiFetch('/usuarios/me');
      role = userData.role || 'visitante';
    } catch (err) {
      role = cached ? cached.role : 'visitante';
    }

    setCachedAuth(user, role, token);

    let level = 1;
    if (role === 'adm_l1') {
      level = 3;
    } else {
      try {
        const perms = await apiFetch('/usuarios/config/permissions');
        const rolePerms = perms[role] || {};
        const rawPerm = rolePerms['almoxarifado-saude'];
        level = (rawPerm !== undefined && typeof rawPerm === 'object')
          ? (rawPerm.execute ? 3 : (rawPerm.view ? 2 : 1))
          : (parseInt(rawPerm) || 1);
      } catch (e) {
        if (role === 'adm_l2') level = 3;
      }
    }
    userLevel = level;

    if (level < 2) {
      window.location.href = '../../meu-espaco/index.html';
      return;
    }

    document.body.classList.toggle('hide-execute', level < 3);

    if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
      currentRole = role;
      initApp(user, role);
    }
  } catch (err) {
    console.error("Erro na revalidação de auth:", err);
  }
});

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;

  setupLayout(user, role, 'almoxarifado-saude', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');

  // relatorio-estoque.html e relatorio-movimentacoes.html reaproveitam este
  // app.js só pra auth/layout + a própria tela (mesmo padrão do Almoxarifado Feridas)
  if (document.getElementById('relatorio-estoque-conteudo')) {
    initPaginaRelatorioEstoque();
    return;
  }
  if (document.getElementById('relatorio-movimentacoes-conteudo')) {
    initPaginaRelatorioMovimentacoes();
    return;
  }
  if (document.getElementById('termo-emprestimo-conteudo')) {
    initPaginaTermoEmprestimo();
    return;
  }

  document.body.classList.toggle('categoria-permanente', categoriaAtual === 'Permanente');

  setupTabs();
  setupFiltros();
  setupModalItem();
  setupModalMovimentacao();
  setupModalConferencia();
  setupModalReserva();

  await loadLocalizacoes();
  await Promise.all([loadItens(), loadStats()]);
}

// ==========================================
// ABAS (Consumíveis / Patrimônio)
// ==========================================

function setupTabs() {
  document.getElementById('tab-consumivel').addEventListener('click', () => trocarAba('Consumível'));
  document.getElementById('tab-permanente').addEventListener('click', () => trocarAba('Permanente'));
  document.getElementById('tab-agendamento').addEventListener('click', () => trocarAba('Agendamento'));
}

async function trocarAba(view) {
  if (view === viewAtual) return;
  viewAtual = view;
  document.getElementById('tab-consumivel').classList.toggle('on', view === 'Consumível');
  document.getElementById('tab-permanente').classList.toggle('on', view === 'Permanente');
  document.getElementById('tab-agendamento').classList.toggle('on', view === 'Agendamento');

  const isAgendamento = view === 'Agendamento';
  document.getElementById('painel-itens').classList.toggle('hidden', isAgendamento);
  document.getElementById('painel-agendamento').classList.toggle('hidden', !isAgendamento);
  document.getElementById('painel-itens-acoes').classList.toggle('hidden', isAgendamento);
  document.getElementById('painel-agendamento-acoes').classList.toggle('hidden', !isAgendamento);

  if (isAgendamento) {
    document.body.classList.remove('categoria-permanente');
    await Promise.all([loadSalas(), loadAgendamentos()]);
    return;
  }

  categoriaAtual = view;
  document.body.classList.toggle('categoria-permanente', view === 'Permanente');
  document.getElementById('filtro-vencimento').checked = false;
  document.getElementById('filtro-baixo-estoque').checked = false;
  document.getElementById('search-itens').value = '';
  document.getElementById('filtro-localizacao').value = '';
  document.getElementById('link-relatorio-estoque').href = `/saude/almoxarifado-saude/relatorio-estoque.html?categoria=${encodeURIComponent(view)}`;
  await loadLocalizacoes();
  await Promise.all([loadItens(), loadStats()]);
}

// Modo de listagem atual: navegação normal (paginada) ou um dos alertas
// (baixo estoque / vencimento), que usam um endpoint dedicado e mais enxuto.
function modoAlertaAtivo() {
  if (document.getElementById('filtro-baixo-estoque').checked) return 'baixo';
  if (document.getElementById('filtro-vencimento').checked) return 'vencimento';
  return null;
}

// ==========================================
// LOCALIZAÇÕES
// ==========================================

async function loadLocalizacoes() {
  try {
    localizacoes = await apiFetch('/almoxarifado-saude/localizacoes');
  } catch (err) {
    localizacoes = [];
  }
  // Cada aba só mostra as localizações que fazem sentido pra ela: Consumível
  // usa as "Consumíveis - X", Permanente usa os laboratórios/setores fixos.
  const localizacoesAba = localizacoes.filter(l => l.startsWith('Consumíveis - ') === (categoriaAtual === 'Consumível'));
  const selectFiltro = document.getElementById('filtro-localizacao');
  const selectItem = document.getElementById('item-localizacao');
  const opcoes = localizacoesAba.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
  selectFiltro.innerHTML = '<option value="">Todas as localizações</option>' + opcoes;
  selectItem.innerHTML = opcoes;
}

// ==========================================
// ITENS
// ==========================================

// Carrega a 1ª página (ou reinicia a busca/filtro do zero). A listagem é
// paginada no servidor — evita trazer os 500-900+ itens da categoria de uma
// vez só (o que consumia centenas de leituras do Firestore a cada acesso).
async function loadItens() {
  const lista = document.getElementById('itens-list');
  itens = [];
  proximoCursor = null;
  lista.innerHTML = '<div class="empty-state"><p>Carregando itens...</p></div>';
  await carregarPagina(true);
}

async function carregarPagina(primeira) {
  if (carregandoMais) return;
  carregandoMais = true;
  const lista = document.getElementById('itens-list');
  try {
    const alerta = modoAlertaAtivo();
    let resp;
    if (alerta) {
      resp = await apiFetch(`/almoxarifado-saude/itens/alertas?categoria=${encodeURIComponent(categoriaAtual)}&tipo=${alerta}`);
    } else {
      const busca = document.getElementById('search-itens').value.trim();
      const localizacao = document.getElementById('filtro-localizacao').value;
      const params = new URLSearchParams({ categoria: categoriaAtual });
      if (busca) params.set('busca', busca);
      if (localizacao) params.set('localizacao', localizacao);
      if (!primeira && proximoCursor) params.set('cursor', proximoCursor);
      resp = await apiFetch(`/almoxarifado-saude/itens?${params.toString()}`);
    }
    itens = primeira ? resp.itens : [...itens, ...resp.itens];
    proximoCursor = resp.proximoCursor;
    hasMaisAtual = resp.hasMore;
    renderItens(itens, hasMaisAtual);
  } catch (err) {
    lista.innerHTML = `<div class="empty-state"><p>Erro ao carregar: ${esc(err.message)}</p></div>`;
  } finally {
    carregandoMais = false;
  }
}

async function loadStats() {
  try {
    const stats = await apiFetch('/almoxarifado-saude/stats');
    renderResumo(stats);
  } catch (err) {
    document.getElementById('alx-resumo').innerHTML = '';
  }
}

function renderResumo(stats) {
  const el = document.getElementById('alx-resumo');
  const totalAba = categoriaAtual === 'Consumível' ? stats.consumivel : stats.permanente;
  let html = `<div class="alx-resumo-card"><b>${totalAba}</b><span>Item${totalAba === 1 ? '' : 's'} cadastrado${totalAba === 1 ? '' : 's'}</span></div>`;
  html += `<div class="alx-resumo-card${stats.abaixoMinimo ? ' baixo' : ''}"><b>${stats.abaixoMinimo}</b><span>Com estoque baixo</span></div>`;
  if (categoriaAtual === 'Consumível') {
    html += `<div class="alx-resumo-card${stats.vencendo ? ' alerta' : ''}"><b>${stats.vencendo}</b><span>Vencendo em ${stats.diasVencendo} dias</span></div>`;
    html += `<div class="alx-resumo-card${stats.vencidos ? ' baixo' : ''}"><b>${stats.vencidos}</b><span>Lotes vencidos</span></div>`;
  }
  el.innerHTML = html;
}

function setupFiltros() {
  document.getElementById('search-itens').addEventListener('input', () => {
    clearTimeout(buscaDebounce);
    buscaDebounce = setTimeout(loadItens, 350);
  });
  document.getElementById('filtro-localizacao').addEventListener('change', loadItens);
  document.getElementById('filtro-baixo-estoque').addEventListener('change', (e) => {
    if (e.target.checked) document.getElementById('filtro-vencimento').checked = false;
    loadItens();
  });
  document.getElementById('filtro-vencimento').addEventListener('change', (e) => {
    if (e.target.checked) document.getElementById('filtro-baixo-estoque').checked = false;
    loadItens();
  });
}

function statusVencimento(item) {
  if (!item.proximaValidade) return null;
  const hoje = new Date().toISOString().slice(0, 10);
  const limite = new Date(Date.now() + DIAS_VENCENDO * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (item.proximaValidade < hoje) return 'vencido';
  if (item.proximaValidade <= limite) return 'vencendo';
  return null;
}

function renderItens(lista, hasMore) {
  const container = document.getElementById('itens-list');
  container.innerHTML = '';

  if (!lista.length) {
    container.innerHTML = '<div class="empty-state"><p>Nenhum item encontrado.</p></div>';
    return;
  }

  lista.forEach(item => {
    const baixo = item.estoqueMinimo > 0 && item.quantidade <= item.estoqueMinimo;
    const vencimento = statusVencimento(item);
    const card = document.createElement('div');
    card.className = `item-card${baixo ? ' baixo' : ''}`;
    card.innerHTML = `
      <div class="item-card-nome">${esc(item.nome)}</div>
      <div class="item-card-local">${esc(item.localizacao)}</div>
      <div class="item-card-qtd"><span class="num">${item.quantidade}</span><span class="unid">${esc(item.unidade)}</span></div>
      ${item.estoqueMinimo > 0 ? `<div class="item-card-min">Estoque mínimo: ${item.estoqueMinimo}</div>` : ''}
      ${baixo ? '<span class="badge-baixo">⚠ Estoque baixo</span>' : ''}
      ${vencimento === 'vencido' ? '<span class="badge-baixo">⏰ Lote vencido</span>' : ''}
      ${vencimento === 'vencendo' ? '<span class="badge-vencendo">⏳ Vencendo</span>' : ''}
      ${item.categoria === 'Permanente' && item.conferidoEm ? `<div class="item-card-conf">Conferido em ${new Date(item.conferidoEm).toLocaleDateString('pt-BR')}</div>` : ''}
      <div class="item-card-actions action-execute">
        <button class="btn-mov" data-acao="mov">Movimentar</button>
        ${item.categoria === 'Permanente' ? '<button data-acao="conferir">Conferir</button>' : ''}
        <button data-acao="editar">Editar</button>
        <button class="btn-excluir" data-acao="excluir">Excluir</button>
      </div>
    `;
    card.querySelector('[data-acao="mov"]')?.addEventListener('click', () => abrirModalMovimentacao(item));
    card.querySelector('[data-acao="conferir"]')?.addEventListener('click', () => abrirModalConferencia(item));
    card.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirModalItem(item));
    card.querySelector('[data-acao="excluir"]').addEventListener('click', () => excluirItem(item));
    container.appendChild(card);
  });

  if (hasMore) {
    const btnWrap = document.createElement('div');
    btnWrap.className = 'alx-carregar-mais';
    btnWrap.innerHTML = '<button type="button" class="btn-secondary" id="btn-carregar-mais">Carregar mais</button>';
    btnWrap.querySelector('button').addEventListener('click', () => carregarPagina(false));
    container.appendChild(btnWrap);
  }
}

// ==========================================
// MODAL: NOVO / EDITAR ITEM
// ==========================================

function setupModalItem() {
  const modal = document.getElementById('modal-item');
  document.getElementById('btn-novo-item').addEventListener('click', () => abrirModalItem(null));
  document.getElementById('btn-cancelar-item').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.getElementById('form-item').addEventListener('submit', salvarItem);
}

function abrirModalItem(item) {
  document.getElementById('form-item').reset();
  const editando = !!item;
  const categoria = editando ? item.categoria : categoriaAtual;
  document.getElementById('item-id').value = editando ? item.id : '';
  document.getElementById('item-categoria').value = categoria;
  document.getElementById('item-nome').value = editando ? item.nome : '';
  document.getElementById('item-unidade').value = editando ? item.unidade : '';
  document.getElementById('item-localizacao').value = editando ? item.localizacao : '';
  document.getElementById('item-estoque-minimo').value = editando ? item.estoqueMinimo : '';
  document.getElementById('item-observacao').value = editando ? (item.observacao || '') : '';
  document.getElementById('modal-item-title').textContent = editando ? `Editar ${categoria === 'Consumível' ? 'Item' : 'Patrimônio'}` : `Novo ${categoria === 'Consumível' ? 'Item Consumível' : 'Item de Patrimônio'}`;
  document.getElementById('btn-salvar-item').textContent = editando ? 'Salvar alterações' : 'Cadastrar';

  // Quantidade/validade iniciais só existem no cadastro
  document.getElementById('grupo-qtd-inicial').classList.toggle('hidden', editando);
  document.getElementById('grupo-validade-inicial').classList.toggle('hidden', editando || categoria !== 'Consumível');
  document.getElementById('modal-item').classList.remove('hidden');
  document.getElementById('item-nome').focus();
}

async function salvarItem(e) {
  e.preventDefault();
  const id = document.getElementById('item-id').value;
  const categoria = document.getElementById('item-categoria').value;
  const btn = document.getElementById('btn-salvar-item');
  const dados = {
    nome: document.getElementById('item-nome').value.trim(),
    categoria,
    unidade: document.getElementById('item-unidade').value.trim(),
    localizacao: document.getElementById('item-localizacao').value,
    estoqueMinimo: document.getElementById('item-estoque-minimo').value || 0,
    observacao: document.getElementById('item-observacao').value.trim()
  };
  if (!id) {
    dados.quantidadeInicial = document.getElementById('item-qtd-inicial').value || 0;
    if (categoria === 'Consumível') {
      dados.validadeInicial = document.getElementById('item-validade-inicial').value || null;
    }
  }

  btn.disabled = true;
  btn.textContent = id ? 'Salvando...' : 'Cadastrando...';
  try {
    if (id) {
      await apiFetch(`/almoxarifado-saude/itens/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
      showToast('Item atualizado');
    } else {
      await apiFetch('/almoxarifado-saude/itens', { method: 'POST', body: JSON.stringify(dados) });
      showToast('Item cadastrado');
    }
    document.getElementById('modal-item').classList.add('hidden');
    await Promise.all([loadItens(), loadStats()]);
  } catch (err) {
    showToast('Erro ao salvar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Salvar alterações' : 'Cadastrar';
  }
}

async function excluirItem(item) {
  if (!confirm(`Excluir "${item.nome}" e todo o seu histórico de lotes/movimentações? Essa ação não tem volta.`)) return;
  try {
    await apiFetch(`/almoxarifado-saude/itens/${item.id}`, { method: 'DELETE' });
    showToast('Item excluído');
    await Promise.all([loadItens(), loadStats()]);
  } catch (err) {
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

// ==========================================
// MODAL: CONFERÊNCIA (Patrimônio — ajuste direto de quantidade)
// ==========================================

function setupModalConferencia() {
  const modal = document.getElementById('modal-conferencia');
  document.getElementById('btn-cancelar-conferencia').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.getElementById('form-conferencia').addEventListener('submit', salvarConferencia);
}

let itemConferenciaAtual = null;

function abrirModalConferencia(item) {
  itemConferenciaAtual = item;
  document.getElementById('modal-conferencia-title').textContent = `Conferir — ${item.nome}`;
  document.getElementById('conf-item-id').value = item.id;
  document.getElementById('conf-quantidade').value = item.quantidade;
  document.getElementById('conf-ultima-info').textContent = item.conferidoEm
    ? `Última conferência: ${new Date(item.conferidoEm).toLocaleString('pt-BR')}`
    : 'Ainda sem conferência registrada.';
  document.getElementById('modal-conferencia').classList.remove('hidden');
  document.getElementById('conf-quantidade').focus();
}

async function salvarConferencia(e) {
  e.preventDefault();
  const id = document.getElementById('conf-item-id').value;
  const quantidade = document.getElementById('conf-quantidade').value;
  const btn = document.getElementById('btn-salvar-conferencia');
  btn.disabled = true;
  btn.textContent = 'Salvando...';
  try {
    await apiFetch(`/almoxarifado-saude/itens/${id}/conferencia`, { method: 'PATCH', body: JSON.stringify({ quantidade }) });
    showToast('Conferência registrada');
    document.getElementById('modal-conferencia').classList.add('hidden');
    await Promise.all([loadItens(), loadStats()]);
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar';
  }
}

// ==========================================
// MODAL: MOVIMENTAÇÃO (Consumível — entrada/saída + lotes + histórico)
// ==========================================

function setupModalMovimentacao() {
  const modal = document.getElementById('modal-mov');
  document.getElementById('btn-fechar-mov').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('btn-tipo-entrada').addEventListener('click', () => selecionarTipoMov('entrada'));
  document.getElementById('btn-tipo-saida').addEventListener('click', () => selecionarTipoMov('saida'));
  document.getElementById('btn-entrada-novo-lote').addEventListener('click', () => selecionarModoEntrada('novo'));
  document.getElementById('btn-entrada-lote-existente').addEventListener('click', () => selecionarModoEntrada('existente'));
  document.getElementById('form-mov').addEventListener('submit', registrarMovimentacao);
}

function selecionarTipoMov(tipo) {
  tipoMovAtual = tipo;
  document.getElementById('btn-tipo-entrada').classList.toggle('on', tipo === 'entrada');
  document.getElementById('btn-tipo-saida').classList.toggle('on', tipo === 'saida');
  document.getElementById('grupo-lote-saida').classList.toggle('hidden', tipo !== 'saida');
  document.getElementById('grupo-lote-entrada-modo').classList.toggle('hidden', tipo !== 'entrada');
  document.getElementById('grupo-novo-lote').classList.toggle('hidden', !(tipo === 'entrada' && modoEntradaAtual === 'novo'));
  document.getElementById('grupo-lote-entrada-existente').classList.toggle('hidden', !(tipo === 'entrada' && modoEntradaAtual === 'existente'));
}

function selecionarModoEntrada(modo) {
  modoEntradaAtual = modo;
  document.getElementById('btn-entrada-novo-lote').classList.toggle('on', modo === 'novo');
  document.getElementById('btn-entrada-lote-existente').classList.toggle('on', modo === 'existente');
  document.getElementById('grupo-novo-lote').classList.toggle('hidden', modo !== 'novo');
  document.getElementById('grupo-lote-entrada-existente').classList.toggle('hidden', modo !== 'existente');
}

async function abrirModalMovimentacao(item) {
  itemAtual = item;
  tipoMovAtual = 'entrada';
  modoEntradaAtual = 'novo';
  selecionarTipoMov('entrada');
  selecionarModoEntrada('novo');

  document.getElementById('mov-item-id').value = item.id;
  document.getElementById('mov-quantidade').value = '';
  document.getElementById('mov-motivo').value = '';
  document.getElementById('mov-lote-nome').value = '';
  document.getElementById('mov-validade').value = '';
  document.getElementById('mov-disponivel').value = `${item.quantidade} ${item.unidade}`;
  document.getElementById('modal-mov-title').textContent = `Movimentar — ${item.nome}`;
  document.getElementById('modal-mov').classList.remove('hidden');

  const lotesEl = document.getElementById('mov-lotes-atuais');
  const listaEl = document.getElementById('mov-lista');
  listaEl.innerHTML = '<p class="mov-vazio">Carregando histórico...</p>';

  // Patrimônio não usa lote — evita a chamada e o toggle "novo lote"/"lote existente"
  if (item.categoria === 'Permanente') {
    lotesAtuais = [];
    try {
      historicoAtual = await apiFetch(`/almoxarifado-saude/itens/${item.id}/movimentacoes`);
      renderHistorico(historicoAtual);
    } catch (err) {
      listaEl.innerHTML = `<p class="mov-vazio">Erro ao carregar histórico: ${esc(err.message)}</p>`;
    }
    return;
  }

  lotesEl.innerHTML = '<p class="mov-vazio">Carregando lotes...</p>';
  try {
    const [lotes, historico] = await Promise.all([
      apiFetch(`/almoxarifado-saude/itens/${item.id}/lotes`),
      apiFetch(`/almoxarifado-saude/itens/${item.id}/movimentacoes`)
    ]);
    lotesAtuais = lotes;
    historicoAtual = historico;
    renderLotesAtuais(lotesAtuais);
    preencherSelectsLote(lotesAtuais);
    renderHistorico(historicoAtual);
  } catch (err) {
    lotesEl.innerHTML = `<p class="mov-vazio">Erro ao carregar lotes: ${esc(err.message)}</p>`;
    listaEl.innerHTML = '';
  }
}

function fmtValidade(validade) {
  if (!validade) return 'sem validade';
  return `val. ${validade.split('-').reverse().join('/')}`;
}

function renderLotesAtuais(lotes) {
  const el = document.getElementById('mov-lotes-atuais');
  if (!lotes.length) {
    el.innerHTML = '<p class="mov-vazio">Nenhum lote em estoque.</p>';
    return;
  }
  el.innerHTML = lotes.map(l => `
    <div class="mov-lote-row">
      <span class="mov-lote-nome">${esc(l.lote)}</span>
      <span class="mov-lote-info">${l.quantidade} · ${esc(fmtValidade(l.validade))}</span>
    </div>
  `).join('');
}

function preencherSelectsLote(lotes) {
  const opcoes = lotes.map(l => `<option value="${l.id}">${esc(l.lote)} — ${l.quantidade} (${esc(fmtValidade(l.validade))})</option>`).join('');
  document.getElementById('mov-lote-saida').innerHTML = opcoes || '<option value="">Nenhum lote disponível</option>';
  document.getElementById('mov-lote-entrada').innerHTML = opcoes || '<option value="">Nenhum lote existente</option>';
}

function renderHistorico(historico) {
  const listaEl = document.getElementById('mov-lista');
  if (!historico.length) {
    listaEl.innerHTML = '<p class="mov-vazio">Nenhuma movimentação registrada.</p>';
    return;
  }
  listaEl.innerHTML = historico.map(m => {
    const quando = new Date(m.realizadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    const sinal = m.tipo === 'entrada' ? '+' : '−';
    return `<div class="mov-row ${m.tipo}">
      <span class="mov-sinal">${sinal}${m.quantidade}</span>
      <span class="mov-info">${esc(m.motivo)} <span class="mov-lote-tag">${esc(m.lote || '')}</span><br><span class="mov-meta">${esc(quando)}</span></span>
    </div>`;
  }).join('');
}

async function registrarMovimentacao(e) {
  e.preventDefault();
  if (!itemAtual) return;
  const btn = document.getElementById('btn-registrar-mov');
  const quantidade = document.getElementById('mov-quantidade').value;
  const motivo = document.getElementById('mov-motivo').value.trim();

  const body = { tipo: tipoMovAtual, quantidade, motivo };

  // Patrimônio não usa lote — só entrada/saída direta
  if (itemAtual.categoria === 'Permanente') {
    if (tipoMovAtual === 'saida' && Number(quantidade) > itemAtual.quantidade) {
      showToast(`Estoque insuficiente: há ${itemAtual.quantidade} ${itemAtual.unidade} disponível(is).`, 'error');
      return;
    }
  } else if (tipoMovAtual === 'saida') {
    body.loteId = document.getElementById('mov-lote-saida').value;
    if (!body.loteId) {
      showToast('Não há lote disponível para dar saída.', 'error');
      return;
    }
  } else if (modoEntradaAtual === 'existente') {
    body.loteId = document.getElementById('mov-lote-entrada').value;
    if (!body.loteId) {
      showToast('Escolha um lote existente ou cadastre um novo.', 'error');
      return;
    }
  } else {
    body.loteNome = document.getElementById('mov-lote-nome').value.trim();
    body.validade = document.getElementById('mov-validade').value || null;
  }

  btn.disabled = true;
  btn.textContent = 'Registrando...';
  try {
    const resp = await apiFetch(`/almoxarifado-saude/itens/${itemAtual.id}/movimentacoes`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    itemAtual.quantidade = resp.quantidadeItem;
    document.getElementById('mov-disponivel').value = `${resp.quantidadeItem} ${itemAtual.unidade}`;
    document.getElementById('mov-quantidade').value = '';
    document.getElementById('mov-motivo').value = '';
    document.getElementById('mov-lote-nome').value = '';
    document.getElementById('mov-validade').value = '';
    showToast(tipoMovAtual === 'entrada' ? 'Entrada registrada' : 'Saída registrada');

    const itemNaLista = itens.find(it => it.id === itemAtual.id);
    if (itemNaLista) itemNaLista.quantidade = resp.quantidadeItem;
    renderItens(itens, hasMaisAtual);

    // Recarrega lotes (só Consumível) e histórico do item (mudou de verdade, precisa da fonte)
    if (itemAtual.categoria === 'Permanente') {
      historicoAtual = await apiFetch(`/almoxarifado-saude/itens/${itemAtual.id}/movimentacoes`);
    } else {
      const [lotes, historico] = await Promise.all([
        apiFetch(`/almoxarifado-saude/itens/${itemAtual.id}/lotes`),
        apiFetch(`/almoxarifado-saude/itens/${itemAtual.id}/movimentacoes`)
      ]);
      lotesAtuais = lotes;
      historicoAtual = historico;
      renderLotesAtuais(lotesAtuais);
      preencherSelectsLote(lotesAtuais);
    }
    renderHistorico(historicoAtual);
    await loadStats();
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Registrar';
  }
}

// ==========================================
// RELATÓRIO: ESTOQUE (relatorio-estoque.html)
// ==========================================

async function initPaginaRelatorioEstoque() {
  const msg = document.getElementById('relatorio-estoque-msg');
  const btnImprimir = document.getElementById('btn-imprimir-relatorio-estoque');
  const params = new URLSearchParams(window.location.search);
  const categoria = params.get('categoria') === 'Permanente' ? 'Permanente' : 'Consumível';

  try {
    const itensTodos = await apiFetch(`/almoxarifado-saude/relatorio-estoque?categoria=${encodeURIComponent(categoria)}`);
    renderRelatorioEstoque(itensTodos, categoria);
    msg.classList.add('hidden');
    btnImprimir.disabled = false;
    btnImprimir.addEventListener('click', () => window.print());
  } catch (err) {
    msg.innerHTML = `<p class="hint" style="margin:0; color:#b3453c">Erro ao carregar relatório: ${esc(err.message)}</p>`;
  }
}

function renderRelatorioEstoque(itensTodos, categoria) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const total = itensTodos.length;
  const baixo = itensTodos.filter(it => it.estoqueMinimo > 0 && it.quantidade <= it.estoqueMinimo).length;

  // Agrupa por localização, na mesma lógica do levantamento físico original (por sala/laboratório)
  const porLocal = {};
  itensTodos.forEach(it => {
    const loc = it.localizacao || 'Sem localização';
    (porLocal[loc] = porLocal[loc] || []).push(it);
  });
  const locaisOrdenados = Object.keys(porLocal).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  const colunaValidade = categoria === 'Consumível';
  const secoes = locaisOrdenados.map(loc => {
    const linhas = porLocal[loc]
      .slice()
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map(it => {
        const emBaixo = it.estoqueMinimo > 0 && it.quantidade <= it.estoqueMinimo;
        const vencimento = statusVencimento(it);
        return `
          <tr>
            <td>${esc(it.nome)}</td>
            <td>${esc(it.unidade)}</td>
            <td>${it.quantidade}</td>
            <td>${it.estoqueMinimo > 0 ? it.estoqueMinimo : '—'}</td>
            ${colunaValidade ? `<td>${it.proximaValidade ? esc(it.proximaValidade.split('-').reverse().join('/')) : '—'}</td>` : ''}
            <td>${emBaixo ? '<span class="rel-badge-baixo">⚠ Baixo</span>' : (vencimento === 'vencido' ? '<span class="rel-badge-baixo">⏰ Vencido</span>' : (vencimento === 'vencendo' ? '<span class="rel-badge-baixo">⏳ Vencendo</span>' : 'OK'))}</td>
          </tr>`;
      }).join('');

    return `
      <h2 class="rel-secao">${esc(loc)} (${porLocal[loc].length})</h2>
      <table class="rel-tabela">
        <thead><tr><th>Item</th><th>Unidade</th><th>Quantidade</th><th>Mínimo</th>${colunaValidade ? '<th>Próx. validade</th>' : ''}<th>Status</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>`;
  }).join('');

  document.getElementById('relatorio-estoque-conteudo').innerHTML = `
    <div class="rel-cabecalho">
      <img src="/img/fateclogoazul.png" alt="Fatec Ivaiporã" class="rel-logo">
      <div class="rel-titulo">
        <h1>Relatório de Estoque — Almoxarifado Saúde (${esc(categoria)})</h1>
        <p>Setor de Saúde · FATEC Ivaiporã</p>
      </div>
      <div class="rel-data-emissao">Emitido em ${hoje}</div>
    </div>

    <div class="rel-resumo">
      <div class="rel-resumo-card"><b>${total}</b><span>Item${total === 1 ? '' : 's'} cadastrado${total === 1 ? '' : 's'}</span></div>
      <div class="rel-resumo-card"><b>${baixo}</b><span>Com estoque baixo</span></div>
      <div class="rel-resumo-card"><b>${locaisOrdenados.length}</b><span>Localizaç${locaisOrdenados.length === 1 ? 'ão' : 'ões'}</span></div>
    </div>

    ${secoes || '<p class="rel-vazio">Nenhum item cadastrado nesta categoria.</p>'}
  `;
}

// ==========================================
// TERMO DE EMPRÉSTIMO (termo-emprestimo.html)
// ==========================================

async function initPaginaTermoEmprestimo() {
  const msg = document.getElementById('termo-emprestimo-msg');
  const btnImprimir = document.getElementById('btn-imprimir-termo');
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');

  if (!id) {
    msg.innerHTML = '<p class="hint" style="margin:0; color:#b3453c">Reserva não informada.</p>';
    return;
  }

  try {
    const ag = await apiFetch(`/almoxarifado-saude/agendamentos/${id}`);
    renderTermoEmprestimo(ag);
    msg.classList.add('hidden');
    btnImprimir.disabled = false;
    btnImprimir.addEventListener('click', () => window.print());
  } catch (err) {
    msg.innerHTML = `<p class="hint" style="margin:0; color:#b3453c">Erro ao carregar reserva: ${esc(err.message)}</p>`;
  }
}

function renderTermoEmprestimo(ag) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  document.getElementById('termo-emprestimo-conteudo').innerHTML = `
    <div class="rel-cabecalho">
      <img src="/img/fateclogoazul.png" alt="Fatec Ivaiporã" class="rel-logo">
      <div class="rel-titulo">
        <h1>Termo de Responsabilidade para Empréstimo de Materiais</h1>
        <p>Mantida pela União de Ensino Superior do Vale do Ivaí Ltda - UNESVI</p>
      </div>
      <div class="rel-data-emissao">Emitido em ${hoje}</div>
    </div>

    <table class="rel-tabela termo-tabela">
      <tr><th>Solicitante</th><td colspan="3">${esc(ag.responsavel)}</td></tr>
      <tr><th>Curso</th><td>&nbsp;</td><th>Telefone</th><td>&nbsp;</td></tr>
      <tr><th>Objetivo de uso</th><td colspan="3">${esc(ag.motivo) || '&nbsp;'}</td></tr>
      <tr><th>Data da retirada</th><td>${fmtDataBr(ag.data)} às ${esc(ag.horaInicio)}</td><th>Data da devolução</th><td>${fmtDataBr(ag.data)} às ${esc(ag.horaFim)}</td></tr>
      <tr><th>Local de uso</th><td colspan="3">${esc(ag.sala)}</td></tr>
      <tr><th>Cidade</th><td colspan="3">Ivaiporã / Paraná</td></tr>
    </table>

    <h2 class="rel-secao">Laboratório de Origem / Material Solicitado</h2>
    <table class="rel-tabela termo-tabela-material">
      <thead><tr><th>Laboratório de Origem</th><th>Material Solicitado</th></tr></thead>
      <tbody>
        ${Array.from({ length: 6 }).map(() => '<tr><td>&nbsp;</td><td>&nbsp;</td></tr>').join('')}
      </tbody>
    </table>

    <p class="termo-declaracao">
      Declaro utilizar com cuidado e zelo o equipamento solicitado, entregando-o da maneira que foi retirado.
      Declaro, ainda, que caso haja danos ou avarias no mesmo irei arcar com os gastos para conserto ou para a
      aquisição de um novo equipamento.
    </p>
    <p class="termo-declaracao"><b>Afirmo ter verificado, antes da retirada, que o equipamento se encontrava:</b></p>
    <p class="termo-checkbox">( &nbsp; ) em perfeitas condições de uso e bom estado de conservação</p>
    <p class="termo-checkbox">( &nbsp; ) com os seguintes problemas ou danos:</p>
    <div class="termo-linha"></div>
    <div class="termo-linha"></div>

    <p class="termo-declaracao" style="text-align:center; margin-top:22px;">Firmo o presente, confirmando com a minha assinatura.</p>

    <table class="rel-tabela termo-assinaturas">
      <tr class="termo-assinaturas-linha">
        <td>&nbsp;</td>
        <td>&nbsp;</td>
        <td>&nbsp;</td>
      </tr>
      <tr>
        <td>Solicitante</td>
        <td>Supervisão Administrativa</td>
        <td>Responsável Técnico dos Laboratórios</td>
      </tr>
    </table>
  `;
}

// ==========================================
// RELATÓRIO: MOVIMENTAÇÕES (relatorio-movimentacoes.html)
// ==========================================

function initPaginaRelatorioMovimentacoes() {
  const hoje = new Date();
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0, 10);
  const fimHoje = hoje.toISOString().slice(0, 10);
  document.getElementById('mov-filtro-inicio').value = inicioMes;
  document.getElementById('mov-filtro-fim').value = fimHoje;

  document.getElementById('btn-gerar-relatorio-mov').addEventListener('click', gerarRelatorioMovimentacoes);
  document.getElementById('btn-imprimir-relatorio-mov').addEventListener('click', () => window.print());
}

async function gerarRelatorioMovimentacoes() {
  const msg = document.getElementById('relatorio-movimentacoes-msg');
  const btnImprimir = document.getElementById('btn-imprimir-relatorio-mov');
  const inicio = document.getElementById('mov-filtro-inicio').value;
  const fim = document.getElementById('mov-filtro-fim').value;

  if (!inicio || !fim) {
    showToast('Escolha o período (início e fim)', 'error');
    return;
  }

  btnImprimir.disabled = true;
  msg.classList.remove('hidden');
  msg.innerHTML = '<p class="hint" style="margin:0">Gerando relatório...</p>';
  try {
    const movimentacoes = await apiFetch(`/almoxarifado-saude/movimentacoes?inicio=${inicio}&fim=${fim}`);
    renderRelatorioMovimentacoes(movimentacoes, inicio, fim);
    msg.classList.add('hidden');
    btnImprimir.disabled = false;
  } catch (err) {
    msg.innerHTML = `<p class="hint" style="margin:0; color:#b3453c">Erro ao gerar relatório: ${esc(err.message)}</p>`;
  }
}

function renderRelatorioMovimentacoes(movimentacoes, inicio, fim) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const entradas = movimentacoes.filter(m => m.tipo === 'entrada');
  const saidas = movimentacoes.filter(m => m.tipo === 'saida');
  const totalEntradas = entradas.reduce((s, m) => s + m.quantidade, 0);
  const totalSaidas = saidas.reduce((s, m) => s + m.quantidade, 0);
  const periodo = `${fmtDataBr(inicio)} a ${fmtDataBr(fim)}`;

  const linhas = movimentacoes.map(m => {
    const quando = new Date(m.realizadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `
      <tr>
        <td>${esc(quando)}</td>
        <td>${esc(m.itemNome || '—')}</td>
        <td>${esc(m.lote || '—')}</td>
        <td>${m.tipo === 'entrada' ? 'Entrada' : 'Saída'}</td>
        <td>${m.quantidade}</td>
        <td>${esc(m.motivo || '—')}</td>
      </tr>`;
  }).join('');

  document.getElementById('relatorio-movimentacoes-conteudo').innerHTML = `
    <div class="rel-cabecalho">
      <img src="/img/fateclogoazul.png" alt="Fatec Ivaiporã" class="rel-logo">
      <div class="rel-titulo">
        <h1>Relatório de Movimentações — Almoxarifado Saúde</h1>
        <p>Setor de Saúde · FATEC Ivaiporã · Período: ${periodo}</p>
      </div>
      <div class="rel-data-emissao">Emitido em ${hoje}</div>
    </div>

    <div class="rel-resumo">
      <div class="rel-resumo-card"><b>${entradas.length}</b><span>Entradas (${totalEntradas})</span></div>
      <div class="rel-resumo-card"><b>${saidas.length}</b><span>Saídas (${totalSaidas})</span></div>
      <div class="rel-resumo-card"><b>${totalEntradas - totalSaidas}</b><span>Saldo do período</span></div>
    </div>

    <h2 class="rel-secao">Movimentações (${movimentacoes.length})</h2>
    <table class="rel-tabela">
      <thead><tr><th>Data</th><th>Item</th><th>Lote</th><th>Tipo</th><th>Quantidade</th><th>Motivo</th></tr></thead>
      <tbody>${linhas || `<tr><td colspan="6" class="rel-vazio">Nenhuma movimentação no período.</td></tr>`}</tbody>
    </table>
  `;
}

function fmtDataBr(iso) {
  return iso ? iso.split('-').reverse().join('/') : '—';
}

// ==========================================
// AGENDAMENTO (aba Agendamento — reserva de salas/laboratórios)
// ==========================================

async function loadSalas() {
  try {
    salas = await apiFetch('/almoxarifado-saude/salas');
  } catch (err) {
    salas = [];
  }
  const opcoes = salas.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  document.getElementById('filtro-sala').innerHTML = '<option value="">Todas as salas</option>' + opcoes;
  document.getElementById('reserva-sala').innerHTML = opcoes;
}

async function loadAgendamentos() {
  const lista = document.getElementById('agendamentos-list');
  lista.innerHTML = '<div class="empty-state"><p>Carregando reservas...</p></div>';
  try {
    const sala = document.getElementById('filtro-sala').value;
    const data = document.getElementById('filtro-data-agenda').value;
    const params = new URLSearchParams();
    if (sala) params.set('sala', sala);
    if (data) params.set('data', data);
    const resp = await apiFetch(`/almoxarifado-saude/agendamentos?${params.toString()}`);
    renderAgendamentos(resp);
  } catch (err) {
    lista.innerHTML = `<div class="empty-state"><p>Erro ao carregar: ${esc(err.message)}</p></div>`;
  }
}

function renderAgendamentos(lista) {
  const container = document.getElementById('agendamentos-list');
  container.innerHTML = '';

  if (!lista.length) {
    container.innerHTML = '<div class="empty-state"><p>Nenhuma reserva encontrada.</p></div>';
    return;
  }

  lista.forEach(ag => {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.innerHTML = `
      <div class="item-card-nome">${esc(ag.sala)}</div>
      <div class="item-card-local">${fmtDataBr(ag.data)} · ${esc(ag.horaInicio)}–${esc(ag.horaFim)}</div>
      <div class="item-card-min">Responsável: ${esc(ag.responsavel)}</div>
      ${ag.motivo ? `<div class="item-card-min">${esc(ag.motivo)}</div>` : ''}
      <div class="item-card-actions">
        <a href="/saude/almoxarifado-saude/termo-emprestimo?id=${encodeURIComponent(ag.id)}" target="_blank" class="btn-mov">Imprimir Termo</a>
        <button class="action-execute" data-acao="editar">Editar</button>
        <button class="btn-excluir action-execute" data-acao="cancelar">Cancelar</button>
      </div>
    `;
    card.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirModalReserva(ag));
    card.querySelector('[data-acao="cancelar"]').addEventListener('click', () => cancelarReserva(ag));
    container.appendChild(card);
  });
}

function setupModalReserva() {
  const modal = document.getElementById('modal-reserva');
  document.getElementById('btn-nova-reserva').addEventListener('click', () => abrirModalReserva(null));
  document.getElementById('btn-cancelar-reserva').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.getElementById('form-reserva').addEventListener('submit', salvarReserva);
  document.getElementById('filtro-sala').addEventListener('change', loadAgendamentos);
  document.getElementById('filtro-data-agenda').addEventListener('change', loadAgendamentos);
}

function abrirModalReserva(ag) {
  document.getElementById('form-reserva').reset();
  const editando = !!ag;
  document.getElementById('modal-reserva-title').textContent = editando ? 'Editar Reserva' : 'Nova Reserva';
  document.getElementById('btn-salvar-reserva').textContent = editando ? 'Salvar alterações' : 'Reservar';
  document.getElementById('reserva-id').value = editando ? ag.id : '';

  const salaFiltrada = document.getElementById('filtro-sala').value;
  document.getElementById('reserva-sala').value = editando ? ag.sala : salaFiltrada;
  document.getElementById('reserva-data').value = editando ? ag.data : '';
  document.getElementById('reserva-hora-inicio').value = editando ? ag.horaInicio : '';
  document.getElementById('reserva-hora-fim').value = editando ? ag.horaFim : '';
  document.getElementById('reserva-responsavel').value = editando ? ag.responsavel : '';
  document.getElementById('reserva-motivo').value = editando ? (ag.motivo || '') : '';

  document.getElementById('modal-reserva').classList.remove('hidden');
}

async function salvarReserva(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-salvar-reserva');
  btn.disabled = true;
  const id = document.getElementById('reserva-id').value;
  try {
    const dados = {
      sala: document.getElementById('reserva-sala').value,
      data: document.getElementById('reserva-data').value,
      horaInicio: document.getElementById('reserva-hora-inicio').value,
      horaFim: document.getElementById('reserva-hora-fim').value,
      responsavel: document.getElementById('reserva-responsavel').value,
      motivo: document.getElementById('reserva-motivo').value
    };
    if (id) {
      await apiFetch(`/almoxarifado-saude/agendamentos/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
      showToast('Reserva atualizada com sucesso!');
    } else {
      await apiFetch('/almoxarifado-saude/agendamentos', { method: 'POST', body: JSON.stringify(dados) });
      showToast('Sala reservada com sucesso!');
    }
    document.getElementById('modal-reserva').classList.add('hidden');
    await loadAgendamentos();
  } catch (err) {
    showToast('Erro ao salvar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function cancelarReserva(ag) {
  if (!confirm(`Cancelar a reserva de "${ag.sala}" em ${fmtDataBr(ag.data)} (${ag.horaInicio}–${ag.horaFim})?`)) return;
  try {
    await apiFetch(`/almoxarifado-saude/agendamentos/${ag.id}`, { method: 'DELETE' });
    showToast('Reserva cancelada');
    await loadAgendamentos();
  } catch (err) {
    showToast('Erro ao cancelar: ' + err.message, 'error');
  }
}

// ==========================================
// TOAST
// ==========================================

let toastTimer = null;
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}
