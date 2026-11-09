import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';
import { getEffectiveLevel } from '../../core/permissions.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

let currentUser = null;
let currentRole = null;
let userLevel = 1;
let appInitialized = false;
let initializedRole = null;

let itens = [];
let itemAtual = null;   // item sendo movimentado no modal de movimentação
let tipoMovAtual = 'entrada';
let historicoAtual = []; // histórico do item aberto no modal de movimentação (em memória)

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
        // nível efetivo = permissão individual do usuário (users/{uid}.permissoes) vence a do cargo (09/11/2026)
        const [perms, eu] = await Promise.all([
          apiFetch('/usuarios/config/permissions'),
          apiFetch('/usuarios/me').catch(() => null)
        ]);
        level = getEffectiveLevel(perms[role] || {}, eu && eu.permissoes, 'almoxarifado-feridas');
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

  setupLayout(user, role, 'almoxarifado-feridas', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');

  // relatorio-estoque.html e relatorio-movimentacoes.html reaproveitam este
  // app.js só pra auth/layout + a própria tela (mesmo padrão do módulo Ferida)
  if (document.getElementById('relatorio-estoque-conteudo')) {
    initPaginaRelatorioEstoque();
    return;
  }
  if (document.getElementById('relatorio-movimentacoes-conteudo')) {
    initPaginaRelatorioMovimentacoes();
    return;
  }

  setupFiltros();
  setupModalItem();
  setupModalMovimentacao();
  await loadItens();
}

// ==========================================
// ITENS
// ==========================================

async function loadItens() {
  const lista = document.getElementById('itens-list');
  try {
    lista.innerHTML = '<div class="empty-state"><p>Carregando materiais...</p></div>';
    itens = await apiFetch('/almoxarifado-feridas/itens');
    aplicarFiltros();
    renderResumo();
  } catch (err) {
    lista.innerHTML = `<div class="empty-state"><p>Erro ao carregar: ${esc(err.message)}</p></div>`;
  }
}

// Resumo do que está cadastrado — só conta o array `itens` já carregado em
// memória, sem nenhuma leitura extra no Firestore.
function renderResumo() {
  const el = document.getElementById('alx-resumo');
  if (!el) return;
  const total = itens.length;
  const baixo = itens.filter(it => it.quantidadeAtual <= it.estoqueMinimo).length;
  el.innerHTML = `
    <div class="alx-resumo-card"><b>${total}</b><span>Material${total === 1 ? '' : 'is'} cadastrado${total === 1 ? '' : 's'}</span></div>
    <div class="alx-resumo-card${baixo ? ' baixo' : ''}"><b>${baixo}</b><span>Com estoque baixo</span></div>
  `;
}

function setupFiltros() {
  document.getElementById('search-itens')?.addEventListener('input', aplicarFiltros);
  document.getElementById('filtro-baixo-estoque')?.addEventListener('change', aplicarFiltros);
}

function aplicarFiltros() {
  const query = (document.getElementById('search-itens')?.value || '').toLowerCase();
  const soBaixo = document.getElementById('filtro-baixo-estoque')?.checked;

  const filtrados = itens.filter(it => {
    const matchQuery = !query || it.nome.toLowerCase().includes(query);
    const matchBaixo = !soBaixo || (it.quantidadeAtual <= it.estoqueMinimo);
    return matchQuery && matchBaixo;
  });
  renderItens(filtrados);
}

function renderItens(lista) {
  const container = document.getElementById('itens-list');
  container.innerHTML = '';

  if (!lista.length) {
    container.innerHTML = `<div class="empty-state"><p>${itens.length ? 'Nenhum material corresponde ao filtro.' : 'Nenhum material cadastrado ainda.'}</p></div>`;
    return;
  }

  lista.forEach(item => {
    const baixo = item.quantidadeAtual <= item.estoqueMinimo;
    const card = document.createElement('div');
    card.className = `item-card${baixo ? ' baixo' : ''}`;
    card.innerHTML = `
      <div class="item-card-nome">${esc(item.nome)}</div>
      <div class="item-card-qtd"><span class="num">${item.quantidadeAtual}</span><span class="unid">${esc(item.unidade)}</span></div>
      <div class="item-card-min">Estoque mínimo: ${item.estoqueMinimo}</div>
      ${baixo ? '<span class="badge-baixo">⚠ Estoque baixo</span>' : ''}
      <div class="item-card-actions action-execute">
        <button class="btn-mov" data-acao="mov">Movimentar</button>
        <button data-acao="editar">Editar</button>
        <button class="btn-excluir" data-acao="excluir">Excluir</button>
      </div>
    `;
    card.querySelector('[data-acao="mov"]').addEventListener('click', () => abrirModalMovimentacao(item));
    card.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirModalItem(item));
    card.querySelector('[data-acao="excluir"]').addEventListener('click', () => excluirItem(item));
    container.appendChild(card);
  });
}

// ==========================================
// MODAL: NOVO / EDITAR MATERIAL
// ==========================================

function setupModalItem() {
  const modal = document.getElementById('modal-item');
  document.getElementById('btn-novo-item')?.addEventListener('click', () => abrirModalItem(null));
  document.getElementById('btn-cancelar-item')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.getElementById('form-item')?.addEventListener('submit', salvarItem);
}

function abrirModalItem(item) {
  document.getElementById('form-item').reset();
  const editando = !!item;
  document.getElementById('item-id').value = editando ? item.id : '';
  document.getElementById('item-nome').value = editando ? item.nome : '';
  document.getElementById('item-unidade').value = editando ? item.unidade : '';
  document.getElementById('item-estoque-minimo').value = editando ? item.estoqueMinimo : '';
  document.getElementById('modal-item-title').textContent = editando ? 'Editar Material' : 'Novo Material';
  document.getElementById('btn-salvar-item').textContent = editando ? 'Salvar alterações' : 'Cadastrar';
  // A quantidade inicial só existe no cadastro; depois disso, só via movimentação
  document.getElementById('grupo-qtd-inicial').classList.toggle('hidden', editando);
  document.getElementById('modal-item').classList.remove('hidden');
  document.getElementById('item-nome').focus();
}

async function salvarItem(e) {
  e.preventDefault();
  const id = document.getElementById('item-id').value;
  const btn = document.getElementById('btn-salvar-item');
  const dados = {
    nome: document.getElementById('item-nome').value.trim(),
    unidade: document.getElementById('item-unidade').value.trim(),
    estoqueMinimo: document.getElementById('item-estoque-minimo').value || 0
  };
  if (!id) dados.quantidadeInicial = document.getElementById('item-qtd-inicial').value || 0;

  btn.disabled = true;
  btn.textContent = id ? 'Salvando...' : 'Cadastrando...';
  try {
    if (id) {
      await apiFetch(`/almoxarifado-feridas/itens/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
      showToast('Material atualizado');
    } else {
      await apiFetch('/almoxarifado-feridas/itens', { method: 'POST', body: JSON.stringify(dados) });
      showToast('Material cadastrado');
    }
    document.getElementById('modal-item').classList.add('hidden');
    await loadItens();
  } catch (err) {
    showToast('Erro ao salvar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Salvar alterações' : 'Cadastrar';
  }
}

async function excluirItem(item) {
  if (!confirm(`Excluir "${item.nome}" e todo o seu histórico de movimentações? Essa ação não tem volta.`)) return;
  try {
    await apiFetch(`/almoxarifado-feridas/itens/${item.id}`, { method: 'DELETE' });
    showToast('Material excluído');
    await loadItens();
  } catch (err) {
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

// ==========================================
// MODAL: MOVIMENTAÇÃO (entrada/saída + histórico)
// ==========================================

function setupModalMovimentacao() {
  const modal = document.getElementById('modal-mov');
  document.getElementById('btn-fechar-mov')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('btn-tipo-entrada')?.addEventListener('click', () => selecionarTipoMov('entrada'));
  document.getElementById('btn-tipo-saida')?.addEventListener('click', () => selecionarTipoMov('saida'));
  document.getElementById('form-mov')?.addEventListener('submit', registrarMovimentacao);
}

function selecionarTipoMov(tipo) {
  tipoMovAtual = tipo;
  document.getElementById('btn-tipo-entrada').classList.toggle('on', tipo === 'entrada');
  document.getElementById('btn-tipo-saida').classList.toggle('on', tipo === 'saida');
}

async function abrirModalMovimentacao(item) {
  itemAtual = item;
  tipoMovAtual = 'entrada';
  selecionarTipoMov('entrada');
  document.getElementById('mov-item-id').value = item.id;
  document.getElementById('mov-quantidade').value = '';
  document.getElementById('mov-motivo').value = '';
  document.getElementById('mov-disponivel').value = `${item.quantidadeAtual} ${item.unidade}`;
  document.getElementById('modal-mov-title').textContent = `Movimentar — ${item.nome}`;
  document.getElementById('modal-mov').classList.remove('hidden');

  const listaEl = document.getElementById('mov-lista');
  listaEl.innerHTML = '<p class="mov-vazio">Carregando histórico...</p>';
  try {
    historicoAtual = await apiFetch(`/almoxarifado-feridas/itens/${item.id}/movimentacoes`);
    renderHistorico(historicoAtual);
  } catch (err) {
    listaEl.innerHTML = `<p class="mov-vazio">Erro ao carregar histórico: ${esc(err.message)}</p>`;
  }
}

function renderHistorico(historico) {
  const listaEl = document.getElementById('mov-lista');
  if (!historico.length) {
    listaEl.innerHTML = '<p class="mov-vazio">Nenhuma movimentação registrada.</p>';
    return;
  }
  listaEl.innerHTML = historico.map(m => {
    const quando = new Date(m.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    const sinal = m.tipo === 'entrada' ? '+' : '−';
    return `<div class="mov-row ${m.tipo}">
      <span class="mov-sinal">${sinal}${m.quantidade}</span>
      <span class="mov-info">${esc(m.motivo)}<br><span class="mov-meta">${esc(quando)} · ${esc(m.createdByName || '')}</span></span>
    </div>`;
  }).join('');
}

async function registrarMovimentacao(e) {
  e.preventDefault();
  if (!itemAtual) return;
  const btn = document.getElementById('btn-registrar-mov');
  const quantidade = document.getElementById('mov-quantidade').value;
  const motivo = document.getElementById('mov-motivo').value.trim();

  btn.disabled = true;
  btn.textContent = 'Registrando...';
  try {
    const resp = await apiFetch(`/almoxarifado-feridas/itens/${itemAtual.id}/movimentacoes`, {
      method: 'POST',
      body: JSON.stringify({ tipo: tipoMovAtual, quantidade, motivo })
    });
    itemAtual.quantidadeAtual = resp.quantidadeAtual;
    document.getElementById('mov-disponivel').value = `${resp.quantidadeAtual} ${itemAtual.unidade}`;
    document.getElementById('mov-quantidade').value = '';
    document.getElementById('mov-motivo').value = '';
    showToast(tipoMovAtual === 'entrada' ? 'Entrada registrada' : 'Saída registrada');

    // Atualiza em memória em vez de rebuscar (economiza 2 leituras no
    // Firestore por movimentação — plano gratuito, cada leitura conta).
    const itemNaLista = itens.find(it => it.id === itemAtual.id);
    if (itemNaLista) itemNaLista.quantidadeAtual = resp.quantidadeAtual;
    aplicarFiltros();
    renderResumo();

    historicoAtual = [{
      tipo: tipoMovAtual,
      quantidade: parseInt(quantidade),
      motivo,
      createdAt: new Date().toISOString(),
      createdByName: currentUser?.displayName || currentUser?.email || ''
    }, ...historicoAtual];
    renderHistorico(historicoAtual);
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Registrar';
  }
}

// ==========================================
// RELATÓRIO: ESTOQUE ATUAL (relatorio-estoque.html)
// ==========================================

async function initPaginaRelatorioEstoque() {
  const msg = document.getElementById('relatorio-estoque-msg');
  const btnImprimir = document.getElementById('btn-imprimir-relatorio-estoque');
  btnImprimir.disabled = true;

  try {
    const itensTodos = await apiFetch('/almoxarifado-feridas/itens');
    renderRelatorioEstoque(itensTodos);
    msg.classList.add('hidden');
    btnImprimir.disabled = false;
    btnImprimir.addEventListener('click', () => window.print());
  } catch (err) {
    msg.innerHTML = `<p class="hint" style="margin:0; color:#b3453c">Erro ao carregar relatório: ${esc(err.message)}</p>`;
  }
}

function renderRelatorioEstoque(itensTodos) {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const total = itensTodos.length;
  const baixo = itensTodos.filter(it => it.quantidadeAtual <= it.estoqueMinimo).length;

  const linhas = itensTodos
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map(it => {
      const emBaixo = it.quantidadeAtual <= it.estoqueMinimo;
      return `
        <tr>
          <td>${esc(it.nome)}</td>
          <td>${esc(it.unidade)}</td>
          <td>${it.quantidadeAtual}</td>
          <td>${it.estoqueMinimo}</td>
          <td>${emBaixo ? '<span class="rel-badge-baixo">⚠ Baixo</span>' : 'OK'}</td>
        </tr>`;
    }).join('');

  document.getElementById('relatorio-estoque-conteudo').innerHTML = `
    <div class="rel-cabecalho">
      <img src="/img/fateclogoazul.png" alt="Fatec Ivaiporã" class="rel-logo">
      <div class="rel-titulo">
        <h1>Relatório de Estoque — Almoxarifado Feridas</h1>
        <p>Ambulatório · FATEC Ivaiporã</p>
      </div>
      <div class="rel-data-emissao">Emitido em ${hoje}</div>
    </div>

    <div class="rel-resumo">
      <div class="rel-resumo-card"><b>${total}</b><span>Material${total === 1 ? '' : 'is'} cadastrado${total === 1 ? '' : 's'}</span></div>
      <div class="rel-resumo-card"><b>${baixo}</b><span>Com estoque baixo</span></div>
    </div>

    <h2 class="rel-secao">Materiais (${total})</h2>
    <table class="rel-tabela">
      <thead><tr><th>Material</th><th>Unidade</th><th>Quantidade atual</th><th>Estoque mínimo</th><th>Status</th></tr></thead>
      <tbody>${linhas || `<tr><td colspan="5" class="rel-vazio">Nenhum material cadastrado.</td></tr>`}</tbody>
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

  document.getElementById('btn-gerar-relatorio-mov')?.addEventListener('click', gerarRelatorioMovimentacoes);
  document.getElementById('btn-imprimir-relatorio-mov')?.addEventListener('click', () => window.print());
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
    // 1 única consulta pra todas as movimentações do período (collectionGroup no
    // backend) — não busca nada até o usuário clicar em "Gerar".
    const movimentacoes = await apiFetch(`/almoxarifado-feridas/movimentacoes?inicio=${inicio}&fim=${fim}`);
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
    const quando = new Date(m.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `
      <tr>
        <td>${esc(quando)}</td>
        <td>${esc(m.itemNome || '—')}</td>
        <td>${m.tipo === 'entrada' ? 'Entrada' : 'Saída'}</td>
        <td>${m.quantidade} ${esc(m.itemUnidade || '')}</td>
        <td>${esc(m.motivo || '—')}</td>
        <td>${esc(m.createdByName || '—')}</td>
      </tr>`;
  }).join('');

  document.getElementById('relatorio-movimentacoes-conteudo').innerHTML = `
    <div class="rel-cabecalho">
      <img src="/img/fateclogoazul.png" alt="Fatec Ivaiporã" class="rel-logo">
      <div class="rel-titulo">
        <h1>Relatório de Movimentações — Almoxarifado Feridas</h1>
        <p>Ambulatório · FATEC Ivaiporã · Período: ${periodo}</p>
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
      <thead><tr><th>Data</th><th>Material</th><th>Tipo</th><th>Quantidade</th><th>Motivo</th><th>Responsável</th></tr></thead>
      <tbody>${linhas || `<tr><td colspan="6" class="rel-vazio">Nenhuma movimentação no período.</td></tr>`}</tbody>
    </table>
  `;
}

function fmtDataBr(iso) {
  return iso ? iso.split('-').reverse().join('/') : '—';
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
