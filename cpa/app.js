import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from '../core/layout.js';
import { getEffectiveLevel } from '../core/permissions.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

let currentUser = null;
let currentRole = null;
let appInitialized = false;
let initializedRole = null;

let campanhas = [];
let charts = [];

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

function showToast(msg, tipo = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast toast-${tipo}`;
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

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
    window.location.href = '../auth/login.html';
    return;
  }

  currentUser = user;
  try {
    const token = await user.getIdToken();
    let role = 'visitante';
    let meuOverrides = null;
    try {
      const userData = await apiFetch('/usuarios/me');
      role = userData.role || 'visitante';
      meuOverrides = userData.permissoes || null;
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
        level = getEffectiveLevel(perms[role] || {}, meuOverrides, 'cpa');
      } catch (e) {
        if (role === 'adm_l2' || role === 'coordenador' || role === 'ti') level = 3;
      }
    }

    if (level < 2) {
      window.location.href = '../meu-espaco/index.html';
      return;
    }

    if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
      currentRole = role;
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

  setupLayout(user, role, 'cpa', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');
  initPaginaCpa();
}

// ==========================================
// PÁGINA CPA
// ==========================================
async function initPaginaCpa() {
  const selectCampanha = document.getElementById('select-campanha');
  const selectCurso = document.getElementById('select-curso');
  const btnImprimir = document.getElementById('btn-imprimir');

  try {
    campanhas = await apiFetch('/cpa/campanhas');
  } catch (err) {
    showToast('Erro ao carregar campanhas: ' + err.message, 'error');
    return;
  }

  selectCampanha.innerHTML = '<option value="">Selecione a campanha...</option>' +
    campanhas.map(c => `<option value="${c.codava}">${esc(c.descricao)} (${esc(c.semava)})</option>`).join('');

  selectCampanha.addEventListener('change', async () => {
    const codava = selectCampanha.value;
    selectCurso.innerHTML = '<option value="">Selecione o curso...</option>';
    selectCurso.disabled = true;
    esconderRelatorio();
    if (!codava) return;

    try {
      const cursos = await apiFetch(`/cpa/cursos?codava=${encodeURIComponent(codava)}`);
      selectCurso.innerHTML = '<option value="">Selecione o curso...</option>' +
        cursos.map(c => `<option value="${esc(c.codcur)}">${esc(c.nome)}</option>`).join('');
      selectCurso.disabled = cursos.length === 0;
      if (cursos.length === 0) showToast('Nenhuma resposta encontrada pra essa campanha ainda.', 'error');
    } catch (err) {
      showToast('Erro ao carregar cursos: ' + err.message, 'error');
    }
  });

  selectCurso.addEventListener('change', async () => {
    const codava = selectCampanha.value;
    const curso = selectCurso.value;
    if (!codava || !curso) { esconderRelatorio(); return; }
    await carregarRelatorio(codava, curso);
  });

  btnImprimir.addEventListener('click', () => window.print());

  window.addEventListener('beforeprint', () => {
    charts.forEach(c => c && c.resize());
  });
}

function esconderRelatorio() {
  document.getElementById('print-page').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('btn-imprimir').disabled = true;
}

async function carregarRelatorio(codava, curso) {
  const btnImprimir = document.getElementById('btn-imprimir');
  btnImprimir.disabled = true;
  try {
    const dados = await apiFetch(`/cpa/relatorio/${encodeURIComponent(codava)}?curso=${encodeURIComponent(curso)}`);
    renderRelatorio(dados);
    btnImprimir.disabled = false;
  } catch (err) {
    showToast('Erro ao gerar relatório: ' + err.message, 'error');
  }
}

function renderRelatorio(dados) {
  document.getElementById('empty-state').classList.add('hidden');
  const printPage = document.getElementById('print-page');
  printPage.classList.remove('hidden');

  const cursoNome = document.getElementById('select-curso').selectedOptions[0]?.textContent || dados.curso;
  document.getElementById('print-titulo').textContent = `CPA — ${dados.avaliacao.descricao}`;
  document.getElementById('print-curso-label').textContent = cursoNome;
  document.getElementById('print-data-emissao').textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  charts.forEach(c => c && c.destroy());
  charts = [];

  const container = document.getElementById('dimensoes-container');
  container.innerHTML = '';

  if (dados.dimensoes.length === 0) {
    container.innerHTML = '<p class="empty-state">Nenhuma dimensão encontrada pra essa campanha.</p>';
    return;
  }

  dados.dimensoes.forEach((dim, idx) => {
    const card = document.createElement('div');
    card.className = 'chart-card full dimensao-card';

    const notaGeral = dim.mediaGeral !== null ? `${dim.mediaGeral.toFixed(1)}/10` : '—';
    const canvasId = `chart-dim-${idx}`;

    card.innerHTML = `
      <div class="dimensao-header">
        <h3>${esc(dim.nome)}</h3>
        <span class="dimensao-nota">Nota geral: <strong>${notaGeral}</strong> <span class="dimensao-total">(${dim.totalAvaliacoes} avaliações)</span></span>
      </div>
      <div class="chart-canvas-wrap"><canvas id="${canvasId}"></canvas></div>
      <div class="comentarios-bloco">
        <p class="comentarios-titulo">Comentários (${dim.comentarios.length})</p>
        ${dim.comentarios.length === 0
          ? '<p class="comentarios-vazio">Sem comentários relevantes.</p>'
          : `<ul class="comentarios-lista">${dim.comentarios.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`}
      </div>
    `;
    container.appendChild(card);

    if (dim.perguntas.length > 0) {
      const chart = criarGraficoDimensao(canvasId, dim.perguntas);
      charts.push(chart);
    }
  });
}

function criarGraficoDimensao(canvasId, perguntas) {
  const labels = perguntas.map((p, i) => `P${i + 1}`);
  const medias = perguntas.map(p => p.media);
  const cores = perguntas.map(p => corPorPositividade(positividade(p)));

  const ctx = document.getElementById(canvasId);
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Média',
        data: medias,
        backgroundColor: cores,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => perguntas[items[0].dataIndex].pergunta,
            label: (item) => {
              const p = perguntas[item.dataIndex];
              const opcaoMaisProxima = p.opcoes[Math.max(0, Math.min(p.opcoes.length - 1, Math.round(p.media) - 1))];
              return `Média: ${p.media} (${p.respostas} respostas) — ${opcaoMaisProxima || ''}`;
            },
          },
        },
      },
    },
  });
}

// Normaliza a média (1..N, direção pode ser invertida) pra um "0=ruim..1=bom"
function positividade(pergunta) {
  const max = pergunta.opcoes.length || 5;
  if (pergunta.media === null) return 0.5;
  const norm = (pergunta.media - 1) / (max - 1 || 1);
  return pergunta.escalaInvertida ? (1 - norm) : norm;
}

function corPorPositividade(p) {
  if (p >= 0.66) return '#10B981';
  if (p >= 0.4) return '#F59E0B';
  return '#EF4444';
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
