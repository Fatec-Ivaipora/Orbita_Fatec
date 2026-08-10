import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../core/layout.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { getRoleConfig } from "../core/permissions.js";

import { secureAction, sanitizeHTML, escapeHTML as esc } from "../core/security.js";

const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.')) 
  ? `http://${window.location.hostname}:3000/api` 
  : '/api';

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

let currentUser = null;
let currentRole = null;
let appInitialized = false;
let initializedRole = null;

// ================================================================
//  AUTH GUARD & INIT
// ================================================================
const cached = getCachedAuth();
if (cached) {
  currentUser = cached.user;
  currentRole = cached.role;
  initApp(cached.user, cached.role);
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    try {
      const token = await user.getIdToken();
      let role = 'visitante';
      try {
        const userData = await apiFetch('/usuarios/me');
        role = userData.role || 'visitante';
      } catch(e) {
        role = cached ? cached.role : 'visitante';
      }

      setCachedAuth(user, role, token);

      if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
        currentRole = role;
        initApp(user, role);
      }
    } catch (err) {
      console.error("Erro na revalidação de auth:", err);
    }
  } else {
    clearCachedAuth();
    window.location.href = '../auth/login.html';
  }
});

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;

  setupLayout(user, role, 'dashboard', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../auth/login.html';
  });

  renderWidgets(role);
  setupNotes();
  setupNotices(role);
  setupEventListeners();
}

// ================================================================
//  WIDGETS (CONFORME PERMISSÃO)
// ================================================================
async function renderWidgets(role) {
  const container = document.getElementById('widgets-grid');
  container.innerHTML = '';
  
  const filterEl = document.getElementById('widget-filter');
  if (filterEl) filterEl.value = 'all';
  
  let dynamicPerms = null;
  if (role !== 'adm_l1') {
    try {
      dynamicPerms = await apiFetch('/usuarios/config/permissions');
    } catch(e) {}
  }
  
  const roleConfig = getRoleConfig(role);
  const modules = roleConfig.modules;

  // Helper para validar visualização baseada no banco dinâmico
  const canView = (modId) => {
    if (role === 'adm_l1') return true;
    if (dynamicPerms && dynamicPerms[role] && dynamicPerms[role][modId] !== undefined) {
      const rawPerm = dynamicPerms[role][modId];
      const userLevel = (rawPerm !== undefined && typeof rawPerm === 'object')
        ? (rawPerm.execute ? 3 : (rawPerm.view ? 2 : 1))
        : (parseInt(rawPerm) || 1);
      return userLevel >= 2;
    }
    return true; // Fallback se falhar
  };

  // Widget Empréstimos
  if (modules.includes('emprestimo') && canView('emprestimo')) {
    const card = createWidgetCard('📦', 'Empréstimos Ativos', '0', 'emprestimo');
    container.appendChild(card);
  }

  // Widget Usuários
  if (modules.includes('usuarios') && (role === 'adm_l1' || role === 'adm_l2') && canView('usuarios')) {
    const card = createWidgetCard('👥', 'Usuários Ativos', '...', 'usuarios');
    container.appendChild(card);
    try {
      const users = await apiFetch('/usuarios');
      card.querySelector('.widget-value').textContent = users.length;
    } catch(e) { card.querySelector('.widget-value').textContent = '-'; }
  }

  // Widget Carga Horária
  if (modules.includes('carga-horaria') && canView('carga-horaria')) {
    const card = createWidgetCard('⏰', 'Eventos do Mês', '0', 'carga-horaria');
    container.appendChild(card);
  }

  // Widget Administração (Só N1)
  if (role === 'adm_l1') {
    const card = createWidgetCard('🛡️', 'Admin Status', 'Ativo', 'dashboard');
    container.appendChild(card);
  }
}

function createWidgetCard(icon, label, value, modId) {
  const div = document.createElement('div');
  div.className = 'widget-card';
  div.dataset.module = modId;
  div.innerHTML = `
    <div class="widget-icon">${icon}</div>
    <div class="widget-info">
      <span class="widget-label">${label}</span>
      <span class="widget-value">${value}</span>
    </div>
  `;
  return div;
}

// ================================================================
//  QUADRO DO FUNCIONÁRIO (POST-ITS)
// ================================================================
function setupNotes() {
  const notesGrid = document.getElementById('notes-grid');
  
  async function loadNotes() {
    try {
      const allNotes = await apiFetch('/meu-espaco/notes');
      notesGrid.innerHTML = '';
      if (allNotes.length === 0) {
        notesGrid.innerHTML = '<div class="loading-state">Nenhuma nota criada. Que tal começar agora?</div>';
        return;
      }
      
      // Ordenar manualmente: Pinned primeiro
      allNotes.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      renderNotes(allNotes, notesGrid);
    } catch(err) { console.error(err); }
  }

  setInterval(() => {
    if (!document.hidden) loadNotes();
  }, 120000);
  loadNotes();
  window.loadNotes = loadNotes; // Expose to global for refresh after save
}

function renderNotes(allNotes, notesGrid) {

    // Ordenar manualmente: Pinned primeiro
    allNotes.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

    allNotes.forEach(note => {
      const id = note.id;
      const card = document.createElement('div');
      card.className = `note-card ${note.pinned ? 'pinned' : ''}`;
      card.style.backgroundColor = note.color || '#fef9c3';
      
      // Posicionamento livre
      if (note.x !== undefined && note.y !== undefined) {
        card.style.position = 'absolute';
        card.style.left = note.x + 'px';
        card.style.top = note.y + 'px';
        card.style.margin = '0';
      }

      card.innerHTML = `
        ${note.pinned ? '<span class="pin-indicator">📌</span>' : ''}
        <div class="note-title">${esc(note.title || 'Sem título')}</div>
        <div class="note-text-display">${note.text || ''}</div>
        <div class="note-actions">
          <button class="note-btn btn-pin" title="${note.pinned ? 'Desafixar' : 'Fixar'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c-5.07 0-9.17-4.1-9.17-9.17"/><path d="M10 21c0-5.07-4.1-9.17-9.17-9.17"/></svg>
          </button>
          <button class="note-btn btn-edit" title="Editar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="note-btn btn-delete" title="Excluir">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      `;

      // Drag Logic
      setupDraggable(card, id);

      card.querySelector('.btn-pin').onclick = (e) => { e.stopPropagation(); togglePinNote(id, note.pinned); };
      card.querySelector('.btn-edit').onclick = (e) => { e.stopPropagation(); openNoteModal(id, note); };
      card.querySelector('.btn-delete').onclick = (e) => { e.stopPropagation(); deleteNote(id); };

      notesGrid.appendChild(card);
    });
}

async function saveNote(e) {
  e.preventDefault();
  const id = document.getElementById('note-id').value;
  const title = document.getElementById('note-title').value.trim();
  const rawText = document.getElementById('note-text').innerHTML;
  const text = sanitizeHTML(rawText);
  const color = document.querySelector('input[name="note-color"]:checked').value;

  if (!text || text === '<br>') return;

  const noteData = {
    title,
    text,
    color
  };

  try {
    await secureAction(currentUser.uid, async () => {
      if (id) {
        await apiFetch(`/meu-espaco/notes/${id}`, { method: 'PUT', body: JSON.stringify(noteData) });
      } else {
        noteData.pinned = false;
        noteData.x = 20 + (Math.random() * 50);
        noteData.y = 20 + (Math.random() * 50);
        await apiFetch('/meu-espaco/notes', { method: 'POST', body: JSON.stringify(noteData) });
      }
    });
    fecharModal('modal-note');
    if (window.loadNotes) window.loadNotes();

  } catch (err) {
    if (err.message.includes("Rate limit")) return; // Alerta já mostrado pelo security.js
    alert("Erro ao salvar nota: " + err.message);
  }
}

function setupDraggable(el, id) {
  let isDragging = false;
  let startX, startY;

  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('.note-actions')) return;
    isDragging = true;
    startX = e.clientX - el.offsetLeft;
    startY = e.clientY - el.offsetTop;
    el.style.zIndex = '1000';
    el.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const canvas = document.getElementById('notes-grid');
    const rect = canvas.getBoundingClientRect();
    
    let x = e.clientX - startX;
    let y = e.clientY - startY;

    // Limitar movimento ao canvas
    const maxX = rect.width - el.offsetWidth;
    const maxY = rect.height - el.offsetHeight;
    
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > maxX) x = maxX;
    if (y > maxY) y = maxY;

    el.style.position = 'absolute';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  });

  document.addEventListener('mouseup', async () => {
    if (!isDragging) return;
    isDragging = false;
    el.style.cursor = 'default';
    el.style.zIndex = '10';

    const x = parseInt(el.style.left);
    const y = parseInt(el.style.top);

    try {
      await secureAction(currentUser.uid, async () => {
        await apiFetch(`/meu-espaco/notes/${id}`, { method: 'PUT', body: JSON.stringify({ x, y }) });
      });
    } catch (err) {
      console.error("Erro ao salvar posição:", err);
    }
  });
}

async function togglePinNote(id, current) {
  await apiFetch(`/meu-espaco/notes/${id}`, { method: 'PUT', body: JSON.stringify({ pinned: !current }) });
  if (window.loadNotes) window.loadNotes();
}

async function deleteNote(id) {
  if (confirm("Deseja excluir esta nota?")) {
    await apiFetch(`/meu-espaco/notes/${id}`, { method: 'DELETE' });
    if (window.loadNotes) window.loadNotes();
  }
}

function openNoteModal(id = '', data = null) {
  document.getElementById('form-note').reset();
  document.getElementById('note-id').value = id;
  document.getElementById('note-modal-title').textContent = id ? 'Editar Nota' : 'Nova Nota';
  
  if (data) {
    document.getElementById('note-title').value = data.title || '';
    document.getElementById('note-text').innerHTML = data.text || '';
    const radio = document.querySelector(`input[name="note-color"][value="${data.color}"]`);
    if (radio) radio.checked = true;
  } else {
    document.getElementById('note-text').innerHTML = '';
  }
  
  abrirModal('modal-note');
}

// FORMATAÇÃO RICH TEXT
window.formatDoc = (cmd, val = null) => {
  document.execCommand(cmd, false, val);
  document.getElementById('note-text').focus();
};

// ================================================================
//  QUADRO DE AVISOS (INSTITUCIONAL)
// ================================================================
function setupNotices(role) {
  const noticesList = document.getElementById('notices-list');
  const btnManage = document.getElementById('btn-new-notice');
  
  const canManage = (role === 'adm_l1' || role === 'adm_l2');
  if (canManage) btnManage.classList.remove('hidden');

  async function loadNotices() {
    try {
      const allNotices = await apiFetch('/meu-espaco/notices');
      noticesList.innerHTML = '';
      
      const activeNotices = allNotices.filter(n => n.active !== false);

      if (activeNotices.length === 0) {
        noticesList.innerHTML = '<div class="loading-state">Nenhum aviso no momento.</div>';
        return;
      }
      
      renderNotices(activeNotices, noticesList, canManage);
    } catch(err) { console.error(err); }
  }

  setInterval(() => {
    if (!document.hidden) loadNotices();
  }, 120000);
  loadNotices();
  window.loadNotices = loadNotices;
}

function renderNotices(activeNotices, noticesList, canManage) {

    activeNotices.forEach(notice => {
      const id = notice.id;
      const card = document.createElement('div');
      card.className = `notice-card priority-${notice.priority}`;
      card.innerHTML = `
        <div class="notice-title">${esc(notice.title)}</div>
        <div class="notice-message">${esc(notice.message)}</div>
        <div class="notice-meta">
          <span>${notice.createdAt ? new Date(notice.createdAt._seconds ? notice.createdAt._seconds * 1000 : notice.createdAt).toLocaleDateString('pt-BR') : 'Agora'}</span>
          ${canManage ? `
            <div class="notice-admin-actions">
              <button class="btn-edit-notice" title="Editar">Editar</button>
              <button class="btn-delete-notice" title="Excluir">Excluir</button>
            </div>
          ` : ''}
        </div>
      `;
      
      if (canManage) {
        card.querySelector('.btn-edit-notice').onclick = () => openNoticeModal(id, notice);
        card.querySelector('.btn-delete-notice').onclick = () => deleteNotice(id, notice.title);
      }

      noticesList.appendChild(card);
    });
}

async function saveNotice(e) {
  e.preventDefault();
  const id = document.getElementById('notice-id').value;
  const title = document.getElementById('notice-title').value.trim();
  const message = document.getElementById('notice-message').value.trim();
  const priority = document.getElementById('notice-priority').value;

  const data = {
    title, message, priority,
    active: true
  };

  try {
    if (id) {
      await apiFetch(`/meu-espaco/notices/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await apiFetch('/meu-espaco/notices', { method: 'POST', body: JSON.stringify(data) });
    }
    fecharModal('modal-notice');
    if (window.loadNotices) window.loadNotices();
  } catch (err) {
    alert("Erro ao salvar aviso: " + err.message);
  }
}

async function deleteNotice(id, title) {
  if (confirm(`Deseja excluir permanentemente o aviso "${title}"?`)) {
    try {
      await apiFetch(`/meu-espaco/notices/${id}`, { method: 'DELETE' });
      if (window.loadNotices) window.loadNotices();
    } catch (err) {
      alert("Erro ao excluir: " + err.message);
    }
  }
}

function openNoticeModal(id = '', data = null) {
  document.getElementById('form-notice').reset();
  document.getElementById('notice-id').value = id;
  if (data) {
    document.getElementById('notice-title').value = data.title;
    document.getElementById('notice-message').value = data.message;
    document.getElementById('notice-priority').value = data.priority;
  }
  abrirModal('modal-notice');
}

// ================================================================
//  HELPERS & EVENTS
// ================================================================
function setupEventListeners() {
  document.getElementById('btn-new-note').onclick = () => openNoteModal();
  document.getElementById('btn-new-notice').onclick = () => openNoticeModal();
  document.getElementById('form-note').onsubmit = saveNote;
  document.getElementById('form-notice').onsubmit = saveNotice;

  const filterEl = document.getElementById('widget-filter');
  if (filterEl) {
    filterEl.onchange = (e) => {
      const selected = e.target.value;
      const cards = document.querySelectorAll('#widgets-grid .widget-card');
      cards.forEach(card => {
        if (selected === 'all' || card.dataset.module === selected) {
          card.style.display = '';
        } else {
          card.style.display = 'none';
        }
      });
    };
  }
}

window.abrirModal = (id) => document.getElementById(id).classList.add('active');
window.fecharModal = (id) => document.getElementById(id).classList.remove('active');



