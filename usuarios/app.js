// ================================================================
//  ÓRBITA — MÓDULO USUÁRIOS
//  Gestão completa: criar, listar, editar role, deletar
//  Técnica: Secondary Firebase App para criar usuários sem deslogar o ADM
// ================================================================
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAnalytics }             from "https://www.gstatic.com/firebasejs/10.9.0/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  updatePassword,
  sendPasswordResetEmail,
  signOut
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../core/layout.js";
import { escapeHTML as esc } from "../core/security.js";
import { MODULES, CATEGORIES, getAccessLevel, getEffectiveLevel } from "../core/permissions.js";


const fbApp    = initializeApp(firebaseConfig);
const analytics = getAnalytics(fbApp);
const auth     = getAuth(fbApp);
const db       = getFirestore(fbApp); // Mantido apenas para Auth Guard (users)

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.')) 
  ? `http://${window.location.hostname}:3000/api` 
  : '/api';

async function apiFetch(endpoint, options = {}) {
  let token = '';
  if (currentUser && typeof currentUser.getIdToken === 'function') {
    token = await currentUser.getIdToken();
  } else if (auth.currentUser) {
    token = await auth.currentUser.getIdToken();
  }
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

// ---- State ----
let currentUser = null;
let currentRole = null;
let allUsers    = [];
let allRoles    = [];
let globalPermissions = {}; // Carregado do Firestore (config/permissions)
let activeRoleTab     = 'adm_l2';

// Fonte ÚNICA de módulos: core/permissions.js (MODULES). Qualquer módulo novo
// registrado lá para o menu lateral aparece automaticamente nesta tela.
// dashboard e fidelidade ficam de fora (sempre liberados pelo layout).
const PERM_MODULES = Object.values(MODULES).filter(m => !['dashboard', 'fidelidade'].includes(m.id));

// Filtro de tópico/categoria ativo na grade de acessos
let filtroCategoria = 'todos';

// ---- Elements ----
const authGuard    = document.getElementById('auth-guard');
const mainContent  = document.getElementById('main-content');
const userCount    = document.getElementById('user-count');
const searchInput  = document.getElementById('search-users');
const userList     = document.getElementById('user-list');

let appInitialized = false;
let initializedRole = null;

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;

  // Inicializar o novo Layout
  setupLayout(user, role, 'usuarios', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../auth/login.html';
  });

  mainContent.classList.remove('hidden');
  initPage();
}

// Check cache immediately
const cached = getCachedAuth();
if (cached && ['adm_l1', 'adm_l2', 'ti'].includes(cached.role)) {
  currentUser = cached.user;
  currentRole = cached.role;
  initApp(cached.user, cached.role);
}

// ================================================================
//  AUTH GUARD — Só ADM entra
// ================================================================
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    clearCachedAuth();
    window.location.href = '../auth/login.html';
    return;
  }

  currentUser = user;

  // Busca role e permissões (inclusive overrides individuais) do usuário
  let meuOverrides = null;
  try {
    const userData = await apiFetch('/usuarios/me');
    currentRole = userData.role || 'visitante';
    meuOverrides = userData.permissoes || null;
  } catch(e) {
    currentRole = cached ? cached.role : 'visitante';
  }

  // Nível EFETIVO no módulo usuarios: override individual vence o cargo
  let userLevel = 1;
  try {
    const globalData = await apiFetch('/usuarios/config/permissions');
    const rolePerms = globalData[currentRole] || {};
    userLevel = getEffectiveLevel(rolePerms, meuOverrides, 'usuarios');
  } catch(e) {}

  const token = await user.getIdToken();
  setCachedAuth(user, currentRole, token);

  // ADM L1 entra direto. Outros precisam de 'view' (nível >= 2) vinda do Config Global.
  if (currentRole !== 'adm_l1' && userLevel < 2) {
    window.location.href = '../meu-espaco/index.html';
    return;
  }

  // Se não tiver permissão 'execute' (nível >= 3), bloqueia ações de edição/delete
  if (currentRole !== 'adm_l1' && userLevel < 3) {
    document.body.classList.add('hide-execute');
  } else {
    document.body.classList.remove('hide-execute');
  }

  if (!appInitialized || initializedRole !== currentRole || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
    initApp(user, currentRole);
  }
});

// ================================================================
//  INIT
// ================================================================
function initPage() {
  loadUsers();
  loadRoles();
  loadGlobalPermissions();
  setupModals();
  setupPermissionTabs();
  setupPermissoesPorUsuario();
  searchInput.addEventListener('input', filterUsers);
  document.getElementById('search-roles')?.addEventListener('input', filterRoles);
  document.getElementById('btn-save-global-perms').addEventListener('click', saveGlobalPermissions);
  document.getElementById('btn-novo-cargo')?.addEventListener('click', abrirModalNovoCargo);

  setupMainTabs();
  aplicarGatingAdmL1();
}

// Gerência de acessos é exclusiva do ADM N1: esconde a aba para os demais
function aplicarGatingAdmL1() {
  if (currentRole === 'adm_l1') return;
  const tabBtn = document.querySelector('.tab-btn[data-tab="cargos"]');
  const tabContent = document.getElementById('tab-cargos');
  if (tabBtn) tabBtn.style.display = 'none';
  if (tabContent) { tabContent.classList.remove('active'); tabContent.style.display = 'none'; }
}

// ================================================================
//  LOAD USERS (realtime)
// ================================================================
function loadUsers() {
  setInterval(async () => {
    if (document.hidden) return; // Ignorar requisições se a aba estiver inativa
    try {
      const data = await apiFetch('/usuarios');
      allUsers = data;
      allUsers.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
      
      // Preservar o filtro atual se o usuário estiver buscando
      if (document.activeElement === searchInput || searchInput.value) {
        filterUsers();
      } else {
        renderUsers(allUsers);
      }
    } catch(e) {}
  }, 120000);

  // Primeira carga imediata
  apiFetch('/usuarios').then(data => {
    allUsers = data;
    allUsers.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    renderUsers(allUsers);
  }).catch(e => console.error(e));
}

function filterUsers() {
  const q = searchInput.value.toLowerCase();
  const filtered = allUsers.filter(u =>
    (u.name  || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q)
  );
  renderUsers(filtered);
}

function loadRoles() {
  setInterval(async () => {
    if (document.hidden) return; // Ignorar requisições se a aba estiver inativa
    try {
      const data = await apiFetch('/usuarios/roles');
      allRoles = data;
      allRoles.sort((a, b) => a.name.localeCompare(b.name));
      renderRoles(allRoles);
      updateRoleSelects();
    } catch(e) {}
  }, 120000);

  // Primeira carga
  apiFetch('/usuarios/roles').then(async (data) => {
    if (data.length === 0) {
      const defaults = [
        { id: 'adm_l1',    name: 'ADM N1 - Sênior/Dev' },
        { id: 'adm_l2',    name: 'ADM N2 - Setor/Chefia' },
        { id: 'ti',        name: 'TI - Suporte' },
        { id: 'visitante', name: 'Visitante - Consulta' },
        { id: 'rh',        name: 'RH - Recursos Humanos' }
      ];
      for (const r of defaults) {
        await apiFetch('/usuarios/roles', { method: 'POST', body: JSON.stringify(r) });
      }
    } else {
      allRoles = data;
      allRoles.sort((a, b) => a.name.localeCompare(b.name));
      renderRoles(allRoles);
      updateRoleSelects();
    }
  }).catch(e => console.error(e));
}

function filterRoles() {
  const q = document.getElementById('search-roles').value.toLowerCase();
  const filtered = allRoles.filter(r => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  renderRoles(filtered);
}

function updateRoleSelects() {
  // Update ROLE_LABEL dynamically
  allRoles.forEach(r => {
    ROLE_LABEL[r.id] = r.name;
  });

  // Update Role Select in Permissions Tab
  const select = document.getElementById('role-select');
  if (select) {
    const currentVal = select.value;
    select.innerHTML = allRoles.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    if (allRoles.some(r => r.id === currentVal)) select.value = currentVal;
    else if (allRoles.length > 0) select.value = allRoles[0].id;
    activeRoleTab = select.value;
  }

  const roleDescs = {
    adm_l1: 'Sênior/Dev',
    adm_l2: 'Setor/Chefia',
    ti: 'Suporte',
    visitante: 'Consulta',
    rh: 'Recursos Humanos',
    default: 'Setor Personalizado'
  };

  const renderRoleOption = (r, nameAttr) => {
    const parts = r.name.split(' - ');
    const displayName = parts[0];
    const displayDesc = parts[1] || roleDescs[r.id] || roleDescs.default;
    return `
      <label class="role-option">
        <input type="radio" name="${nameAttr}" value="${r.id}" required>
        <div class="role-card">
          <strong>${esc(displayName)}</strong>
          <small>${esc(displayDesc)}</small>
        </div>
      </label>
    `;
  };

  // Update Role options in Create User Modal
  const roleRadios = document.getElementById('novo-role-options');
  if (roleRadios) {
    roleRadios.innerHTML = allRoles.map(r => renderRoleOption(r, 'novo-role')).join('');
  }

  // Update Role options in Edit User Modal
  const editRadios = document.getElementById('edit-role-options');
  if (editRadios) {
    editRadios.innerHTML = allRoles.map(r => renderRoleOption(r, 'edit-role')).join('');
  }
}

function renderRoles(list) {
  const container = document.getElementById('roles-list');
  if (!container) return;
  container.innerHTML = '';

  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><p>Nenhum cargo cadastrado.</p></div>`;
    return;
  }

  list.forEach(role => {
    const card = document.createElement('div');
    card.className = 'role-item-card';
    card.innerHTML = `
      <div class="role-item-info">
        <div class="role-item-name">${esc(role.name)}</div>
        <div class="role-item-id">ID: ${esc(role.id)}</div>
      </div>
      <div class="role-item-actions">
        <button class="icon-btn delete-role-btn action-execute" data-id="${role.id}" data-name="${role.name}" title="Excluir cargo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    `;
    card.querySelector('.delete-role-btn').onclick = () => confirmarExcluirCargo(role.id, role.name);
    container.appendChild(card);
  });
}

async function confirmarExcluirCargo(id, name) {
  if (id === 'adm_l1') {
    showToast("❌ O cargo ADM N1 não pode ser excluído.", "error");
    return;
  }
  if (!confirm(`Deseja excluir permanentemente o cargo "${name}"?\nIsso pode afetar usuários vinculados.`)) return;

  try {
    await apiFetch(`/usuarios/roles/${id}`, { method: 'DELETE' });
    showToast(`🗑️ Cargo ${name} removido.`, "success");
  } catch (err) {
    showToast(`❌ Erro ao excluir: ${err.message}`, "error");
  }
}

// ================================================================
//  RENDER
// ================================================================
// ================================================================
//  RENDER
// ================================================================
const ROLE_LABEL = { 
  adm_l1: 'ADM N1', 
  adm_l2: 'ADM N2', 
  ti: 'TI', 
  visitante: 'Visitante',
  rh: 'RH'
};

// Agrupamento por categoria para a grade de acessos (respeita o filtro)
function getModulosPorCategoria() {
  const grupos = [];
  if (filtroCategoria === 'todos' || filtroCategoria === 'geral') {
    const semCategoria = PERM_MODULES.filter(m => !m.category);
    if (semCategoria.length) grupos.push({ label: 'Geral', modulos: semCategoria });
  }
  Object.entries(CATEGORIES).forEach(([catKey, catLabel]) => {
    if (filtroCategoria !== 'todos' && filtroCategoria !== catKey) return;
    const mods = PERM_MODULES.filter(m => m.category === catKey);
    if (mods.length) grupos.push({ label: catLabel, modulos: mods });
  });
  return grupos;
}

function rerenderGrades() {
  renderPermissionsGrid('global-permissions-grid', globalPermissions[activeRoleTab] || {});
  if (permUserSelecionado) renderPermissoesUsuario();
}

function renderUsers(list) {
  userCount.textContent = `${allUsers.length} usuário${allUsers.length !== 1 ? 's' : ''}`;
  userList.innerHTML    = '';

  if (!list.length) {
    userList.innerHTML = `<div class="empty-state"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><p>Nenhum usuário encontrado.</p></div>`;
    return;
  }

  list.forEach((u, idx) => {
    const isSelf   = u.uid === currentUser.uid;
    const role     = u.role || 'ti';
    const initial  = (u.name || u.email || '?').charAt(0).toUpperCase();
    const dateStr  = u.createdAt ? new Date(u.createdAt).toLocaleDateString('pt-BR') : '—';

    const card = document.createElement('div');
    card.className = 'user-card';
    card.style.animationDelay = `${idx * 0.04}s`;
    card.innerHTML = `
      <div class="user-card-avatar avatar-${role.startsWith('adm') ? 'adm' : role}">${esc(initial)}</div>
      <div class="user-card-info">
        <div class="user-card-name">${esc(u.name || '(sem nome)')}</div>
        <div class="user-card-email">${esc(u.email || u.uid)}</div>
        <div class="user-card-meta">
          <span class="role-badge badge-${role}">${ROLE_LABEL[role] || role}</span>
          ${u.permissoes && Object.keys(u.permissoes).length ? '<span class="perm-override-badge">Acessos personalizados</span>' : ''}
          <span class="user-card-date">Desde ${dateStr}</span>
          ${isSelf ? '<span class="user-card-date">· você</span>' : ''}
        </div>
      </div>
      <div class="user-card-actions">
        <button class="icon-btn edit-btn action-execute ${isSelf ? 'self-btn' : ''}"
          data-uid="${u.uid}" data-name="${u.name || u.email}" data-role="${role}" data-email="${u.email || ''}"
          title="Editar usuário" ${isSelf ? 'disabled' : ''}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn delete-btn action-execute ${isSelf ? 'self-btn' : ''}"
          data-uid="${u.uid}" data-name="${u.name || u.email}"
          title="Remover usuário" ${isSelf ? 'disabled' : ''}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    `;
    userList.appendChild(card);
  });

  // Delegation
  userList.querySelectorAll('.edit-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => abrirModalEditar(btn.dataset.uid, btn.dataset.name, btn.dataset.role, btn.dataset.email));
  });
  userList.querySelectorAll('.delete-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => confirmarDelete(btn.dataset.uid, btn.dataset.name));
  });

  // Mantém o seletor do modo "Por Usuário" sincronizado com a lista
  popularSelectPermUsuario();
}

// ================================================================
//  MODALS SETUP
// ================================================================
function setupModals() {
  // Modal Novo
  const btnNovo = document.getElementById('btn-novo-usuario');
  if (btnNovo) btnNovo.addEventListener('click', () => abrirModalNovo());
  
  document.getElementById('btn-fechar-novo').addEventListener('click',  () => fecharModal('modal-novo'));
  document.getElementById('btn-cancelar-novo').addEventListener('click',() => fecharModal('modal-novo'));
  document.getElementById('form-novo-usuario').addEventListener('submit', criarUsuario);

  // Toggle senha
  document.getElementById('toggle-pw').addEventListener('click', () => {
    const inp = document.getElementById('novo-senha');
    inp.type  = inp.type === 'password' ? 'text' : 'password';
  });

  // Modal Editar
  document.getElementById('btn-fechar-editar').addEventListener('click',   () => fecharModal('modal-editar'));
  document.getElementById('btn-cancelar-editar').addEventListener('click', () => fecharModal('modal-editar'));
  document.getElementById('btn-salvar-role').addEventListener('click',     salvarRole);
  document.getElementById('btn-send-reset').addEventListener('click',      enviarResetSenha);

  // Toggle Status Ativo
  document.getElementById('edit-status-ativo').addEventListener('change', async (e) => {
    const isAtivo = e.target.checked;
    const uid = document.getElementById('edit-uid').value;
    try {
      await apiFetch(`/usuarios/${uid}/status`, { method: 'PUT', body: JSON.stringify({ ativo: isAtivo }) });
      showToast(`✅ Status alterado para ${isAtivo ? 'Ativo' : 'Inativo'}`, 'success');
    } catch (err) {
      e.target.checked = !isAtivo; // Reverte visualmente
      showToast(`❌ Erro: ${err.message}`, 'error');
    }
  });

  // Modal Cargo
  document.getElementById('btn-fechar-cargo').addEventListener('click',   () => fecharModal('modal-cargo'));
  document.getElementById('btn-cancelar-cargo').addEventListener('click', () => fecharModal('modal-cargo'));
  document.getElementById('form-novo-cargo').addEventListener('submit', salvarNovoCargo);
}

function abrirModalNovoCargo() {
  document.getElementById('form-novo-cargo').reset();
  document.getElementById('cargo-error').classList.add('hidden');
  abrirModal('modal-cargo');
}

async function salvarNovoCargo(e) {
  e.preventDefault();
  const nome = document.getElementById('cargo-nome').value.trim();
  const id = document.getElementById('cargo-id').value.trim().toLowerCase().replace(/\s+/g, '_');
  const errEl = document.getElementById('cargo-error');
  const btn = document.getElementById('btn-salvar-cargo');

  if (!id.match(/^[a-z0-9_]+$/)) {
    errEl.textContent = "ID inválido. Use apenas letras, números e sublinhados.";
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  document.getElementById('cargo-salvar-text').textContent = "Criando...";

  try {
    await apiFetch('/usuarios/roles', { method: 'POST', body: JSON.stringify({ id, name: nome }) });
    
    // Cargo novo nasce sem acesso a nenhum módulo (nível 1) — derivado da
    // fonte única de módulos; o adm libera o que precisar na tela de acessos
    const perms = await apiFetch('/usuarios/config/permissions');
    perms[id] = {};
    PERM_MODULES.forEach(m => { perms[id][m.id] = 1; });
    await apiFetch('/usuarios/config/permissions', { method: 'PUT', body: JSON.stringify(perms) });

    fecharModal('modal-cargo');
    showToast(`✅ Setor ${nome} criado!`, 'success');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    document.getElementById('cargo-salvar-text').textContent = "Criar Cargo";
  }
}

function abrirModalNovo() {
  document.getElementById('form-novo-usuario').reset();
  document.getElementById('form-error').classList.add('hidden');
  abrirModal('modal-novo');
}

function abrirModalEditar(uid, name, role, email) {
  const user = allUsers.find(u => u.uid === uid);
  if (!user) return;

  document.getElementById('edit-uid').value         = uid;
  document.getElementById('edit-email').value       = email || '';
  document.getElementById('edit-user-name').textContent = `${name} (${email || ''})`;
  
  // Set role
  const radio = document.querySelector(`input[name="edit-role"][value="${role}"]`);
  if (radio) radio.checked = true;

  // Set status
  const isAtivo = user.ativo !== false;
  document.getElementById('edit-status-ativo').checked = isAtivo;

  abrirModal('modal-editar');
}

// ================================================================
//  GLOBAL PERMISSIONS LOGIC
// ================================================================
async function loadGlobalPermissions() {
  try {
    const data = await apiFetch('/usuarios/config/permissions');
    globalPermissions = data || {};
    renderPermissionsGrid('global-permissions-grid', globalPermissions[activeRoleTab] || {});
  } catch (err) {
    console.error("Erro ao carregar permissões:", err);
  }
}

function setupPermissionTabs() {
  const roleSelect = document.getElementById('role-select');
  if (roleSelect) {
    roleSelect.addEventListener('change', (e) => {
      activeRoleTab = e.target.value;
      renderPermissionsGrid('global-permissions-grid', globalPermissions[activeRoleTab] || {});
    });
    // Trigger initial render for the first option
    activeRoleTab = roleSelect.value;
  }
}

function setupMainTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn[data-tab]');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Deactivate all
      tabBtns.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.remove('active');
        c.style.display = 'none';
      });
      
      // Activate clicked
      btn.classList.add('active');
      
      const targetId = `tab-${btn.dataset.tab}`;
      const targetTab = document.getElementById(targetId);
      if (targetTab) {
        targetTab.classList.add('active');
        targetTab.style.display = 'block';
      }
    });
  });
}

async function saveGlobalPermissions() {
  const btn = document.getElementById('btn-save-global-perms');
  btn.disabled = true; btn.textContent = 'Salvando...';

  // Collect from grid
  const rolePerms = {};
  document.querySelectorAll('#global-permissions-grid .perm-level-select').forEach(select => {
    const modId = select.dataset.mod;
    rolePerms[modId] = parseInt(select.value);
  });

  globalPermissions[activeRoleTab] = rolePerms;

  try {
    await apiFetch('/usuarios/config/permissions', { method: 'PUT', body: JSON.stringify(globalPermissions) });
    showToast('✅ Permissões globais atualizadas!', 'success');
  } catch (err) {
    showToast('❌ Erro ao salvar permissões: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Salvar Configurações';
  }
}

const NIVEL_LABEL = { 1: 'Sem Acesso', 2: 'Apenas Leitura', 3: 'Acesso Total' };

// Grade de permissões agrupada por categoria. Reutilizada pelos dois modos:
// - Por Cargo: opções 1/2/3 (currentPerms = níveis do cargo).
// - Por Usuário (opts.herdar): ganha a opção 0 "Herdar do cargo", que exibe
//   o nível herdado; currentPerms = overrides do usuário, opts.rolePerms =
//   níveis do cargo dele para calcular o herdado.
function renderPermissionsGrid(containerId, currentPerms, opts = {}) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  getModulosPorCategoria().forEach(grupo => {
    const header = document.createElement('div');
    header.className = 'perm-cat-header';
    header.textContent = grupo.label;
    container.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'module-permissions-grid';

    grupo.modulos.forEach(mod => {
      const temOverride = currentPerms && currentPerms[mod.id] !== undefined;
      const level = temOverride ? getAccessLevel(currentPerms[mod.id]) : (opts.herdar ? 0 : 1);
      const nivelHerdado = opts.herdar ? getAccessLevel(opts.rolePerms ? opts.rolePerms[mod.id] : undefined) : null;

      const card = document.createElement('div');
      const ativo = opts.herdar
        ? (temOverride ? level > 1 : nivelHerdado > 1)
        : level > 1;
      card.className = `perm-card ${ativo ? 'active' : ''} ${opts.herdar && temOverride ? 'override' : ''}`;

      const opcaoHerdar = opts.herdar
        ? `<option value="0" ${!temOverride ? 'selected' : ''}>Herdar do setor (${NIVEL_LABEL[nivelHerdado]})</option>`
        : '';

      card.innerHTML = `
        <div class="perm-card-title">${mod.icon} ${esc(mod.title)}</div>
        <div class="perm-options" style="width: 100%;">
          <select class="form-input perm-level-select" data-mod="${esc(mod.id)}" style="width: 100%; height: 40px; font-size: 0.85rem; padding: 0 0.5rem; background: var(--bg); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-main); cursor: pointer;">
            ${opcaoHerdar}
            <option value="1" ${temOverride && level === 1 ? 'selected' : (!opts.herdar && level === 1 ? 'selected' : '')}>Nível 1 - Sem Acesso</option>
            <option value="2" ${level === 2 ? 'selected' : ''}>Nível 2 - Apenas Leitura</option>
            <option value="3" ${level === 3 ? 'selected' : ''}>Nível 3 - Acesso Total</option>
          </select>
        </div>
      `;

      const select = card.querySelector('.perm-level-select');
      select.addEventListener('change', (e) => {
        const val = parseInt(e.target.value);
        const efetivo = (opts.herdar && val === 0) ? nivelHerdado : val;
        card.classList.toggle('active', efetivo > 1);
        card.classList.toggle('override', opts.herdar && val !== 0);
      });

      grid.appendChild(card);
    });

    container.appendChild(grid);
  });
}

// ================================================================
//  PERMISSÕES POR USUÁRIO (override individual)
// ================================================================
let permUserSelecionado = null;

function labelUsuarioPerm(u) {
  const nome = u.name || u.email || u.uid;
  return u.permissoes && Object.keys(u.permissoes).length ? `${nome} (personalizado)` : nome;
}

// Mantém o campo de busca sincronizado com allUsers (ex.: depois de salvar
// permissões, o "(personalizado)" do usuário selecionado pode ter mudado).
function popularSelectPermUsuario() {
  const input = document.getElementById('perm-user-search');
  const hidden = document.getElementById('perm-user-select');
  if (!input || !hidden) return;
  if (permUserSelecionado && allUsers.some(u => u.uid === permUserSelecionado.uid)) {
    permUserSelecionado = allUsers.find(u => u.uid === permUserSelecionado.uid);
    input.value = labelUsuarioPerm(permUserSelecionado);
    hidden.value = permUserSelecionado.uid;
  }
}

// Lista filtrada (por nome ou e-mail) que aparece embaixo do campo de busca
function renderDropdownUsuarios(query) {
  const dropdown = document.getElementById('perm-user-dropdown');
  const q = query.trim().toLowerCase();
  const filtrados = !q ? allUsers : allUsers.filter(u =>
    (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)
  );

  dropdown.innerHTML = filtrados.length
    ? filtrados.map(u => `<div class="user-search-item" data-uid="${esc(u.uid)}">${esc(labelUsuarioPerm(u))}</div>`).join('')
    : '<div class="user-search-empty">Nenhum usuário encontrado.</div>';

  dropdown.querySelectorAll('.user-search-item').forEach(item => {
    item.addEventListener('click', () => selecionarUsuarioPerm(item.dataset.uid));
  });
  dropdown.classList.remove('hidden');
}

function selecionarUsuarioPerm(uid) {
  const input = document.getElementById('perm-user-search');
  const hidden = document.getElementById('perm-user-select');
  const dropdown = document.getElementById('perm-user-dropdown');
  permUserSelecionado = allUsers.find(u => u.uid === uid) || null;
  hidden.value = uid;
  input.value = permUserSelecionado ? labelUsuarioPerm(permUserSelecionado) : '';
  dropdown.classList.add('hidden');
  renderPermissoesUsuario();
}

function setupPermissoesPorUsuario() {
  // Pills de modo
  document.querySelectorAll('.perm-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.perm-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const modo = btn.dataset.permMode;
      document.getElementById('perms-modo-cargo').classList.toggle('hidden', modo !== 'cargo');
      document.getElementById('perms-modo-usuario').classList.toggle('hidden', modo !== 'usuario');
      if (modo === 'usuario') popularSelectPermUsuario();
    });
  });

  const searchInput = document.getElementById('perm-user-search');
  const dropdown = document.getElementById('perm-user-dropdown');

  searchInput.addEventListener('input', () => renderDropdownUsuarios(searchInput.value));
  searchInput.addEventListener('focus', () => renderDropdownUsuarios(searchInput.value));

  document.addEventListener('click', (e) => {
    if (e.target.closest('#perm-user-searchbar')) return;
    dropdown.classList.add('hidden');
    searchInput.value = permUserSelecionado ? labelUsuarioPerm(permUserSelecionado) : '';
  });

  document.getElementById('btn-save-user-perms').addEventListener('click', salvarPermissoesUsuario);
  document.getElementById('btn-reset-user-perms').addEventListener('click', async () => {
    if (!permUserSelecionado) return;
    if (!confirm(`Restaurar o padrão do setor para ${permUserSelecionado.name || permUserSelecionado.email}?\n\nTodos os acessos personalizados serão removidos.`)) return;
    await enviarPermissoesUsuario({});
  });
}

function renderPermissoesUsuario() {
  const info = document.getElementById('perm-user-info');
  const wrapper = document.getElementById('user-permissions-wrapper');
  const actions = document.getElementById('user-perms-actions');

  if (!permUserSelecionado) {
    info.classList.add('hidden');
    wrapper.classList.add('hidden');
    actions.classList.add('hidden');
    return;
  }

  const u = permUserSelecionado;
  const role = u.role || 'visitante';
  const rolePerms = globalPermissions[role] || {};
  const overrides = u.permissoes || {};
  const qtdOverrides = Object.keys(overrides).length;

  info.classList.remove('hidden');
  info.innerHTML = `
    <strong>${esc(u.name || u.email)}</strong> · setor <span class="role-badge badge-${esc(role)}">${ROLE_LABEL[role] || esc(role)}</span>
    ${qtdOverrides ? `· <span class="perm-override-badge">${qtdOverrides} acesso(s) personalizado(s)</span>` : '· sem personalizações'}
    <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.35rem;">"Herdar do setor" segue o que está definido no modo Por Setor. Qualquer outro valor vale só para este usuário e vence o cargo.</div>
  `;

  wrapper.classList.remove('hidden');
  actions.classList.remove('hidden');
  renderPermissionsGrid('user-permissions-grid', overrides, { herdar: true, rolePerms });
}

async function salvarPermissoesUsuario() {
  if (!permUserSelecionado) return;
  const permissoes = {};
  document.querySelectorAll('#user-permissions-grid .perm-level-select').forEach(select => {
    const val = parseInt(select.value);
    if (val >= 1) permissoes[select.dataset.mod] = val; // 0 = herdar → não envia
  });
  await enviarPermissoesUsuario(permissoes);
}

async function enviarPermissoesUsuario(permissoes) {
  const btn = document.getElementById('btn-save-user-perms');
  btn.disabled = true;
  try {
    await apiFetch(`/usuarios/${permUserSelecionado.uid}/permissoes`, {
      method: 'PUT',
      body: JSON.stringify({ permissoes })
    });
    // Atualiza estado local
    const idx = allUsers.findIndex(u => u.uid === permUserSelecionado.uid);
    if (idx >= 0) {
      if (Object.keys(permissoes).length) allUsers[idx].permissoes = permissoes;
      else delete allUsers[idx].permissoes;
      permUserSelecionado = allUsers[idx];
    }
    showToast('✅ Permissões do usuário atualizadas!', 'success');
    popularSelectPermUsuario();
    renderPermissoesUsuario();
    renderUsers(allUsers);
  } catch (err) {
    showToast('❌ Erro: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function abrirModal(id)  { document.getElementById(id).classList.add('active'); }
function fecharModal(id) { document.getElementById(id).classList.remove('active'); }

// ================================================================
//  CRIAR USUÁRIO (Secondary App)
// ================================================================
async function criarUsuario(e) {
  e.preventDefault();

  const nome  = document.getElementById('novo-nome').value.trim();
  const email = document.getElementById('novo-email').value.trim();
  const senha = document.getElementById('novo-senha').value;
  const role  = document.querySelector('input[name="novo-role"]:checked')?.value || 'ti';
  
  const errEl = document.getElementById('form-error');
  const btn   = document.getElementById('btn-salvar-novo');
  const text  = document.getElementById('salvar-text');
  const spin  = document.getElementById('salvar-spinner');

  errEl.classList.add('hidden');
  btn.disabled  = true;
  text.textContent = 'Criando...';
  spin.classList.remove('hidden');

  try {
    await apiFetch('/usuarios', {
      method: 'POST',
      body: JSON.stringify({ nome, email, senha, role })
    });

    fecharModal('modal-novo');
    showToast(`✅ ${nome} criado com sucesso!`, 'success');

  } catch (err) {
    errEl.textContent = err.message || "Erro ao criar usuário.";
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    text.textContent = 'Criar Usuário';
    spin.classList.add('hidden');
  }
}

// ================================================================
//  ALTERAR ROLE
// ================================================================
async function salvarRole() {
  const uid     = document.getElementById('edit-uid').value;
  const newRole = document.querySelector('input[name="edit-role"]:checked')?.value;
  if (!uid || !newRole) return;

  const btn = document.getElementById('btn-salvar-role');
  btn.disabled = true; btn.textContent = 'Salvando...';
  try {
    await apiFetch(`/usuarios/${uid}/role`, { method: 'PUT', body: JSON.stringify({ role: newRole }) });
    showToast(`✅ Nível alterado para ${ROLE_LABEL[newRole]}`, 'success');
  } catch (err) {
    showToast(`❌ Erro ao salvar: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Salvar Nível';
  }
}

// ================================================================
//  ENVIAR E-MAIL DE RESET DE SENHA
// ================================================================
async function enviarResetSenha() {
  const email = document.getElementById('edit-email').value;
  if (!email) { showToast('❌ E-mail não encontrado.', 'error'); return; }

  const btn = document.getElementById('btn-send-reset');
  btn.disabled = true; btn.textContent = 'Enviando...';

  try {
    auth.languageCode = 'pt-br'; // Forçar idioma para Português
    
    // Configurações para redirecionar para nossa tela customizada
    const actionCodeSettings = {
      // Usando o link oficial para evitar erros de domínio não autorizado
      url: 'https://orbita-fatecivp.web.app/auth/redefinir-senha.html',
      handleCodeInApp: true,
    };

    await sendPasswordResetEmail(auth, email, actionCodeSettings);
    showToast(`✅ Link de redefinição enviado para ${email}`, 'success');
  } catch (err) {
    showToast(`❌ Erro: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> Enviar E-mail';
  }
}

// ================================================================
//  DELETAR USUÁRIO
// ================================================================
async function confirmarDelete(uid, name) {
  const confirmado = confirm(`Remover "${name}" do sistema?\n\nO usuário perderá o acesso imediatamente.\n(A conta de e-mail no Firebase Auth é mantida)`);
  if (!confirmado) return;

  try {
    await apiFetch(`/usuarios/${uid}`, { method: 'DELETE' });
    showToast(`🗑️ ${name} removido do sistema.`, 'success');
  } catch (err) {
    showToast(`❌ Erro ao remover: ${err.message}`, 'error');
  }
}

// ================================================================
//  TOAST
// ================================================================
let toastTimer = null;
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className   = `toast toast-${type}`;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}
