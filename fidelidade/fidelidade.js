import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

import { firebaseConfig } from "../core/firebase-config.js";
import { getRoleConfig } from "../core/permissions.js";
import { getCachedAuth, setCachedAuth, clearCachedAuth } from "../core/layout.js";

const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.')) 
  ? `http://${window.location.hostname}:3000/api` 
  : '/api';

let currentUser = null;
let currentRole = null;
let qrcodeInstance = null;
let suspensionCheckInterval = null;
let allPartners = [];
let selectedCategory = 'Todos';
let searchQuery = '';
let isSuspended = false;
let deferredPrompt = null;

// Helper to escape HTML characters for security (XSS prevention)
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function apiFetch(endpoint, options = {}) {
  const user = auth.currentUser || (currentUser ? currentUser : (getCachedAuth() ? getCachedAuth().user : null));
  if (!user) throw new Error("Usuário não autenticado");
  
  const token = typeof user.getIdToken === 'function' ? await user.getIdToken() : localStorage.getItem('orbita_token');
  
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

function showApp() {
  const guard = document.getElementById('auth-guard');
  const app = document.getElementById('app');
  if (guard) guard.style.display = 'none';
  if (app) app.classList.remove('hidden');
}

function handleSuspension() {
  isSuspended = true;
  if (suspensionCheckInterval) clearInterval(suspensionCheckInterval);
  
  const qrcodeActive = document.getElementById('qrcode-active');
  const qrcodeSuspended = document.getElementById('qrcode-suspended');
  const userStatus = document.getElementById('user-status');
  
  if (qrcodeActive) qrcodeActive.classList.add('hidden');
  if (qrcodeSuspended) qrcodeSuspended.classList.remove('hidden');
  
  if (userStatus) {
    userStatus.textContent = 'INATIVO';
    userStatus.className = 'footer-val status-inactive';
  }
  
  showApp();
}

function generateQRCode(uid) {
  let currentOrigin = window.location.origin;
  if (window.location.hostname.endsWith('vercel.app')) {
    currentOrigin = 'https://orbita-fatec-ti.vercel.app';
  }
  const qrText = `${currentOrigin}/fidelidade/validar.html?u=${uid}`;
  
  const qrcodeContainer = document.getElementById("qrcode");
  if (!qrcodeContainer) return;
  
  if (!qrcodeInstance) {
    qrcodeInstance = new QRCode(qrcodeContainer, {
      text: qrText,
      width: 180,
      height: 180,
      colorDark : "#031426",
      colorLight : "#ffffff",
      correctLevel : QRCode.CorrectLevel.M
    });
  } else {
    qrcodeInstance.clear();
    qrcodeInstance.makeCode(qrText);
  }
}

function startStatusChecker() {
  if (suspensionCheckInterval) clearInterval(suspensionCheckInterval);
  
  suspensionCheckInterval = setInterval(async () => {
    if (document.hidden) return; // Economiza leituras no Firebase se a aba estiver inativa
    
    try {
      const userData = await apiFetch('/usuarios/me');
      if (userData.ativo === false) {
        handleSuspension();
      }
    } catch (e) {
      console.warn("Erro ao verificar status do usuário:", e);
    }
  }, 120000); // Revalidação a cada 2 minutos
}

window.gerarPDF = function() {
  const printArea = document.getElementById('print-area');
  if (!printArea) return;
  
  printArea.innerHTML = '';
  
  // Criar o cartão dobrável (frente + linha de dobra + verso)
  const foldedCard = document.createElement('div');
  foldedCard.className = 'print-folded-card';
  
  // Clone da frente do cartão
  const digitalCard = document.getElementById('digital-card');
  if (!digitalCard) return;
  const clonedCard = digitalCard.cloneNode(true);
  clonedCard.removeAttribute('id'); // remove ID para evitar IDs duplicados
  
  // Linha de dobra tracejada
  const foldLine = document.createElement('div');
  foldLine.className = 'print-fold-line';
  
  // Verso do cartão
  const cardBack = document.createElement('div');
  cardBack.className = 'digital-card-print-back';
  
  // Clona apenas a imagem do QR Code
  const qrImg = document.querySelector('#qrcode img');
  if (!qrImg) return;
  const clonedQRImg = qrImg.cloneNode(true);
  clonedQRImg.className = 'print-qr-image';
  clonedQRImg.removeAttribute('style'); // Remove estilos inline para evitar conflitos de tamanho
  
  const backText = document.createElement('span');
  backText.className = 'print-back-text';
  backText.textContent = 'FATEC — CARTÃO DE BENEFÍCIOS';

  const backNotice = document.createElement('span');
  backNotice.className = 'print-back-notice';
  backNotice.textContent = 'Uso pessoal e intransferível';

  cardBack.appendChild(clonedQRImg);
  cardBack.appendChild(backNotice);
  cardBack.appendChild(backText);
  
  foldedCard.appendChild(clonedCard);
  foldedCard.appendChild(foldLine);
  foldedCard.appendChild(cardBack);
  
  printArea.appendChild(foldedCard);
  
  window.print();
};

function renderPartners(partners) {
  const grid = document.getElementById('partners-grid');
  if (!grid) return;
  
  // Exibir o total geral de empresas filiadas
  const totalTextEl = document.getElementById('partners-total-text');
  const totalContainerEl = document.getElementById('partners-total-container');
  if (totalTextEl && totalContainerEl) {
    totalTextEl.textContent = `Total: ${allPartners.length} empresas filiadas`;
    totalContainerEl.classList.remove('hidden');
  }

  if (!partners || partners.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25">
          <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
        </svg>
        <p>Nenhum parceiro encontrado.</p>
      </div>
    `;
    return;
  }
  
  // Limita a exibição a no máximo 3 empresas parceiras
  const visiblePartners = partners.slice(0, 3);
  
  grid.innerHTML = visiblePartners.map(p => {
    const initial = (p.nome || '?').charAt(0).toUpperCase();
    const discountText = p.desconto ? esc(p.desconto) : 'Desconto Especial';
    const locationText = p.localizacao ? esc(p.localizacao) : 'Consultar filial';
    const categoryText = p.categoria ? esc(p.categoria) : 'Parceiro';
    const descText = p.descricao ? esc(p.descricao) : '';
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.localizacao || p.nome)}`;
    
    return `
      <div class="partner-card" onclick="this.classList.toggle('expanded')" tabindex="0" role="button" aria-expanded="false">
        <div class="partner-header-row">
          <div class="partner-avatar">${initial}</div>
          <div class="partner-summary">
            <span class="partner-name" title="${esc(p.nome)}">${esc(p.nome)}</span>
            <span class="partner-category-badge">${categoryText}</span>
          </div>
          <div class="partner-toggle-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </div>
        </div>
        
        <div class="partner-details-expand">
          <div class="partner-expand-inner">
            <div class="partner-discount-badge-container">
              <span class="partner-discount-label">Benefício:</span>
              <span class="partner-discount-value">${discountText}</span>
            </div>
            
            ${descText ? `<p class="partner-description-text">${descText}</p>` : ''}
            
            <a href="${mapsUrl}" target="_blank" class="partner-location-link" onclick="event.stopPropagation();">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
              <span>${locationText} (Abrir no GPS)</span>
            </a>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function applyFilters() {
  let filtered = allPartners;
  
  if (selectedCategory !== 'Todos') {
    filtered = filtered.filter(p => (p.categoria || '').trim() === selectedCategory);
  }
  
  if (searchQuery) {
    filtered = filtered.filter(p => {
      const nameMatch = (p.nome || '').toLowerCase().includes(searchQuery);
      const categoryMatch = (p.categoria || '').toLowerCase().includes(searchQuery);
      const descMatch = (p.descricao || '').toLowerCase().includes(searchQuery);
      const locMatch = (p.localizacao || '').toLowerCase().includes(searchQuery);
      return nameMatch || categoryMatch || descMatch || locMatch;
    });
  }
  
  renderPartners(filtered);
}

function renderCategoryFilters() {
  const container = document.getElementById('category-filters');
  if (!container) return;
  
  const categories = [...new Set(allPartners.map(p => (p.categoria || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const allCategories = ['Todos', ...categories];
  
  container.innerHTML = allCategories.map(cat => {
    const isActive = cat === selectedCategory;
    return `
      <button class="category-btn ${isActive ? 'active' : ''}" data-category="${esc(cat)}">
        ${esc(cat)}
      </button>
    `;
  }).join('');
  
  container.querySelectorAll('.category-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCategory = btn.getAttribute('data-category');
      
      container.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      applyFilters();
    });
  });
}

async function loadPartnersList() {
  const grid = document.getElementById('partners-grid');
  try {
    const data = await apiFetch('/empresas');
    allPartners = data.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    renderCategoryFilters();
    applyFilters();
  } catch (err) {
    console.error("Erro ao carregar parceiros:", err);
    if (grid) {
      grid.innerHTML = `
        <div class="empty-state">
          <p style="color: var(--error);">Falha ao carregar parceiros credenciados. Tente novamente mais tarde.</p>
        </div>
      `;
    }
  }
}

function setupSearch() {
  const searchInput = document.getElementById('partner-search');
  if (!searchInput) return;
  
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    applyFilters();
  });
}

function setupPWABanner() {
  const banner = document.getElementById('pwa-install-banner');
  const closeBtn = document.getElementById('pwa-close-btn');
  const stepsContainer = document.getElementById('pwa-install-steps');
  const instructionText = document.getElementById('pwa-instruction-text');
  
  if (!banner || !stepsContainer) return;
  
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isStandalone) {
    banner.classList.add('hidden');
    return;
  }
  
  if (closeBtn) {
    closeBtn.onclick = () => {
      banner.classList.add('hidden');
      localStorage.setItem('pwa-banner-dismissed', 'true');
    };
  }
  
  if (localStorage.getItem('pwa-banner-dismissed') === 'true') {
    return;
  }
  
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isAndroid = /Android/i.test(navigator.userAgent);
  
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    
    if (instructionText) {
      instructionText.textContent = "Instale o FATEC Card na sua tela inicial para acesso rápido.";
    }
    
    stepsContainer.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        <button id="pwa-install-btn" class="pwa-action-btn">Instalar Agora</button>
        <div class="pwa-step-item">
          <span>Ou toque no menu <strong style="color:var(--text-main);">⋮</strong> e selecione <strong>Adicionar à Tela de início</strong></span>
        </div>
      </div>
    `;
    
    const installBtn = document.getElementById('pwa-install-btn');
    if (installBtn) {
      installBtn.onclick = async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          console.log(`User response to the install prompt: ${outcome}`);
          deferredPrompt = null;
          banner.classList.add('hidden');
        }
      };
    }
    
    banner.classList.remove('hidden');
  });
  
  if (isIOS) {
    if (instructionText) {
      instructionText.textContent = "Adicione este atalho na tela inicial do seu iPhone.";
    }
    stepsContainer.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.25rem;">
        <div class="pwa-step-item" style="margin-bottom: 0.25rem;">
          <span>1. Toque no botão de <strong>Compartilhar</strong> no Safari</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--secondary)" stroke-width="2.5" style="margin-left: 5px; vertical-align: middle;">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
            <polyline points="16 6 12 2 8 6"/>
            <line x1="12" y1="2" x2="12" y2="15"/>
          </svg>
        </div>
        <div class="pwa-step-item">
          <span>2. Role a lista e selecione <strong>Adicionar à Tela de Início</strong></span>
          <span style="font-weight: 800; font-size: 1.2rem; line-height: 1; margin-left: 5px; color: var(--accent);">+</span>
        </div>
      </div>
    `;
    banner.classList.remove('hidden');
  } else if (isAndroid && !deferredPrompt) {
    if (instructionText) {
      instructionText.textContent = "Adicione o FATEC Card na tela inicial do seu Android.";
    }
    stepsContainer.innerHTML = `
      <div class="pwa-step-item">
        <span>Toque no menu de opções <strong style="color:var(--text-main);">⋮</strong> (canto superior direito) e selecione <strong>Adicionar à Tela de início</strong> ou <strong>Instalar app</strong>.</span>
      </div>
    `;
    banner.classList.remove('hidden');
  }
}

function initFidelidade(userData) {
  const userNameEl = document.getElementById('user-name');
  const userEmailEl = document.getElementById('user-email');
  const userRoleBadgeEl = document.getElementById('user-role-badge');
  const userAvatarPhotoEl = document.getElementById('user-avatar-photo');
  const userAvatarInitialsEl = document.getElementById('user-avatar-initials');
  const userIdCodeEl = document.getElementById('user-id-code');
  const userStatusEl = document.getElementById('user-status');
  
  if (userNameEl) userNameEl.textContent = userData.name || 'Visitante';
  if (userEmailEl) userEmailEl.textContent = userData.email || '';
  
  if (userIdCodeEl) {
    const shortUid = userData.uid ? userData.uid.substring(0, 8).toUpperCase() : '------';
    userIdCodeEl.textContent = `#${shortUid}`;
  }
  
  const roleConfig = getRoleConfig(userData.role || 'visitante');
  
  if (userRoleBadgeEl) {
    userRoleBadgeEl.textContent = roleConfig.label;
    
    let roleClass = userData.role || 'visitante';
    if (roleClass.startsWith('adm_')) {
      roleClass = 'adm';
    }
    userRoleBadgeEl.className = `role-badge ${roleClass}`;
  }
  
  const names = (userData.name || 'Visitante').trim().split(/\s+/);
  const initials = names.length > 1
    ? (names[0][0] + names[names.length - 1][0]).toUpperCase()
    : names[0][0].toUpperCase();
  if (userAvatarInitialsEl) userAvatarInitialsEl.textContent = initials;

  // Foto do funcionário (opcional): quando cadastrada, substitui as iniciais.
  // Até o RH terminar de organizar as fotos de todo mundo, o fallback de
  // iniciais garante que o cartão continua funcionando normalmente.
  if (userAvatarPhotoEl) {
    if (userData.fotoUrl) {
      userAvatarPhotoEl.onerror = () => {
        userAvatarPhotoEl.classList.add('hidden');
        if (userAvatarInitialsEl) userAvatarInitialsEl.classList.remove('hidden');
      };
      userAvatarPhotoEl.src = userData.fotoUrl;
      userAvatarPhotoEl.classList.remove('hidden');
      if (userAvatarInitialsEl) userAvatarInitialsEl.classList.add('hidden');
    } else {
      userAvatarPhotoEl.classList.add('hidden');
      if (userAvatarInitialsEl) userAvatarInitialsEl.classList.remove('hidden');
    }
  }
  
  if (userData.ativo === false) {
    handleSuspension();
    return;
  }
  
  isSuspended = false;
  
  const qrcodeActive = document.getElementById('qrcode-active');
  const qrcodeSuspended = document.getElementById('qrcode-suspended');
  if (qrcodeActive) qrcodeActive.classList.remove('hidden');
  if (qrcodeSuspended) qrcodeSuspended.classList.add('hidden');
  
  if (userStatusEl) {
    userStatusEl.textContent = 'ATIVO';
    userStatusEl.className = 'footer-val status-active';
  }
  
  generateQRCode(userData.uid);
  startStatusChecker();
  loadPartnersList();
  showApp();
}

// Check auth state revalidation
const cached = getCachedAuth();
if (cached) {
  currentUser = cached.user;
  currentRole = cached.role;
  initFidelidade({
    uid: cached.user.uid,
    name: cached.user.displayName || cached.user.email.split('@')[0],
    email: cached.user.email,
    role: cached.role,
    ativo: true,
    nascimento: ''
  });
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    try {
      const token = await user.getIdToken();
      const userData = await apiFetch('/usuarios/me');
      
      if (userData.ativo === false) {
        handleSuspension();
        return;
      }
      
      currentRole = userData.role || 'visitante';
      setCachedAuth(user, currentRole, token);
      
      initFidelidade(userData);
    } catch (err) {
      console.error("Erro na revalidação do estado de autenticação:", err);
      // fallback to cached data if we can
      if (!cached) {
        clearCachedAuth();
        window.location.href = `../auth/login.html?redirect=/fidelidade/index.html`;
      }
    }
  } else {
    clearCachedAuth();
    window.location.href = `../auth/login.html?redirect=/fidelidade/index.html`;
  }
});

// Setup actions (Logout and back panel)
const logoutBtn = document.getElementById('btn-logout');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    if (confirm("Deseja mesmo sair do Órbita?")) {
      clearCachedAuth();
      await signOut(auth);
      window.location.href = '../auth/login.html';
    }
  });
}

const backBtn = document.getElementById('btn-back-panel');
if (backBtn) {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (!isStandalone) {
    backBtn.classList.remove('hidden');
  }
}

// Initial triggers
setupSearch();
setupPWABanner();
