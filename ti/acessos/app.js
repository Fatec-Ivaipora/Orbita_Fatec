import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../../core/layout.js';

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

let acessos = [];

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
        const rawPerm = rolePerms['acessos'];
        level = (rawPerm !== undefined && typeof rawPerm === 'object')
          ? (rawPerm.execute ? 3 : (rawPerm.view ? 2 : 1))
          : (parseInt(rawPerm) || 1);
      } catch (e) {
        // sem fallback especial: acessos é restrito por padrão
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

  setupLayout(user, role, 'acessos', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');

  setupFiltros();
  setupModalAcesso();
  setupModalAuditoria();
  await loadAcessos();
}

// ==========================================
// LISTAGEM / FILTROS
// ==========================================

async function loadAcessos() {
  const lista = document.getElementById('acessos-list');
  try {
    lista.innerHTML = '<div class="empty-state"><p>Carregando acessos...</p></div>';
    acessos = await apiFetch('/acessos');
    aplicarFiltros();
  } catch (err) {
    lista.innerHTML = `<div class="empty-state"><p>Erro ao carregar: ${esc(err.message)}</p></div>`;
  }
}

function setupFiltros() {
  document.getElementById('search-acessos')?.addEventListener('input', aplicarFiltros);
  document.getElementById('filtro-categoria')?.addEventListener('change', aplicarFiltros);
}

function aplicarFiltros() {
  const query = (document.getElementById('search-acessos')?.value || '').toLowerCase();
  const categoria = document.getElementById('filtro-categoria')?.value;

  const filtrados = acessos.filter(a => {
    const matchQuery = !query ||
      a.sistema.toLowerCase().includes(query) ||
      (a.titular || '').toLowerCase().includes(query) ||
      (a.usuario || '').toLowerCase().includes(query);
    const matchCategoria = !categoria || a.categoria === categoria;
    return matchQuery && matchCategoria;
  });
  renderAcessos(filtrados);
}

// Mesma ordem das categorias no formulário (não alfabética) — deixa Órbita
// (a maioria dos cadastros) logo no topo, e "Outro" sempre por último.
const ORDEM_CATEGORIAS = ['Órbita', 'Sistema', 'E-mail', 'Servidor', 'Outro'];

function renderAcessos(lista) {
  const container = document.getElementById('acessos-list');
  container.innerHTML = '';

  if (!lista.length) {
    container.innerHTML = `<div class="empty-state"><p>${acessos.length ? 'Nenhum acesso corresponde ao filtro.' : 'Nenhum acesso cadastrado ainda.'}</p></div>`;
    return;
  }

  const porCategoria = {};
  lista.forEach(a => {
    const cat = a.categoria || 'Outro';
    (porCategoria[cat] = porCategoria[cat] || []).push(a);
  });
  const categoriasPresentes = Object.keys(porCategoria).sort((a, b) => {
    const ia = ORDEM_CATEGORIAS.indexOf(a), ib = ORDEM_CATEGORIAS.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  categoriasPresentes.forEach(cat => {
    const itens = porCategoria[cat];
    const secao = document.createElement('div');
    secao.className = 'acs-secao';
    secao.innerHTML = `<h2 class="acs-secao-titulo">${esc(cat)} <span class="acs-secao-contagem">${itens.length}</span></h2>`;
    container.appendChild(secao);

    const grid = document.createElement('div');
    grid.className = 'acs-grid';
    itens.forEach(a => {
      const card = document.createElement('div');
      card.className = 'acs-card';
      card.innerHTML = `
        <div class="acs-card-topo">
          <div class="acs-card-nome">${esc(a.sistema)}</div>
          <span class="acs-card-cat">${esc(a.categoria || 'Outro')}</span>
        </div>
        ${a.titular ? `<div class="acs-card-linha"><b>Titular:</b> ${esc(a.titular)}</div>` : ''}
        ${a.usuario ? `<div class="acs-card-linha"><b>Usuário:</b> ${esc(a.usuario)}</div>` : ''}
        <div class="acs-card-senha">
          <span class="acs-senha-valor" data-senha-oculta>••••••••</span>
        </div>
        ${a.url ? `<div class="acs-card-link"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a></div>` : ''}
        ${a.observacoes ? `<div class="acs-card-obs">${esc(a.observacoes)}</div>` : ''}
        <div class="acs-card-actions action-execute">
          <button class="btn-mostrar" data-acao="mostrar">👁 Mostrar</button>
          <button data-acao="historico">Histórico</button>
          <button data-acao="editar">Editar</button>
          <button class="btn-excluir" data-acao="excluir">Excluir</button>
        </div>
      `;
      card.querySelector('[data-acao="mostrar"]').addEventListener('click', (e) => revelarSenha(a, e.currentTarget, card));
      card.querySelector('[data-acao="historico"]').addEventListener('click', () => abrirAuditoria(a));
      card.querySelector('[data-acao="editar"]').addEventListener('click', () => abrirModalAcesso(a));
      card.querySelector('[data-acao="excluir"]').addEventListener('click', () => excluirAcesso(a));
      grid.appendChild(card);
    });
    container.appendChild(grid);
  });
}

// ==========================================
// REVELAR SENHA (auditado no backend)
// ==========================================

async function revelarSenha(acesso, botao, card) {
  const span = card.querySelector('[data-senha-oculta]');
  if (span.dataset.revelado === '1') {
    span.textContent = '••••••••';
    span.dataset.revelado = '0';
    botao.textContent = '👁 Mostrar';
    return;
  }

  botao.disabled = true;
  botao.textContent = 'Buscando...';
  try {
    const resp = await apiFetch(`/acessos/${acesso.id}/revelar`, { method: 'POST' });
    span.textContent = resp.senha;
    span.dataset.revelado = '1';
    botao.textContent = '🙈 Ocultar';
  } catch (err) {
    showToast('Erro ao revelar senha: ' + err.message, 'error');
  } finally {
    botao.disabled = false;
  }
}

// ==========================================
// MODAL: NOVO / EDITAR ACESSO
// ==========================================

function setupModalAcesso() {
  const modal = document.getElementById('modal-acesso');
  document.getElementById('btn-novo-acesso')?.addEventListener('click', () => abrirModalAcesso(null));
  document.getElementById('btn-cancelar-acesso')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.getElementById('form-acesso')?.addEventListener('submit', salvarAcesso);
}

function abrirModalAcesso(acesso) {
  document.getElementById('form-acesso').reset();
  const editando = !!acesso;
  document.getElementById('acs-id').value = editando ? acesso.id : '';
  document.getElementById('acs-sistema').value = editando ? acesso.sistema : '';
  document.getElementById('acs-categoria').value = editando ? (acesso.categoria || 'Outro') : 'Sistema';
  document.getElementById('acs-titular').value = editando ? (acesso.titular || '') : '';
  document.getElementById('acs-usuario').value = editando ? (acesso.usuario || '') : '';
  document.getElementById('acs-senha').value = '';
  document.getElementById('acs-senha').required = !editando;
  document.getElementById('acs-senha').placeholder = editando ? 'Deixe em branco para manter a senha atual' : 'Digite a senha';
  document.getElementById('lbl-acs-senha').textContent = editando ? 'Nova senha (opcional)' : 'Senha *';
  document.getElementById('acs-url').value = editando ? (acesso.url || '') : '';
  document.getElementById('acs-observacoes').value = editando ? (acesso.observacoes || '') : '';
  document.getElementById('modal-acesso-title').textContent = editando ? 'Editar Acesso' : 'Novo Acesso';
  document.getElementById('btn-salvar-acesso').textContent = editando ? 'Salvar alterações' : 'Cadastrar';
  document.getElementById('modal-acesso').classList.remove('hidden');
  document.getElementById('acs-sistema').focus();
}

async function salvarAcesso(e) {
  e.preventDefault();
  const id = document.getElementById('acs-id').value;
  const btn = document.getElementById('btn-salvar-acesso');
  const dados = {
    sistema: document.getElementById('acs-sistema').value.trim(),
    categoria: document.getElementById('acs-categoria').value,
    titular: document.getElementById('acs-titular').value.trim(),
    usuario: document.getElementById('acs-usuario').value.trim(),
    senha: document.getElementById('acs-senha').value,
    url: document.getElementById('acs-url').value.trim(),
    observacoes: document.getElementById('acs-observacoes').value.trim()
  };

  btn.disabled = true;
  btn.textContent = id ? 'Salvando...' : 'Cadastrando...';
  try {
    if (id) {
      await apiFetch(`/acessos/${id}`, { method: 'PUT', body: JSON.stringify(dados) });
      showToast('Acesso atualizado');
    } else {
      await apiFetch('/acessos', { method: 'POST', body: JSON.stringify(dados) });
      showToast('Acesso cadastrado');
    }
    document.getElementById('modal-acesso').classList.add('hidden');
    await loadAcessos();
  } catch (err) {
    showToast('Erro ao salvar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Salvar alterações' : 'Cadastrar';
  }
}

async function excluirAcesso(acesso) {
  if (!confirm(`Excluir o acesso "${acesso.sistema}"? Essa ação não tem volta.`)) return;
  try {
    await apiFetch(`/acessos/${acesso.id}`, { method: 'DELETE' });
    showToast('Acesso excluído');
    await loadAcessos();
  } catch (err) {
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

// ==========================================
// AUDITORIA (quem já viu a senha)
// ==========================================

function setupModalAuditoria() {
  const modal = document.getElementById('modal-auditoria');
  document.getElementById('btn-fechar-auditoria')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
}

async function abrirAuditoria(acesso) {
  const modal = document.getElementById('modal-auditoria');
  const lista = document.getElementById('auditoria-lista');
  lista.innerHTML = '<p class="aud-vazio">Carregando...</p>';
  modal.classList.remove('hidden');
  try {
    const visualizacoes = await apiFetch(`/acessos/${acesso.id}/visualizacoes`);
    if (!visualizacoes.length) {
      lista.innerHTML = '<p class="aud-vazio">Ninguém revelou esta senha ainda.</p>';
      return;
    }
    lista.innerHTML = visualizacoes.map(v => {
      const quando = new Date(v.viewedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `<div class="aud-row">${esc(v.viewedByName || v.viewedBy)} — ${esc(quando)}</div>`;
    }).join('');
  } catch (err) {
    lista.innerHTML = `<p class="aud-vazio">Erro: ${esc(err.message)}</p>`;
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
