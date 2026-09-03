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

let paginaAtual = 1;
let temMaisPaginas = false;
let acaoAlunoAtual = null; // { codcli, nome, curso }

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

const TIPO_LABEL = {
  contato: 'Contato',
  negociacao: 'Negociação',
  enviado_advocacia: 'Enviado à advocacia',
  acordo_judicial: 'Acordo judicial',
  quitado_manual: 'Quitado (manual)',
  outro: 'Outro'
};
const TIPO_CLASSE = {
  contato: 'badge-contato',
  negociacao: 'badge-negociacao',
  enviado_advocacia: 'badge-advocacia',
  acordo_judicial: 'badge-advocacia',
  quitado_manual: 'badge-quitado',
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
  }
}

// ==========================================
// PÁGINA PRINCIPAL
// ==========================================
async function initPaginaLista() {
  wireEventos();
  await Promise.all([carregarResumo(), carregarCursos(), carregarSemestres()]);
}

function wireEventos() {
  document.getElementById('btn-buscar').addEventListener('click', () => { paginaAtual = 1; buscarLista(); });
  document.getElementById('busca-aluno').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { paginaAtual = 1; buscarLista(); }
  });
  ['curso-select', 'semestre-select', 'faixa-select'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => { paginaAtual = 1; carregarResumo(); buscarLista(); });
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
}

function filtrosAtuais() {
  return {
    curso: document.getElementById('curso-select').value,
    semestre: document.getElementById('semestre-select').value,
    faixa: document.getElementById('faixa-select').value,
    busca: document.getElementById('busca-aluno').value.trim()
  };
}

async function carregarResumo() {
  const { curso, semestre } = filtrosAtuais();
  const params = new URLSearchParams();
  if (curso) params.set('curso', curso);
  if (semestre) params.set('semestre', semestre);
  try {
    const r = await apiFetch(`/cobranca/resumo?${params.toString()}`);
    document.getElementById('kpi-alunos').textContent = r.alunos ?? '0';
    document.getElementById('kpi-parcelas-hint').textContent = `${r.parcelas ?? 0} parcela(s) vencida(s)`;
    document.getElementById('kpi-valor').textContent = fmtMoeda(r.valor_total);
    document.getElementById('kpi-faixa-inicial').textContent =
      `${r.alunos_1_30 ?? 0} (${fmtMoeda(r.valor_1_30)}) / ${r.alunos_31_60 ?? 0} (${fmtMoeda(r.valor_31_60)})`;
    document.getElementById('kpi-faixa-final').textContent =
      `${r.alunos_61_90 ?? 0} (${fmtMoeda(r.valor_61_90)}) / ${r.alunos_90_mais ?? 0} (${fmtMoeda(r.valor_90_mais)})`;
  } catch (err) {
    console.error(err);
  }
}

async function carregarCursos() {
  try {
    const cursos = await apiFetch('/cobranca/cursos');
    const select = document.getElementById('curso-select');
    select.innerHTML = '<option value="">Todos os cursos</option>' +
      cursos.map(c => `<option value="${esc(c.codcur)}">${esc(c.nome)}</option>`).join('');
  } catch (err) {
    console.error(err);
  }
}

async function carregarSemestres() {
  try {
    const semestres = await apiFetch('/cobranca/semestres');
    const select = document.getElementById('semestre-select');
    select.innerHTML = '<option value="">Todos os semestres</option>' +
      semestres.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  } catch (err) {
    console.error(err);
  }
}

async function buscarLista() {
  const tbody = document.getElementById('lista-tbody');
  const { curso, semestre, faixa, busca } = filtrosAtuais();
  if (!curso && !semestre) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Escolha um curso ou semestre e clique em "Buscar".</td></tr>';
    document.getElementById('paginacao').innerHTML = '';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Carregando...</td></tr>';
  const params = new URLSearchParams();
  if (curso) params.set('curso', curso);
  if (semestre) params.set('semestre', semestre);
  if (faixa) params.set('faixa', faixa);
  if (busca) params.set('busca', busca);
  params.set('pagina', paginaAtual);

  try {
    const linhas = await apiFetch(`/cobranca/parcelas?${params.toString()}`);
    temMaisPaginas = linhas.length === 25;
    renderizarLista(linhas);
    renderizarPaginacao();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="tabela-msg">Erro ao carregar: ${esc(err.message)}</td></tr>`;
  }
}

function renderizarLista(linhas) {
  const tbody = document.getElementById('lista-tbody');
  if (!linhas.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Nenhum aluno inadimplente encontrado com esses filtros.</td></tr>';
    return;
  }
  tbody.innerHTML = linhas.map(l => `
    <tr>
      <td>
        <strong>${esc(l.nome)}</strong>
        ${l.contato ? `<div class="linha-hint">${esc(l.contato)}</div>` : ''}
      </td>
      <td>${esc(l.curso)}</td>
      <td>${l.parcelas}</td>
      <td>${fmtMoeda(l.valor_total)}</td>
      <td><span class="faixa-badge ${faixaClasse(l.dias_atraso)}">${l.dias_atraso} dia(s)</span></td>
      <td>${l.ultimaAcao ? `<span class="acao-badge ${TIPO_CLASSE[l.ultimaAcao.tipo] || ''}">${esc(TIPO_LABEL[l.ultimaAcao.tipo] || l.ultimaAcao.tipo)}</span>` : '<span class="linha-hint">Sem ação registrada</span>'}</td>
      <td class="acoes-col">
        <button class="btn-icon btn-abrir-acao" data-codcli="${l.codcli}" data-nome="${esc(l.nome)}" data-curso="${esc(l.curso)}" title="Ver histórico / registrar ação">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-abrir-acao').forEach(btn => {
    btn.addEventListener('click', () => abrirModalAcao({
      codcli: Number(btn.dataset.codcli),
      nome: btn.dataset.nome,
      curso: btn.dataset.curso
    }));
  });
}

function renderizarPaginacao() {
  const el = document.getElementById('paginacao');
  if (paginaAtual === 1 && !temMaisPaginas) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button class="btn-secondary" id="btn-pagina-anterior" ${paginaAtual <= 1 ? 'disabled' : ''}>← Anterior</button>
    <span class="paginacao-atual">Página ${paginaAtual}</span>
    <button class="btn-secondary" id="btn-pagina-proxima" ${temMaisPaginas ? '' : 'disabled'}>Próxima →</button>
  `;
  document.getElementById('btn-pagina-anterior')?.addEventListener('click', () => { paginaAtual--; buscarLista(); });
  document.getElementById('btn-pagina-proxima')?.addEventListener('click', () => { paginaAtual++; buscarLista(); });
}

// ==========================================
// MODAL: HISTÓRICO / REGISTRAR AÇÃO
// ==========================================
function atualizarVisibilidadeEscritorio() {
  const tipo = document.getElementById('acao-tipo').value;
  document.getElementById('acao-escritorio-wrap').classList.toggle('hidden', !['enviado_advocacia', 'acordo_judicial'].includes(tipo));
}

async function abrirModalAcao(aluno) {
  acaoAlunoAtual = aluno;
  document.getElementById('acao-aluno-nome').textContent = aluno.nome;
  document.getElementById('acao-aluno-meta').textContent = aluno.curso;
  document.getElementById('acao-codcli').value = aluno.codcli;
  document.getElementById('acao-nome').value = aluno.nome;
  document.getElementById('acao-tipo').value = 'contato';
  document.getElementById('acao-escritorio').value = '';
  document.getElementById('acao-observacoes').value = '';
  atualizarVisibilidadeEscritorio();

  document.getElementById('modal-acao').classList.remove('hidden');
  await carregarHistoricoAcoes(aluno.codcli);
}

function fecharModalAcao() {
  document.getElementById('modal-acao').classList.add('hidden');
  acaoAlunoAtual = null;
}

async function carregarHistoricoAcoes(codcli) {
  const el = document.getElementById('acao-historico');
  el.textContent = 'Carregando...';
  try {
    const acoes = await apiFetch(`/cobranca/acoes/${codcli}`);
    if (!acoes.length) {
      el.innerHTML = '<p class="linha-hint">Nenhuma ação registrada ainda.</p>';
      return;
    }
    el.innerHTML = acoes.map(a => `
      <div class="acao-item">
        <div class="acao-item-topo">
          <span class="acao-badge ${TIPO_CLASSE[a.tipo] || ''}">${esc(TIPO_LABEL[a.tipo] || a.tipo)}</span>
          <span class="linha-hint">${esc(a.criadoPorNome || '')}</span>
        </div>
        ${a.escritorio ? `<div class="acao-item-escritorio">${esc(a.escritorio)}</div>` : ''}
        ${a.observacoes ? `<div class="acao-item-obs">${esc(a.observacoes)}</div>` : ''}
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = `<p class="linha-hint">Erro ao carregar histórico: ${esc(err.message)}</p>`;
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
        codcli: document.getElementById('acao-codcli').value,
        nomeAluno: document.getElementById('acao-nome').value,
        tipo: document.getElementById('acao-tipo').value,
        escritorio: document.getElementById('acao-escritorio').value,
        observacoes: document.getElementById('acao-observacoes').value
      })
    });
    showToast('Ação registrada!');
    document.getElementById('acao-observacoes').value = '';
    await carregarHistoricoAcoes(acaoAlunoAtual.codcli);
    buscarLista();
  } catch (err) {
    showToast('Erro ao registrar ação: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ==========================================
// IMPORTAR CSV (advocacia/judicial) — não existe fonte disso no Edubox,
// então é a própria lista do financeiro, subida manualmente. Colunas:
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
  // Confere no Edubox quais CPFs existem, só pra dar feedback visual no
  // preview (o backend refaz essa checagem na hora de gravar de qualquer
  // forma) — usa a mesma rota de importação em modo de checagem seria
  // redundante, então aqui só mostra "com CPF" vs "sem CPF".
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
    if (resultado.semCpfEncontrado?.length) msg += ` ${resultado.semCpfEncontrado.length} sem vínculo automático com o Edubox (ver histórico de cada aluno manualmente).`;
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
// RELATÓRIO IMPRIMÍVEL (relatorio.html)
// ==========================================
async function initPaginaRelatorio() {
  try {
    const [cursos, semestres] = await Promise.all([
      apiFetch('/cobranca/cursos'),
      apiFetch('/cobranca/semestres')
    ]);
    const cursoSelect = document.getElementById('curso-select');
    cursoSelect.innerHTML = '<option value="">Todos os cursos</option>' + cursos.map(c => `<option value="${esc(c.codcur)}">${esc(c.nome)}</option>`).join('');
    const semSelect = document.getElementById('semestre-select');
    semSelect.innerHTML = '<option value="">Todos os semestres</option>' + semestres.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  } catch (err) {
    console.error(err);
  }

  const dataEmissao = document.getElementById('print-data-emissao');
  if (dataEmissao) dataEmissao.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  document.getElementById('btn-gerar-relatorio')?.addEventListener('click', gerarRelatorio);
  document.getElementById('btn-imprimir-relatorio')?.addEventListener('click', () => window.print());
}

async function gerarRelatorio() {
  const curso = document.getElementById('curso-select').value;
  const semestre = document.getElementById('semestre-select').value;
  if (!curso && !semestre) {
    showToast('Escolha ao menos um curso ou semestre.', 'error');
    return;
  }
  const tbody = document.getElementById('relatorio-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="tabela-msg">Carregando...</td></tr>';

  const params = new URLSearchParams();
  if (curso) params.set('curso', curso);
  if (semestre) params.set('semestre', semestre);

  try {
    const resumo = await apiFetch(`/cobranca/resumo?${params.toString()}`);
    document.getElementById('rel-kpi-alunos').textContent = resumo.alunos ?? '0';
    document.getElementById('rel-kpi-valor').textContent = fmtMoeda(resumo.valor_total);
    document.getElementById('rel-kpi-parcelas').textContent = resumo.parcelas ?? '0';

    let todasLinhas = [];
    let pagina = 1;
    while (true) {
      params.set('pagina', pagina);
      const linhas = await apiFetch(`/cobranca/parcelas?${params.toString()}`);
      todasLinhas = todasLinhas.concat(linhas);
      if (linhas.length < 25) break;
      pagina++;
      if (pagina > 40) break; // trava de segurança (1000 alunos)
    }

    if (!todasLinhas.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="tabela-msg">Nenhum aluno inadimplente encontrado com esses filtros.</td></tr>';
      return;
    }

    tbody.innerHTML = todasLinhas.map(l => `
      <tr>
        <td>${esc(l.nome)}</td>
        <td>${esc(l.curso)}</td>
        <td>${l.parcelas}</td>
        <td>${fmtMoeda(l.valor_total)}</td>
        <td>${l.dias_atraso} dia(s)</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
  }
}
