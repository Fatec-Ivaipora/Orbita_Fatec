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

  const modalOverlay = document.getElementById('modal-comentarios');
  document.getElementById('btn-fechar-modal-comentarios').addEventListener('click', fecharModalComentarios);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) fecharModalComentarios();
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

let dimensoesAtuais = [];
let modalFiltroAtual = 'todos';
let modalDimensaoIdx = null;

const CLASSIFICACOES = {
  bom: { label: 'Bons', cor: '#10B981' },
  neutro: { label: 'Neutros', cor: '#F59E0B' },
  atencao: { label: 'Atenção', cor: '#EF4444' },
};

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

  // Dimensões com 0 avaliações são seções condicionais do formulário (ex.:
  // "Disciplinas 100% EAD") que ninguém respondeu nesse curso/campanha —
  // não têm nada a mostrar, então ficam de fora em vez de aparecer vazias.
  dimensoesAtuais = dados.dimensoes.filter(dim => dim.totalAvaliacoes > 0);

  if (dimensoesAtuais.length === 0) {
    container.innerHTML = '<p class="empty-state">Nenhuma resposta encontrada pra esse curso nessa campanha.</p>';
    return;
  }

  dimensoesAtuais.forEach((dim, idx) => {
    const card = document.createElement('div');
    card.className = 'chart-card full dimensao-card';

    const notaGeral = dim.mediaGeral !== null ? `${dim.mediaGeral.toFixed(1)}/10` : '—';
    const canvasId = `chart-dim-${idx}`;
    const contagem = contarPorClassificacao(dim.comentarios);

    card.innerHTML = `
      <div class="dimensao-header">
        <h3>${esc(dim.nome)}</h3>
        <span class="dimensao-nota">Nota geral: <strong>${notaGeral}</strong> <span class="dimensao-total">(${dim.totalAvaliacoes} avaliações)</span></span>
      </div>
      ${dim.disciplinas.length > 0 ? `<p class="chart-escopo-aviso">Média de todas as disciplinas desta categoria (${dim.disciplinas.length} no total) — veja o detalhamento por disciplina abaixo pra achar pontos fracos específicos.</p>` : ''}
      <div class="chart-canvas-wrap" style="height:${alturaGrafico(dim.perguntas.length)}px"><canvas id="${canvasId}"></canvas></div>
      <div class="comentarios-resumo no-print">
        <div class="comentarios-badges">
          ${Object.entries(CLASSIFICACOES).map(([key, info]) => `
            <span class="badge-classificacao" style="--cor:${info.cor}">${contagem[key] || 0} ${info.label.toLowerCase()}</span>
          `).join('')}
        </div>
        <button type="button" class="btn-secondary btn-ver-comentarios" data-idx="${idx}" ${dim.comentarios.length === 0 ? 'disabled' : ''}>
          Ver comentários (${dim.comentarios.length})
        </button>
      </div>
      ${dim.disciplinas.length > 0 ? `
        <div class="disciplinas-bloco no-print">
          <p class="comentarios-titulo">Por disciplina (${dim.disciplinas.length})</p>
          <div class="disciplinas-lista">
            ${dim.disciplinas.map((d, di) => `
              <div class="disciplina-item">
                <div class="disciplina-info">
                  <span class="disciplina-nome">${esc(d.disciplina)}</span>
                  ${d.professor ? `<span class="disciplina-professor">${esc(d.professor)}</span>` : ''}
                </div>
                <div class="disciplina-stats">
                  <span class="disciplina-nota">${d.mediaGeral !== null ? d.mediaGeral.toFixed(1) + '/10' : '—'}</span>
                  <span class="disciplina-total">${d.totalAvaliacoes} aval.</span>
                  <button type="button" class="btn-secondary btn-sm btn-ver-disciplina" data-idx="${idx}" data-disc-idx="${di}" ${d.comentarios.length === 0 ? 'disabled' : ''}>
                    Comentários (${d.comentarios.length})
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      <div class="comentarios-print only-print">
        <p class="comentarios-titulo">Comentários (${dim.comentarios.length})</p>
        ${dim.comentarios.length === 0
          ? '<p class="comentarios-vazio">Sem comentários relevantes.</p>'
          : `<ul class="comentarios-lista">${dim.comentarios.map(c => `<li><span class="comentario-tag" style="--cor:${CLASSIFICACOES[c.classificacao].cor}">${CLASSIFICACOES[c.classificacao].label}</span> ${esc(c.texto)}</li>`).join('')}</ul>`}
        ${dim.disciplinas.map(d => `
          <p class="comentarios-titulo" style="margin-top:1rem">${esc(d.disciplina)}${d.professor ? ' — ' + esc(d.professor) : ''} (${d.comentarios.length})</p>
          ${d.comentarios.length === 0
            ? '<p class="comentarios-vazio">Sem comentários relevantes.</p>'
            : `<ul class="comentarios-lista">${d.comentarios.map(c => `<li><span class="comentario-tag" style="--cor:${CLASSIFICACOES[c.classificacao].cor}">${CLASSIFICACOES[c.classificacao].label}</span> ${esc(c.texto)}</li>`).join('')}</ul>`}
        `).join('')}
      </div>
    `;
    container.appendChild(card);

    if (dim.perguntas.length > 0) {
      const chart = criarGraficoDimensao(canvasId, dim.perguntas);
      charts.push(chart);
    }
  });

  container.querySelectorAll('.btn-ver-comentarios').forEach(btn => {
    btn.addEventListener('click', () => abrirModalComentarios(Number(btn.dataset.idx)));
  });
  container.querySelectorAll('.btn-ver-disciplina').forEach(btn => {
    btn.addEventListener('click', () => abrirModalDisciplina(Number(btn.dataset.idx), Number(btn.dataset.discIdx)));
  });
}

function contarPorClassificacao(comentarios) {
  return comentarios.reduce((acc, c) => { acc[c.classificacao] = (acc[c.classificacao] || 0) + 1; return acc; }, {});
}

// Altura cresce com o número de perguntas, senão barras horizontais ficam
// espremidas quando a dimensão tem muitas (ex.: 14 perguntas de uma vez).
function alturaGrafico(numPerguntas) {
  return Math.max(180, numPerguntas * 42);
}

// O valor exibido na barra é sempre "1 = pior, N = melhor", mesmo quando a
// escala original da pergunta vem invertida (ex.: "1=Ótimo...5=Não sei") —
// senão uma média boa (ex. 1.95 numa escala invertida) aparece como barra
// curta, o que lê visualmente como ruim. A média real (a que está no banco)
// continua no tooltip, só a barra em si é reorientada.
function valorExibido(pergunta) {
  if (pergunta.media === null) return null;
  const max = pergunta.opcoes.length || 5;
  return pergunta.escalaInvertida ? (max + 1 - pergunta.media) : pergunta.media;
}

function criarGraficoDimensao(canvasId, perguntas) {
  const labels = perguntas.map(p => truncar(p.pergunta, 55));
  const valores = perguntas.map(p => valorExibido(p));
  const cores = perguntas.map(p => corPorPositividade(positividade(p)));
  const escalaMax = Math.max(5, ...perguntas.map(p => p.opcoes.length || 5));

  const ctx = document.getElementById(canvasId);
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Qualidade (1=pior, 5=melhor)',
        data: valores,
        backgroundColor: cores,
        borderRadius: 6,
        barThickness: 22,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { min: 0, max: escalaMax, ticks: { stepSize: 1 }, title: { display: true, text: '1 = pior · 5 = melhor' } },
        y: { ticks: { autoSkip: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => perguntas[items[0].dataIndex].pergunta,
            label: (item) => {
              const p = perguntas[item.dataIndex];
              const exibido = valorExibido(p);
              const opcaoMaisProxima = p.opcoes[Math.max(0, Math.min(p.opcoes.length - 1, Math.round(p.media) - 1))];
              const linhas = [`Qualidade: ${exibido.toFixed(2)} de 5 — ${p.respostas} respostas`];
              linhas.push(`Resposta mais comum: "${opcaoMaisProxima || ''}"`);
              if (p.escalaInvertida) {
                linhas.push(`(nota real na escala original do Edubox: ${p.media} de ${p.opcoes.length || 5} — essa pergunta usa escala invertida, 1=melhor)`);
              }
              return linhas;
            },
          },
        },
      },
    },
  });
}

function truncar(texto, max) {
  const t = String(texto || '');
  return t.length > max ? t.slice(0, max - 1).trim() + '…' : t;
}

// ==========================================
// MODAL DE COMENTÁRIOS
// ==========================================
function abrirModalComentarios(idx) {
  modalDimensaoIdx = idx;
  modalFiltroAtual = 'todos';
  const dim = dimensoesAtuais[idx];
  document.getElementById('modal-comentarios-titulo').textContent = `Comentários — ${dim.nome}`;
  renderTabsModal(dim);
  renderListaModal(dim);
  document.getElementById('modal-comentarios').classList.remove('hidden');
}

function abrirModalDisciplina(idx, discIdx) {
  modalFiltroAtual = 'todos';
  const disc = dimensoesAtuais[idx].disciplinas[discIdx];
  const titulo = disc.professor ? `${disc.disciplina} — ${disc.professor}` : disc.disciplina;
  document.getElementById('modal-comentarios-titulo').textContent = `Comentários — ${titulo}`;
  renderTabsModal(disc);
  renderListaModal(disc);
  document.getElementById('modal-comentarios').classList.remove('hidden');
}

function fecharModalComentarios() {
  document.getElementById('modal-comentarios').classList.add('hidden');
  modalDimensaoIdx = null;
}

function renderTabsModal(dim) {
  const contagem = contarPorClassificacao(dim.comentarios);
  const tabs = document.getElementById('comentarios-filtro-tabs');
  const opcoes = [{ key: 'todos', label: 'Todos', total: dim.comentarios.length }]
    .concat(Object.entries(CLASSIFICACOES).map(([key, info]) => ({ key, label: info.label, total: contagem[key] || 0 })));

  tabs.innerHTML = opcoes.map(o => `
    <button type="button" class="filtro-tab ${o.key === modalFiltroAtual ? 'ativo' : ''}" data-key="${o.key}">
      ${o.label} (${o.total})
    </button>
  `).join('');

  tabs.querySelectorAll('.filtro-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      modalFiltroAtual = btn.dataset.key;
      renderTabsModal(dim);
      renderListaModal(dim);
    });
  });
}

function renderListaModal(dim) {
  const lista = document.getElementById('comentarios-lista-modal');
  const comentarios = modalFiltroAtual === 'todos'
    ? dim.comentarios
    : dim.comentarios.filter(c => c.classificacao === modalFiltroAtual);

  if (comentarios.length === 0) {
    lista.innerHTML = '<p class="comentarios-vazio">Nenhum comentário nessa categoria.</p>';
    return;
  }

  lista.innerHTML = `<ul class="comentarios-lista">${comentarios.map(c => `
    <li><span class="comentario-tag" style="--cor:${CLASSIFICACOES[c.classificacao].cor}">${CLASSIFICACOES[c.classificacao].label}</span> ${esc(c.texto)}</li>
  `).join('')}</ul>`;
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
