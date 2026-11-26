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

  setupFiltros();
  await Promise.all([carregarResumo(), carregarHistorico({ visao: 'dias' }), carregarUso()]);
}

// ==========================================
// FILTRO DE PERÍODO: "Últimos 30 dias" (diário) | "Comparar meses" (um
// ponto por mês, lado a lado) | "Um mês específico" (diário, só aquele mês)
// ==========================================
function setupFiltros() {
  const selectMes = document.getElementById('cst-select-mes');
  const selectQtdMeses = document.getElementById('cst-select-qtd-meses');

  // Últimos 12 meses pro seletor de "mês específico" — não depende de ter
  // dado ainda (a lista é só de datas, a API devolve vazio se não tiver nada).
  const hoje = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const valor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const rotulo = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const opt = document.createElement('option');
    opt.value = valor;
    opt.textContent = rotulo.charAt(0).toUpperCase() + rotulo.slice(1);
    selectMes.appendChild(opt);
  }

  function aplicar() {
    const visao = document.querySelector('.cst-filtro-btn.active').dataset.visao;
    if (visao === 'dias') carregarHistorico({ visao: 'dias' });
    else if (visao === 'comparar') carregarHistorico({ visao: 'comparar', meses: Number(selectQtdMeses.value) });
    else carregarHistorico({ visao: 'mes', mes: selectMes.value });
  }

  document.querySelectorAll('.cst-filtro-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cst-filtro-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectMes.classList.toggle('hidden', btn.dataset.visao !== 'mes');
      selectQtdMeses.classList.toggle('hidden', btn.dataset.visao !== 'comparar');
      aplicar();
    });
  });
  selectMes.addEventListener('change', aplicar);
  selectQtdMeses.addEventListener('change', aplicar);
}

// ==========================================
// RESUMO (cards do topo, um por projeto que a API devolver — não fixo em
// nomes, pra aguentar mais projetos no futuro sem mexer na tela)
// ==========================================
const ICONES_KPI = [
  '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>', // globo (projeto GCP genérico)
  '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' // grade (projeto GCP genérico, 2ª cor)
];
const ICONE_DO = '<path d="M22 12.5a9.5 9.5 0 1 1 -9.5 -9.5"/><path d="M12.5 3v9.5h9.5"/>';
const ICONE_TOTAL = '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>';

function cardKpi({ id, cor, icone, label, valor, hint }) {
  return `
    <div class="kpi-card kpi-destaque cst-kpi-cor-${cor}">
      <div class="cst-kpi-topo">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icone}</svg>
        <div class="kpi-label">${esc(label)}</div>
      </div>
      <div class="kpi-value" id="${id}">${valor}</div>
      <div class="kpi-hint" id="${id}-hint">${hint || ''}</div>
    </div>`;
}

function hintVariacao(dados) {
  if (!dados || !dados.mesAnterior) return '';
  const diff = dados.mesAtual - dados.mesAnterior;
  const pct = Math.round((diff / dados.mesAnterior) * 100);
  return `${diff >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs. mês anterior (${fmtMoeda(dados.mesAnterior)})`;
}

async function carregarResumo() {
  try {
    const { gcp, digitalOcean } = await apiFetch('/custos-ti/resumo');
    const cards = [];

    if (!gcp.configurado) {
      mostrarAviso('cst-aviso-gcp', 'Google Cloud / Firebase ainda não configurado. Falta ligar o <strong>BigQuery Billing Export</strong> no Console do Google Cloud e preencher as variáveis <code>GCP_BILLING_*</code> no <code>.env</code>. Enquanto isso, não dá pra mostrar nenhum card de projeto do GCP.');
    } else if (!(gcp.porProjeto || []).length) {
      // Configurado certo, mas a tabela do BigQuery ainda não recebeu
      // nenhuma linha — normal até 24h depois de ligar a exportação.
      mostrarAviso('cst-aviso-gcp', 'Google Cloud/Firebase está configurado certinho, mas o BigQuery ainda não recebeu nenhum dado de custo — o Google demora até 24h depois de ligar a exportação pra mandar a primeira linha. Os cards de projeto do GCP aparecem assim que isso chegar.');
    } else {
      (gcp.porProjeto || []).forEach((p, i) => {
        cards.push(cardKpi({
          id: `kpi-projeto-${i}`, cor: i % ICONES_KPI.length, icone: ICONES_KPI[i % ICONES_KPI.length],
          label: `${p.nome} este mês`, valor: fmtMoeda(p.mesAtual), hint: hintVariacao(p)
        }));
      });
    }

    if (!digitalOcean.configurado) {
      mostrarAviso('cst-aviso-do', 'DigitalOcean ainda não configurado. Falta gerar um token de API (escopo Billing) e preencher <code>DIGITALOCEAN_API_TOKEN</code> no <code>.env</code>.');
    } else {
      cards.push(cardKpi({
        id: 'kpi-do', cor: 2, icone: ICONE_DO,
        label: 'DigitalOcean (relay) este mês', valor: fmtMoeda(digitalOcean.mesAtual),
        hint: `Saldo atual: ${fmtMoeda(digitalOcean.saldo)}`
      }));
    }

    const total = (gcp.configurado ? (gcp.porProjeto || []).reduce((s, p) => s + (p.mesAtual || 0), 0) : 0)
      + (digitalOcean.configurado ? (digitalOcean.mesAtual || 0) : 0);
    // Card "Total" é sempre fixo (verde, sempre o último) — não entra no
    // ciclo de cores dos projetos.
    cards.push(`
      <div class="kpi-card kpi-destaque cst-kpi-total">
        <div class="cst-kpi-topo">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONE_TOTAL}</svg>
          <div class="kpi-label">Total este mês</div>
        </div>
        <div class="kpi-value" id="kpi-total">${fmtMoeda(total)}</div>
      </div>`);
    document.getElementById('kpi-cards').innerHTML = cards.join('');
  } catch (err) {
    console.error('Erro ao carregar resumo de custos:', err);
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
const MESES_PT = { '01': 'jan', '02': 'fev', '03': 'mar', '04': 'abr', '05': 'mai', '06': 'jun', '07': 'jul', '08': 'ago', '09': 'set', '10': 'out', '11': 'nov', '12': 'dez' };
const rotuloPeriodo = (p) => p.length === 7 ? `${MESES_PT[p.slice(5)]}/${p.slice(2, 4)}` : p.slice(8) + '/' + p.slice(5, 7);

async function carregarHistorico({ visao, meses, mes } = {}) {
  const titulo = document.getElementById('chart-custo-titulo');
  let query, tituloTxt;
  if (visao === 'comparar') { query = `periodo=${meses}m`; tituloTxt = `Custo mensal por projeto (últimos ${meses} meses)`; }
  else if (visao === 'mes') { query = `periodo=${mes}`; tituloTxt = `Custo diário por projeto — ${document.getElementById('cst-select-mes').selectedOptions[0].textContent}`; }
  else { query = 'periodo=30d'; tituloTxt = 'Custo diário por projeto (últimos 30 dias)'; }
  titulo.textContent = tituloTxt;

  try {
    const { gcp } = await apiFetch(`/custos-ti/historico?${query}`);
    const semDados = document.getElementById('cst-sem-dados');
    if (!gcp.configurado) return; // aviso já mostrado em carregarResumo()

    if (!gcp.linhas.length) {
      semDados.classList.remove('hidden');
      if (chartCustoDiario) { chartCustoDiario.destroy(); chartCustoDiario = null; }
    } else {
      semDados.classList.add('hidden');
      const periodos = [...new Set(gcp.linhas.map(l => l.periodo))].sort();
      const projetos = [...new Set(gcp.linhas.map(l => l.projeto))];
      const datasets = projetos.map((proj, i) => {
        const nome = gcp.linhas.find(l => l.projeto === proj).nomeProjeto;
        return {
          label: nome,
          data: periodos.map(p => gcp.linhas.filter(l => l.periodo === p && l.projeto === proj).reduce((s, l) => s + l.custo, 0)),
          borderColor: CORES[i % CORES.length],
          backgroundColor: CORES[i % CORES.length],
          tension: 0.25
        };
      });
      const labels = periodos.map(rotuloPeriodo);

      if (chartCustoDiario) chartCustoDiario.destroy();
      chartCustoDiario = new Chart(document.getElementById('chart-custo-diario'), {
        type: gcp.granularidade === 'mes' ? 'bar' : 'line', // mês a mês fica mais claro em barras lado a lado do que em linha
        data: { labels, datasets },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
      });
    }

    const servicos = [...new Set(gcp.linhas.map(l => l.servico))];
    const custoServico = servicos.map(s => gcp.linhas.filter(l => l.servico === s).reduce((sum, l) => sum + l.custo, 0));
    if (chartServicos) chartServicos.destroy();
    chartServicos = new Chart(document.getElementById('chart-servicos'), {
      type: 'bar',
      data: { labels: servicos, datasets: [{ label: 'Custo no período', data: custoServico, backgroundColor: CORES[1], borderRadius: 6 }] },
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
