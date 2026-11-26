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
let appInitialized = false;
let initializedRole = null;

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

const fmtMoeda = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ==========================================
// AUTH GUARD E INICIALIZAÇÃO (mesmo padrão de ti/acessos/app.js)
// ==========================================
const cached = getCachedAuth();
if (cached && ['adm_l1', 'adm_l2', 'ti'].includes(cached.role)) {
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
        const rawPerm = rolePerms['custos-ti'];
        level = (rawPerm !== undefined && typeof rawPerm === 'object')
          ? (rawPerm.execute ? 3 : (rawPerm.view ? 2 : 1))
          : (parseInt(rawPerm) || 1);
      } catch (e) {
        // sem fallback especial: custos-ti é restrito por padrão
      }
    }

    if (level < 2) {
      window.location.href = '../../meu-espaco/index.html';
      return;
    }

    if (!appInitialized || initializedRole !== role) {
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

  setupLayout(user, role, 'custos-ti', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');

  await Promise.all([carregarResumo(), carregarHistorico(), carregarUso()]);
}

// ==========================================
// RESUMO (cards do topo)
// ==========================================
async function carregarResumo() {
  try {
    const { gcp, digitalOcean } = await apiFetch('/custos-ti/resumo');

    if (!gcp.configurado) {
      mostrarAviso('cst-aviso-gcp', 'Google Cloud / Firebase ainda não configurado. Falta ligar o <strong>BigQuery Billing Export</strong> no Console do Google Cloud e preencher as variáveis <code>GCP_BILLING_*</code> no <code>.env</code>. Enquanto isso, os cards do Órbita e do SIGMA ficam zerados.');
    } else {
      const orbita = (gcp.porProjeto || []).find(p => p.projeto && p.projeto.includes('orbita'));
      const sigma = (gcp.porProjeto || []).find(p => p.projeto && !p.projeto.includes('orbita'));
      preencherKpi('orbita', orbita);
      preencherKpi('sigma', sigma);
    }

    if (!digitalOcean.configurado) {
      mostrarAviso('cst-aviso-do', 'DigitalOcean ainda não configurado. Falta gerar um token de API (escopo Billing) e preencher <code>DIGITALOCEAN_API_TOKEN</code> no <code>.env</code>.');
      document.getElementById('kpi-do').textContent = '—';
    } else {
      document.getElementById('kpi-do').textContent = fmtMoeda(digitalOcean.mesAtual);
      document.getElementById('kpi-do-hint').textContent = `Saldo atual: ${fmtMoeda(digitalOcean.saldo)}`;
    }

    const total = (gcp.configurado ? (gcp.porProjeto || []).reduce((s, p) => s + (p.mesAtual || 0), 0) : 0)
      + (digitalOcean.configurado ? (digitalOcean.mesAtual || 0) : 0);
    document.getElementById('kpi-total').textContent = fmtMoeda(total);
  } catch (err) {
    console.error('Erro ao carregar resumo de custos:', err);
  }
}

function preencherKpi(prefixo, dados) {
  const valorEl = document.getElementById(`kpi-${prefixo}`);
  const hintEl = document.getElementById(`kpi-${prefixo}-hint`);
  if (!dados) { valorEl.textContent = fmtMoeda(0); hintEl.textContent = ''; return; }
  valorEl.textContent = fmtMoeda(dados.mesAtual);
  const diff = dados.mesAtual - dados.mesAnterior;
  if (dados.mesAnterior > 0) {
    const pct = Math.round((diff / dados.mesAnterior) * 100);
    hintEl.textContent = `${diff >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs. mês anterior (${fmtMoeda(dados.mesAnterior)})`;
  } else {
    hintEl.textContent = '';
  }
}

function mostrarAviso(id, html) {
  const el = document.getElementById(id);
  el.innerHTML = `⚠️ ${html}`;
  el.classList.remove('hidden');
}

// ==========================================
// GRÁFICOS (Chart.js — mesmo padrão de financeiro/licitacao/app.js)
// ==========================================
let chartCustoDiario = null, chartUso = null, chartServicos = null;
const CORES = ['#0F4EB8', '#1F6FB2', '#E8791E', '#0F7A4B', '#A8650B', '#C8392F'];

async function carregarHistorico() {
  try {
    const { gcp } = await apiFetch('/custos-ti/historico?dias=30');
    if (!gcp.configurado) return; // aviso já mostrado em carregarResumo()

    const dias = [...new Set(gcp.linhas.map(l => l.dia))].sort();
    const projetos = [...new Set(gcp.linhas.map(l => l.projeto))];
    const datasets = projetos.map((proj, i) => ({
      label: proj,
      data: dias.map(dia => gcp.linhas.filter(l => l.dia === dia && l.projeto === proj).reduce((s, l) => s + l.custo, 0)),
      borderColor: CORES[i % CORES.length],
      backgroundColor: CORES[i % CORES.length],
      tension: 0.25
    }));

    if (chartCustoDiario) chartCustoDiario.destroy();
    chartCustoDiario = new Chart(document.getElementById('chart-custo-diario'), {
      type: 'line',
      data: { labels: dias, datasets },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
    });

    const servicos = [...new Set(gcp.linhas.map(l => l.servico))];
    const custoServico = servicos.map(s => gcp.linhas.filter(l => l.servico === s).reduce((sum, l) => sum + l.custo, 0));
    if (chartServicos) chartServicos.destroy();
    chartServicos = new Chart(document.getElementById('chart-servicos'), {
      type: 'bar',
      data: { labels: servicos, datasets: [{ label: 'Custo (30 dias)', data: custoServico, backgroundColor: CORES[1], borderRadius: 6 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  } catch (err) {
    console.error('Erro ao carregar histórico de custos:', err);
  }
}

async function carregarUso() {
  try {
    const { serie } = await apiFetch('/custos-ti/uso?dias=30');
    const dias = serie.map(s => s.dia);

    if (chartUso) chartUso.destroy();
    chartUso = new Chart(document.getElementById('chart-uso'), {
      type: 'bar',
      data: {
        labels: dias,
        datasets: [
          { label: 'Robô (ODTech)', data: serie.map(s => s.robo), backgroundColor: '#E8791E' },
          { label: 'Humano', data: serie.map(s => s.humano), backgroundColor: '#1F6FB2' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }
      }
    });

    const totalPorModulo = {};
    serie.forEach(s => Object.entries(s.porModulo || {}).forEach(([mod, qtd]) => {
      totalPorModulo[mod] = (totalPorModulo[mod] || 0) + qtd;
    }));
    const tbody = document.getElementById('tabela-uso-modulo-tbody');
    const linhas = Object.entries(totalPorModulo).sort((a, b) => b[1] - a[1]);
    tbody.innerHTML = linhas.length
      ? linhas.map(([mod, qtd]) => `<tr><td>${esc(mod)}</td><td>${qtd.toLocaleString('pt-BR')}</td></tr>`).join('')
      : '<tr><td colspan="2">Sem dados ainda — a contagem começa a partir de hoje.</td></tr>';
  } catch (err) {
    console.error('Erro ao carregar uso por módulo:', err);
  }
}
