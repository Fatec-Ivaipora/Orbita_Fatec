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
let appInitialized = false;
let initializedRole = null;
let currentRole = null;

const TAMANHO_PAGINA = 25;
let resultadoCompletoLista = []; // tudo que veio do servidor pra essa busca — 1 leitura só
let quantidadeExibida = TAMANHO_PAGINA; // quanto disso já foi revelado na tela ("Carregar mais")
let acaoAlunoAtual = null; // { cpf, nome, curso }

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

async function apiFetchComRetentativa(endpoint, tentativas = 2) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await apiFetch(endpoint);
    } catch (err) {
      if (i === tentativas) throw err;
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

function fmtMoeda(v) {
  return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// vencimento_mais_antigo já vem como string "YYYY-MM-DD" da API (to_char no
// Postgres) — formata por split de string, nunca via `new Date(str)`, que
// pode voltar um dia por causa do fuso (mesmo cuidado já registrado pro
// módulo Ferida).
function fmtData(iso) {
  if (!iso) return '—';
  const [ano, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${ano}`;
}

function showToast(msg, tipo = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast toast-${tipo}`;
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// A planilha grava o curso como "BACHARELADO EM DIREITO", "SUPERIOR DE
// TECNOLOGIA EM GESTÃO..." etc. — o prefixo do modelo do curso ocupa boa
// parte do espaço e corta o nome nas colunas estreitas. Separa modelo (tag)
// do nome (o que a usuária realmente quer ver primeiro).
const PREFIXOS_CURSO = [
  { prefix: 'BACHARELADO EM ', tipo: 'Bacharelado' },
  { prefix: 'LICENCIATURA EM ', tipo: 'Licenciatura' },
  { prefix: 'SUPERIOR DE TECNOLOGIA EM ', tipo: 'Tecnólogo' },
  { prefix: 'TECNÓLOGO EM ', tipo: 'Tecnólogo' }
];
function parseCurso(curso) {
  const c = (curso || '').trim();
  const upper = c.toUpperCase();
  for (const { prefix, tipo } of PREFIXOS_CURSO) {
    if (upper.startsWith(prefix)) return { tipo, nome: c.slice(prefix.length).trim() };
  }
  return { tipo: null, nome: c };
}
function fmtCursoOption(curso) {
  const { tipo, nome } = parseCurso(curso);
  return tipo ? `${nome} (${tipo})` : nome;
}
function cursoCelula(curso) {
  const { tipo, nome } = parseCurso(curso);
  return `<strong>${esc(nome)}</strong>${tipo ? `<div class="linha-hint">${esc(tipo)}</div>` : ''}`;
}

// criadoEm chega como Timestamp do Firestore serializado ({_seconds,...})
// quando vem do histórico (GET), ou como string ISO no retorno otimista do
// POST — trata os dois formatos.
function fmtDataHora(v) {
  if (!v) return '—';
  const ms = typeof v === 'string' ? new Date(v).getTime() : (v._seconds ?? v.seconds) * 1000;
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtCpf(cpf) {
  if (!cpf) return '—';
  return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

const SITUACAO_CLASSE = {
  'Ativo': 'situacao-ativo',
  'Trancamento': 'situacao-trancamento',
  'Desistência': 'situacao-desistencia',
  'Cancelado': 'situacao-cancelado',
  'Concluído': 'situacao-concluido',
  'Pendente': 'situacao-pendente'
};
function situacaoBadge(situacoes) {
  if (!situacoes || !situacoes.length) return '<span class="linha-hint">—</span>';
  return situacoes.map(s => `<span class="situacao-badge ${SITUACAO_CLASSE[s] || ''}">${esc(s)}</span>`).join(' ');
}

const TIPO_LABEL = {
  contato: 'Contato',
  negociacao: 'Negociação',
  enviado_advocacia: 'Enviado à advocacia',
  acordo_judicial: 'Acordo judicial',
  quitado_manual: 'Quitado (manual)',
  mudanca_situacao: 'Mudança de situação',
  outro: 'Outro'
};
const TIPO_CLASSE = {
  contato: 'badge-contato',
  negociacao: 'badge-negociacao',
  enviado_advocacia: 'badge-advocacia',
  acordo_judicial: 'badge-advocacia',
  quitado_manual: 'badge-quitado',
  mudanca_situacao: 'badge-outro',
  outro: 'badge-outro'
};

function faixaClasse(dias) {
  if (dias > 90) return 'faixa-90-mais';
  if (dias > 60) return 'faixa-61-90';
  if (dias > 30) return 'faixa-31-60';
  return 'faixa-1-30';
}

// ==========================================
// AUTH GUARD E INICIALIZAÇÃO
// ==========================================
const cached = getCachedAuth();
if (cached && (cached.role === 'adm_l1' || cached.role === 'adm_l2')) {
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
    let meuOverrides = null;
    try {
      const userData = await apiFetchComRetentativa('/usuarios/me');
      role = userData.role || 'visitante';
      meuOverrides = userData.permissoes || null;
    } catch (err) {
      role = cached ? cached.role : 'visitante';
    }
    currentRole = role;

    setCachedAuth(user, role, token);

    let level = 1;
    if (role === 'adm_l1') {
      level = 3;
    } else {
      try {
        const perms = await apiFetchComRetentativa('/usuarios/config/permissions');
        level = getEffectiveLevel(perms[role] || {}, meuOverrides, 'cobranca');
      } catch (e) {
        if (role === 'adm_l2') level = 3;
      }
    }

    if (level < 2) {
      window.location.href = '../../meu-espaco/index.html';
      return;
    }

    document.body.classList.toggle('hide-execute', level < 3);

    if (!appInitialized || initializedRole !== role) {
      initializedRole = role;
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

  setupLayout(user, role, 'cobranca', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');

  if (document.getElementById('lista-tbody')) {
    initPaginaLista();
  } else if (document.getElementById('cobranca-relatorio-root')) {
    initPaginaRelatorio();
  } else if (document.getElementById('cobranca-comparativo-root')) {
    initPaginaComparativo();
  }
}

// ==========================================
// PÁGINA PRINCIPAL
// ==========================================
async function initPaginaLista() {
  wireEventos();
  await Promise.all([carregarResumo(), carregarFiltros()]);
}

function wireEventos() {
  document.getElementById('btn-buscar').addEventListener('click', () => buscarLista());
  document.getElementById('busca-aluno').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') buscarLista();
  });
  ['curso-select', 'semestre-select', 'situacao-select', 'modelo-select', 'juridico-select', 'faixa-select'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => { carregarResumo(); buscarLista(); });
  });

  document.getElementById('btn-fechar-acao').addEventListener('click', fecharModalAcao);
  document.getElementById('acao-tipo').addEventListener('change', atualizarVisibilidadeEscritorio);
  document.getElementById('form-acao').addEventListener('submit', salvarAcao);

  document.getElementById('btn-importar-csv').addEventListener('click', () => {
    document.getElementById('modal-import').classList.remove('hidden');
  });
  document.getElementById('btn-cancelar-import').addEventListener('click', fecharModalImport);
  document.getElementById('csv-input').addEventListener('change', lerArquivoCsv);
  document.getElementById('import-check-all').addEventListener('change', (e) => {
    document.querySelectorAll('#import-tbody .chk-linha').forEach(cb => cb.checked = e.target.checked);
  });
  document.getElementById('btn-confirmar-import').addEventListener('click', confirmarImportCsv);

  document.getElementById('btn-novo-caso').addEventListener('click', () => abrirModalCaso(null));
  document.getElementById('btn-fechar-caso').addEventListener('click', fecharModalCaso);
  document.getElementById('btn-cancelar-selecionar-parcela').addEventListener('click', fecharModalCaso);
  document.getElementById('form-caso').addEventListener('submit', salvarCaso);
  document.getElementById('btn-excluir-caso').addEventListener('click', excluirCaso);

  document.getElementById('btn-fechar-aluno').addEventListener('click', fecharModalAluno);
  document.getElementById('form-aluno').addEventListener('submit', salvarAluno);
}

function filtrosAtuais() {
  return {
    curso: document.getElementById('curso-select').value,
    semestre: document.getElementById('semestre-select').value,
    situacao: document.getElementById('situacao-select').value,
    modelo: document.getElementById('modelo-select').value,
    juridico: document.getElementById('juridico-select').value,
    faixa: document.getElementById('faixa-select').value,
    busca: document.getElementById('busca-aluno').value.trim()
  };
}

const JURIDICO_LABEL = { advogado: 'Advogado FATEC', judicial: 'Débito judicial' };
const JURIDICO_CLASSE = { advogado: 'badge-advocacia', judicial: 'badge-judicial' };
function juridicoBadge(situacaoJuridica) {
  if (!situacaoJuridica) return '<span class="linha-hint">—</span>';
  return `<span class="acao-badge ${JURIDICO_CLASSE[situacaoJuridica] || ''}">${esc(JURIDICO_LABEL[situacaoJuridica] || situacaoJuridica)}</span>`;
}

async function carregarResumo() {
  const { curso, semestre, modelo } = filtrosAtuais();
  const params = new URLSearchParams();
  if (curso) params.set('curso', curso);
  if (semestre) params.set('semestre', semestre);
  if (modelo) params.set('modelo', modelo);
  try {
    const r = await apiFetch(`/cobranca/resumo?${params.toString()}`);
    document.getElementById('kpi-alunos').textContent = r.alunos ?? '0';
    document.getElementById('kpi-parcelas-hint').textContent = `${r.parcelas ?? 0} parcela(s) vencida(s)`;
    document.getElementById('kpi-valor').textContent = fmtMoeda(r.valor_total);
    document.getElementById('kpi-faixa-inicial').textContent =
      `${r.alunos_1_30 ?? 0} (${fmtMoeda(r.valor_1_30)}) / ${r.alunos_31_60 ?? 0} (${fmtMoeda(r.valor_31_60)})`;
    document.getElementById('kpi-faixa-final').textContent =
      `${r.alunos_61_90 ?? 0} (${fmtMoeda(r.valor_61_90)}) / ${r.alunos_90_mais ?? 0} (${fmtMoeda(r.valor_90_mais)})`;
    const porSituacao = r.por_situacao || {};
    const hint = document.getElementById('kpi-situacao-hint');
    if (hint) hint.textContent = Object.entries(porSituacao).map(([s, n]) => `${s}: ${n}`).join(' · ');
    const porModelo = r.por_modelo || {};
    const hintModelo = document.getElementById('kpi-modelo-hint');
    if (hintModelo) hintModelo.textContent = Object.entries(porModelo).map(([m, n]) => `${m}: ${n}`).join(' · ');
    const kpiJuridico = document.getElementById('kpi-juridico');
    if (kpiJuridico) kpiJuridico.textContent = `${r.alunos_advogado ?? 0} / ${r.alunos_judicial ?? 0}`;
  } catch (err) {
    console.error(err);
  }
}

async function carregarFiltros() {
  try {
    const { cursos, semestres, situacoes, modelos } = await apiFetch('/cobranca/filtros');
    const cursoSelect = document.getElementById('curso-select');
    cursoSelect.innerHTML = '<option value="">Todos os cursos</option>' +
      cursos.map(c => `<option value="${esc(c)}">${esc(fmtCursoOption(c))}</option>`).join('');
    const semSelect = document.getElementById('semestre-select');
    semSelect.innerHTML = '<option value="">Todos os semestres</option>' +
      semestres.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    const modeloSelect = document.getElementById('modelo-select');
    if (modeloSelect) {
      modeloSelect.innerHTML = '<option value="">Todos os modelos</option>' +
        modelos.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    }
    const sitSelect = document.getElementById('situacao-select');
    if (sitSelect) {
      sitSelect.innerHTML = '<option value="">Todas as situações</option>' +
        situacoes.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    }
  } catch (err) {
    console.error(err);
  }
}

async function buscarLista() {
  const tbody = document.getElementById('lista-tbody');
  const { curso, semestre, situacao, modelo, juridico, faixa, busca } = filtrosAtuais();

  tbody.innerHTML = '<tr><td colspan="9" class="tabela-msg">Carregando...</td></tr>';
  const params = new URLSearchParams();
  if (curso) params.set('curso', curso);
  if (semestre) params.set('semestre', semestre);
  if (situacao) params.set('situacao', situacao);
  if (modelo) params.set('modelo', modelo);
  if (juridico) params.set('juridico', juridico);
  if (faixa) params.set('faixa', faixa);
  if (busca) params.set('busca', busca);

  try {
    // Uma leitura só pra essa busca — a paginação daqui pra frente
    // ("Carregar mais") é só revelar mais linhas do que já veio, sem
    // bater no Firestore de novo.
    resultadoCompletoLista = await apiFetch(`/cobranca/parcelas?${params.toString()}`);
    quantidadeExibida = TAMANHO_PAGINA;
    renderizarLista();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="tabela-msg">Erro ao carregar: ${esc(err.message)}</td></tr>`;
  }
}

let ultimoResultadoLista = [];

function renderizarLista() {
  const linhas = resultadoCompletoLista.slice(0, quantidadeExibida);
  ultimoResultadoLista = linhas;
  const tbody = document.getElementById('lista-tbody');
  if (!linhas.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="tabela-msg">Nenhum aluno inadimplente encontrado com esses filtros.</td></tr>';
    document.getElementById('paginacao').innerHTML = '';
    return;
  }
  tbody.innerHTML = linhas.map((l, idx) => `
    <tr>
      <td>
        <strong>${esc(l.nome)}</strong>
        ${l.celular ? `<div class="linha-hint">${esc(l.celular)}</div>` : ''}
      </td>
      <td>${cursoCelula(l.curso)}</td>
      <td>${situacaoBadge(l.situacoes)}</td>
      <td>${juridicoBadge(l.situacaoJuridica)}</td>
      <td>${l.parcelas}</td>
      <td>${fmtMoeda(l.valorTotal)}</td>
      <td><span class="faixa-badge ${faixaClasse(l.diasAtraso)}">${l.diasAtraso} dia(s)</span></td>
      <td>${l.ultimaAcao ? `<span class="acao-badge ${TIPO_CLASSE[l.ultimaAcao.tipo] || ''}">${esc(TIPO_LABEL[l.ultimaAcao.tipo] || l.ultimaAcao.tipo)}</span>` : '<span class="linha-hint">Sem ação registrada</span>'}</td>
      <td class="acoes-col">
        <button class="btn-icon btn-abrir-acao" data-idx="${idx}" title="Ver histórico / registrar ação">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="btn-icon btn-editar-aluno action-execute" data-idx="${idx}" title="Editar aluno (nome/CPF/celular/situação)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </button>
        <button class="btn-icon btn-editar-parcela action-execute" data-idx="${idx}" title="Editar parcela">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-abrir-acao').forEach(btn => {
    btn.addEventListener('click', () => {
      const l = ultimoResultadoLista[Number(btn.dataset.idx)];
      abrirModalAcao({ cpf: l.cpf, nome: l.nome, curso: l.curso });
    });
  });
  tbody.querySelectorAll('.btn-editar-aluno').forEach(btn => {
    btn.addEventListener('click', () => {
      const l = ultimoResultadoLista[Number(btn.dataset.idx)];
      abrirModalAluno(l);
    });
  });
  tbody.querySelectorAll('.btn-editar-parcela').forEach(btn => {
    btn.addEventListener('click', () => {
      const l = ultimoResultadoLista[Number(btn.dataset.idx)];
      if (!l) return;
      abrirModalEdicaoPorGrupo(l, btn);
    });
  });

  renderizarCarregarMais();
}

// "Carregar mais" só revela mais linhas do array já trazido do servidor —
// não faz nenhuma requisição nova, pra gastar o mínimo de leitura possível
// no Firestore por busca.
function renderizarCarregarMais() {
  const el = document.getElementById('paginacao');
  const restantes = resultadoCompletoLista.length - quantidadeExibida;
  if (restantes <= 0) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <span class="paginacao-atual">Mostrando ${Math.min(quantidadeExibida, resultadoCompletoLista.length)} de ${resultadoCompletoLista.length}</span>
    <button class="btn-secondary" id="btn-carregar-mais">Carregar mais (${restantes})</button>
  `;
  document.getElementById('btn-carregar-mais')?.addEventListener('click', () => {
    quantidadeExibida += TAMANHO_PAGINA;
    renderizarLista();
  });
}

// ==========================================
// MODAL: HISTÓRICO / REGISTRAR AÇÃO
// ==========================================
function atualizarVisibilidadeEscritorio() {
  const tipo = document.getElementById('acao-tipo').value;
  document.getElementById('acao-escritorio-wrap').classList.toggle('hidden', !['enviado_advocacia', 'acordo_judicial'].includes(tipo));
}

async function abrirModalAcao(aluno) {
  if (!aluno.cpf) { showToast('Este aluno não tem CPF cadastrado — edite o caso pra adicionar antes de registrar uma ação.', 'error'); return; }
  acaoAlunoAtual = aluno;
  document.getElementById('acao-aluno-nome').textContent = aluno.nome;
  document.getElementById('acao-aluno-meta').textContent = aluno.curso;
  document.getElementById('acao-cpf').value = aluno.cpf;
  document.getElementById('acao-nome').value = aluno.nome;
  document.getElementById('acao-tipo').value = 'contato';
  document.getElementById('acao-escritorio').value = '';
  document.getElementById('acao-observacoes').value = '';
  atualizarVisibilidadeEscritorio();

  document.getElementById('modal-acao').classList.remove('hidden');
  await carregarHistoricoAcoes(aluno.cpf);
}

function fecharModalAcao() {
  document.getElementById('modal-acao').classList.add('hidden');
  acaoAlunoAtual = null;
}

async function carregarHistoricoAcoes(cpf) {
  const el = document.getElementById('acao-historico');
  el.textContent = 'Carregando...';
  try {
    const acoes = await apiFetch(`/cobranca/acoes/${cpf}`);
    if (!acoes.length) {
      el.innerHTML = '<p class="linha-hint">Nenhuma ação registrada ainda.</p>';
      return;
    }
    el.innerHTML = acoes.map(a => `
      <div class="acao-item">
        <div class="acao-item-topo">
          <span class="acao-badge ${TIPO_CLASSE[a.tipo] || ''}">${esc(TIPO_LABEL[a.tipo] || a.tipo)}</span>
          <button type="button" class="btn-icon btn-excluir-acao action-execute" data-id="${a.id}" title="Excluir este registro">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
        <div class="linha-hint">${esc(a.criadoPorNome || '')} — ${fmtDataHora(a.criadoEm)}</div>
        ${a.escritorio ? `<div class="acao-item-escritorio">${esc(a.escritorio)}</div>` : ''}
        ${a.observacoes ? `<div class="acao-item-obs">${esc(a.observacoes)}</div>` : ''}
      </div>
    `).join('');

    el.querySelectorAll('.btn-excluir-acao').forEach(btn => {
      btn.addEventListener('click', () => excluirAcao(btn.dataset.id, cpf));
    });
  } catch (err) {
    el.innerHTML = `<p class="linha-hint">Erro ao carregar histórico: ${esc(err.message)}</p>`;
  }
}

async function excluirAcao(id, cpf) {
  if (!confirm('Excluir este registro do histórico? Não dá pra desfazer.')) return;
  try {
    await apiFetch(`/cobranca/acoes/${id}`, { method: 'DELETE' });
    showToast('Registro excluído.');
    await carregarHistoricoAcoes(cpf);
    buscarLista();
  } catch (err) {
    showToast('Erro ao excluir: ' + err.message, 'error');
  }
}

async function salvarAcao(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-salvar-acao');
  btn.disabled = true;
  try {
    await apiFetch('/cobranca/acoes', {
      method: 'POST',
      body: JSON.stringify({
        cpf: document.getElementById('acao-cpf').value,
        nomeAluno: document.getElementById('acao-nome').value,
        tipo: document.getElementById('acao-tipo').value,
        escritorio: document.getElementById('acao-escritorio').value,
        observacoes: document.getElementById('acao-observacoes').value
      })
    });
    showToast('Ação registrada!');
    document.getElementById('acao-observacoes').value = '';
    await carregarHistoricoAcoes(acaoAlunoAtual.cpf);
    buscarLista();
  } catch (err) {
    showToast('Erro ao registrar ação: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ==========================================
// IMPORTAR CSV (advocacia/judicial) — lista própria do financeiro, subida
// manualmente. Colunas:
// nome, cpf, escritorio, tipo, observacoes (só nome é obrigatório).
// ==========================================
let linhasImportadas = [];

function parseCsvLine(line, delimitador) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delimitador) { result.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function parseCsv(text) {
  const linhas = text.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
  if (!linhas.length) return [];
  const delimitador = linhas[0].includes(';') ? ';' : ',';
  const cabecalho = parseCsvLine(linhas[0], delimitador).map(c => c.trim().toLowerCase());
  return linhas.slice(1).map(linha => {
    const valores = parseCsvLine(linha, delimitador);
    const rec = {};
    cabecalho.forEach((col, idx) => { rec[col] = (valores[idx] || '').trim(); });
    return rec;
  });
}

async function lerArquivoCsv(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buffer);
    const registros = parseCsv(text).filter(r => r.nome);
    if (!registros.length) {
      showToast('Nenhum registro com nome preenchido encontrado no arquivo.', 'error');
      e.target.value = '';
      return;
    }
    await montarPreviewImport(registros);
  } catch (err) {
    showToast('Erro ao ler o CSV: ' + err.message, 'error');
  }
  e.target.value = '';
}

async function montarPreviewImport(registros) {
  // O backend confere o CPF contra os casos já cadastrados na hora de
  // gravar — aqui no preview só mostra "com CPF" vs "sem CPF" mesmo.
  linhasImportadas = registros.map(r => ({ ...r }));
  document.getElementById('import-resumo').textContent = `${linhasImportadas.length} registro(s) lido(s) do arquivo.`;

  document.getElementById('import-tbody').innerHTML = linhasImportadas.map((r, idx) => `
    <tr>
      <td><input type="checkbox" class="chk-linha" data-idx="${idx}" checked></td>
      <td>${esc(r.nome)}</td>
      <td>${esc(r.cpf || '—')}</td>
      <td>${esc(r.escritorio || '—')}</td>
      <td>${esc(TIPO_LABEL[r.tipo] || 'Enviado à advocacia')}</td>
      <td>${r.cpf ? '<span class="linha-hint">Verificado ao importar</span>' : '<span class="linha-hint">Sem CPF — sem vínculo automático</span>'}</td>
    </tr>
  `).join('');

  document.getElementById('import-preview').classList.remove('hidden');
}

async function confirmarImportCsv() {
  const idxSelecionados = Array.from(document.querySelectorAll('#import-tbody .chk-linha:checked')).map(cb => Number(cb.dataset.idx));
  const selecionados = linhasImportadas.filter((_, idx) => idxSelecionados.includes(idx));
  if (!selecionados.length) {
    showToast('Nenhum registro selecionado.', 'error');
    return;
  }
  const btn = document.getElementById('btn-confirmar-import');
  btn.disabled = true;
  try {
    const resultado = await apiFetch('/cobranca/acoes/importar-csv', {
      method: 'POST',
      body: JSON.stringify({ records: selecionados })
    });
    let msg = `✅ ${resultado.gravados} registro(s) importado(s).`;
    if (resultado.semCpfEncontrado?.length) msg += ` ${resultado.semCpfEncontrado.length} sem vínculo automático com um caso já cadastrado (ver histórico de cada aluno manualmente).`;
    showToast(msg);
    fecharModalImport();
    buscarLista();
  } catch (err) {
    showToast('Erro ao importar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function fecharModalImport() {
  document.getElementById('modal-import').classList.add('hidden');
  document.getElementById('import-preview').classList.add('hidden');
  document.getElementById('csv-input').value = '';
  linhasImportadas = [];
}

// ==========================================
// MODAL: NOVO CASO / EDITAR CASO — cadastro manual de parcelas, a partir da
// importação da planilha (financeiro não reimporta planilha nova, cadastra
// direto por aqui).
// ==========================================
function preencherFormCaso(p) {
  document.getElementById('caso-id').value = p?.id || '';
  document.getElementById('caso-nome').value = p?.nome || '';
  document.getElementById('caso-cpf').value = p?.cpf || '';
  document.getElementById('caso-curso').value = p?.curso || '';
  document.getElementById('caso-celular').value = p?.celular || '';
  document.getElementById('caso-situacao').value = p?.situacao || 'Ativo';
  document.getElementById('caso-plano').value = p?.plano || '';
  document.getElementById('caso-vencimento').value = p?.vencimento || '';
  document.getElementById('caso-semestre').value = p?.semestre || '';
  document.getElementById('caso-valor-bruto').value = p?.valorBruto ?? 0;
  document.getElementById('caso-desconto').value = p ? round2(( p.descontoCadastro || 0) + (p.desconto || 0)) : 0;
  document.getElementById('caso-multa-juros').value = p ? round2((p.multa || 0) + (p.juros || 0)) : 0;
  document.getElementById('caso-valor-a-pagar').value = p?.valorAPagar ?? '';
  document.getElementById('caso-valor-pago').value = p?.valorPago ?? 0;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ==========================================
// MODAL: EDITAR ALUNO — nome/CPF/celular/situação são do aluno, não de uma
// parcela avulsa; salvar aqui aplica em TODAS as parcelas dele (mesmo CPF,
// qualquer curso). Mudar a situação vira um registro automático no
// histórico de ações, pra negociação/mudança de status sempre deixar rastro.
// ==========================================
let alunoEmEdicao = null; // { cpf, nome, situacoes }

function abrirModalAluno(grupo) {
  if (!grupo.cpf) {
    showToast('Este aluno não tem CPF cadastrado — edite pela "Editar parcela" pra adicionar um CPF antes.', 'error');
    return;
  }
  alunoEmEdicao = grupo;
  document.getElementById('aluno-cpf-original').value = grupo.cpf;
  document.getElementById('aluno-nome').value = grupo.nome || '';
  document.getElementById('aluno-cpf').value = grupo.cpf || '';
  document.getElementById('aluno-celular').value = grupo.celular || '';
  document.getElementById('aluno-situacao').value = (grupo.situacoes && grupo.situacoes[0]) || 'Ativo';
  document.getElementById('modal-aluno').classList.remove('hidden');
}

function fecharModalAluno() {
  document.getElementById('modal-aluno').classList.add('hidden');
  alunoEmEdicao = null;
}

async function salvarAluno(e) {
  e.preventDefault();
  const cpfOriginal = document.getElementById('aluno-cpf-original').value;
  const btn = document.getElementById('btn-salvar-aluno');
  btn.disabled = true;
  try {
    const resultado = await apiFetch(`/cobranca/alunos/${cpfOriginal}`, {
      method: 'PUT',
      body: JSON.stringify({
        nome: document.getElementById('aluno-nome').value,
        cpf: document.getElementById('aluno-cpf').value,
        celular: document.getElementById('aluno-celular').value,
        situacao: document.getElementById('aluno-situacao').value
      })
    });
    showToast(`Aluno atualizado (${resultado.parcelasAtualizadas} parcela(s)).`);
    fecharModalAluno();
    await Promise.all([carregarResumo(), carregarFiltros()]);
    buscarLista();
  } catch (err) {
    showToast('Erro ao salvar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function abrirModalCaso(parcela) {
  document.getElementById('caso-modal-titulo').textContent = parcela ? 'Editar caso' : 'Novo caso de cobrança';
  document.getElementById('caso-selecionar-parcela').classList.add('hidden');
  document.getElementById('form-caso').classList.remove('hidden');
  document.getElementById('btn-excluir-caso').classList.toggle('hidden', !parcela);
  preencherFormCaso(parcela);
  document.getElementById('modal-caso').classList.remove('hidden');
}

// A linha da lista é agrupada por aluno+curso — pode representar mais de
// uma parcela. Se tiver só uma, edita direto; se tiver mais, deixa a
// usuária escolher qual antes de abrir o formulário.
async function abrirModalEdicaoPorGrupo(grupo, botao) {
  if (!grupo || !grupo.parcelaIds || !grupo.parcelaIds.length) {
    showToast('Não achei as parcelas deste aluno pra editar.', 'error');
    return;
  }
  if (botao) botao.disabled = true;
  try {
    const parcelas = await apiFetch(`/cobranca/parcelas/detalhe?ids=${grupo.parcelaIds.join(',')}`);
    if (!parcelas.length) {
      showToast('Essas parcelas não existem mais (foram removidas ou editadas por outra pessoa) — atualize a lista.', 'error');
      return;
    }
    if (parcelas.length === 1) {
      abrirModalCaso(parcelas[0]);
      return;
    }
    document.getElementById('caso-modal-titulo').textContent = 'Editar caso';
    document.getElementById('btn-excluir-caso').classList.add('hidden');
    document.getElementById('form-caso').classList.add('hidden');
    preencherFormCaso(null);
    const wrap = document.getElementById('caso-selecionar-parcela');
    wrap.classList.remove('hidden');
    document.getElementById('caso-lista-parcelas').innerHTML = parcelas.map((p, idx) => `
      <button type="button" class="btn-secondary btn-escolher-parcela" data-idx="${idx}">
        ${fmtData(p.vencimento)} — ${fmtMoeda(p.valorAPagar - p.valorPago)}
      </button>
    `).join('');
    document.getElementById('modal-caso').classList.remove('hidden');
    wrap.querySelectorAll('.btn-escolher-parcela').forEach(btn => {
      btn.addEventListener('click', () => {
        abrirModalCaso(parcelas[Number(btn.dataset.idx)]);
        document.getElementById('btn-excluir-caso').classList.remove('hidden');
      });
    });
  } catch (err) {
    showToast('Erro ao carregar parcelas: ' + err.message, 'error');
  } finally {
    if (botao) botao.disabled = false;
  }
}

function fecharModalCaso() {
  document.getElementById('modal-caso').classList.add('hidden');
}

async function salvarCaso(e) {
  e.preventDefault();
  const id = document.getElementById('caso-id').value;
  const desconto = Number(document.getElementById('caso-desconto').value) || 0;
  const multaJuros = Number(document.getElementById('caso-multa-juros').value) || 0;
  const valorAPagarInput = document.getElementById('caso-valor-a-pagar').value;
  const payload = {
    nome: document.getElementById('caso-nome').value,
    cpf: document.getElementById('caso-cpf').value,
    curso: document.getElementById('caso-curso').value,
    celular: document.getElementById('caso-celular').value,
    situacao: document.getElementById('caso-situacao').value,
    plano: document.getElementById('caso-plano').value,
    vencimento: document.getElementById('caso-vencimento').value,
    semestre: document.getElementById('caso-semestre').value,
    valorBruto: Number(document.getElementById('caso-valor-bruto').value) || 0,
    descontoCadastro: 0,
    desconto,
    multa: multaJuros,
    juros: 0,
    valorPago: Number(document.getElementById('caso-valor-pago').value) || 0
  };
  if (valorAPagarInput !== '') payload.valorAPagar = Number(valorAPagarInput);

  const btn = document.getElementById('btn-salvar-caso');
  btn.disabled = true;
  try {
    if (id) {
      await apiFetch(`/cobranca/parcelas/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Caso atualizado!');
    } else {
      await apiFetch('/cobranca/parcelas', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Caso cadastrado!');
    }
    fecharModalCaso();
    await Promise.all([carregarResumo(), carregarFiltros()]);
    buscarLista();
  } catch (err) {
    showToast('Erro ao salvar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function excluirCaso() {
  const id = document.getElementById('caso-id').value;
  if (!id) return;
  const btn = document.getElementById('btn-excluir-caso');
  btn.disabled = true;
  try {
    await apiFetch(`/cobranca/parcelas/${id}`, { method: 'DELETE' });
    showToast('Caso removido.');
    fecharModalCaso();
    await Promise.all([carregarResumo(), carregarFiltros()]);
    buscarLista();
  } catch (err) {
    showToast('Erro ao remover: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ==========================================
// RELATÓRIO IMPRIMÍVEL (relatorio.html)
// ==========================================
async function initPaginaRelatorio() {
  try {
    const { cursos, semestres, situacoes, modelos } = await apiFetch('/cobranca/filtros');
    const cursoSelect = document.getElementById('curso-select');
    cursoSelect.innerHTML = '<option value="">Todos os cursos</option>' + cursos.map(c => `<option value="${esc(c)}">${esc(fmtCursoOption(c))}</option>`).join('');
    const semSelect = document.getElementById('semestre-select');
    semSelect.innerHTML = '<option value="">Todos os semestres</option>' + semestres.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    const modeloSelect = document.getElementById('modelo-select');
    if (modeloSelect) modeloSelect.innerHTML = '<option value="">Todos os modelos</option>' + modelos.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    const sitSelect = document.getElementById('situacao-select');
    if (sitSelect) sitSelect.innerHTML = '<option value="">Todas as situações</option>' + situacoes.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  } catch (err) {
    console.error(err);
  }

  const dataEmissao = document.getElementById('print-data-emissao');
  if (dataEmissao) dataEmissao.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  document.getElementById('btn-gerar-relatorio')?.addEventListener('click', gerarRelatorio);
  document.getElementById('btn-imprimir-relatorio')?.addEventListener('click', () => window.print());
}

// ==========================================
// COMPARATIVO MENSAL (comparativo.html) — histórico fixo importado da
// planilha (jan-ago/2026), tela própria porque não reage a filtro nenhum
// (era confuso ficar do lado de filtros de curso/semestre que não o afetam).
// ==========================================
async function initPaginaComparativo() {
  const dataEmissao = document.getElementById('print-data-emissao');
  if (dataEmissao) dataEmissao.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');
  document.getElementById('btn-imprimir-comparativo')?.addEventListener('click', () => window.print());

  const grid = document.getElementById('comp-grid');
  try {
    const registros = await apiFetch('/cobranca/historico-mensal');
    if (!registros.length) {
      grid.innerHTML = '<div class="tabela-msg">Sem histórico importado.</div>';
      return;
    }

    const totais = registros.reduce((acc, r) => ({
      ativos: acc.ativos + r.valorAbertoAtivos,
      juridico: acc.juridico + r.valorAbertoJuridico,
      inativos: acc.inativos + r.valorAbertoInativos
    }), { ativos: 0, juridico: 0, inativos: 0 });
    document.getElementById('comp-total-ativos').textContent = fmtMoeda(totais.ativos);
    document.getElementById('comp-total-juridico').textContent = fmtMoeda(totais.juridico);
    document.getElementById('comp-total-inativos').textContent = fmtMoeda(totais.inativos);
    document.getElementById('comp-total-geral').textContent = fmtMoeda(totais.ativos + totais.juridico + totais.inativos);

    grid.innerHTML = registros.map(r => {
      const total = r.valorAbertoAtivos + r.valorAbertoJuridico + r.valorAbertoInativos;
      const pct = (v) => total > 0 ? (v / total * 100) : 0;
      return `
        <div class="comp-card">
          <div class="comp-mes">${esc(r.mes)}/${r.ano}</div>
          <div class="comp-total">${fmtMoeda(total)}</div>
          <div class="comp-bar">
            <div class="comp-bar-seg comp-bar-ativos" style="flex:${pct(r.valorAbertoAtivos)}"></div>
            <div class="comp-bar-seg comp-bar-juridico" style="flex:${pct(r.valorAbertoJuridico)}"></div>
            <div class="comp-bar-seg comp-bar-inativos" style="flex:${pct(r.valorAbertoInativos)}"></div>
          </div>
          <div class="comp-valores">
            <span><strong>${fmtMoeda(r.valorAbertoAtivos)}</strong> — ativos</span>
            <span><strong>${fmtMoeda(r.valorAbertoJuridico)}</strong> — jurídico</span>
            <span><strong>${fmtMoeda(r.valorAbertoInativos)}</strong> — inativos</span>
          </div>
          ${r.observacao ? `<div class="comp-obs">${esc(r.observacao)}</div>` : ''}
        </div>
      `;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div class="tabela-msg">Erro: ${esc(err.message)}</div>`;
  }
}

async function gerarRelatorio() {
  const curso = document.getElementById('curso-select').value;
  const semestre = document.getElementById('semestre-select').value;
  const situacao = document.getElementById('situacao-select')?.value || '';
  const modelo = document.getElementById('modelo-select')?.value || '';
  const juridico = document.getElementById('juridico-select')?.value || '';
  const tbody = document.getElementById('relatorio-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Carregando...</td></tr>';

  const params = new URLSearchParams();
  if (curso) params.set('curso', curso);
  if (semestre) params.set('semestre', semestre);
  if (situacao) params.set('situacao', situacao);
  if (modelo) params.set('modelo', modelo);
  if (juridico) params.set('juridico', juridico);

  try {
    const resumo = await apiFetch(`/cobranca/resumo?${params.toString()}`);
    document.getElementById('rel-kpi-alunos').textContent = resumo.alunos ?? '0';
    document.getElementById('rel-kpi-valor').textContent = fmtMoeda(resumo.valor_total);
    document.getElementById('rel-kpi-parcelas').textContent = resumo.parcelas ?? '0';

    // /parcelas já devolve a lista inteira numa leitura só (sem paginação
    // no servidor) — o relatório mostra tudo de uma vez, é pra imprimir.
    const todasLinhas = await apiFetch(`/cobranca/parcelas?${params.toString()}`);

    if (!todasLinhas.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Nenhum aluno inadimplente encontrado com esses filtros.</td></tr>';
      return;
    }

    tbody.innerHTML = todasLinhas.map(l => `
      <tr>
        <td>${esc(l.nome)}</td>
        <td>${cursoCelula(l.curso)}</td>
        <td>${situacaoBadge(l.situacoes)}</td>
        <td>${juridicoBadge(l.situacaoJuridica)}</td>
        <td>${l.parcelas}</td>
        <td>${fmtMoeda(l.valorTotal)}</td>
        <td>${l.diasAtraso} dia(s)</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
  }
}
