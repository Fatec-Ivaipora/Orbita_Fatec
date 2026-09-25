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

// ==========================================
// GRUPOS DE SITUAÇÃO — definição ÚNICA, usada em todas as contas da tela
// (cards, resumo, ranking por curso, detalhes). A mesma lista existe em
// src/rotas/matriculas.js (comparativo) — mudou aqui, muda lá (25/09).
//   Veteranos = "Total de Rematrícula" da planilha (assinada + pendência +
//               não assinou) + formando/reprovado — ainda são alunos da casa.
//   Calouros  = "Ativos calouros" da planilha (matrícula nova, assinada,
//               retorno) + transferência de entrada.
//   Ativos    = Veteranos + Calouros          (sempre fecha)
//   Total     = Ativos + Perdas + Mudança de curso   (sempre fecha)
// Mudança de Curso NÃO é perda: o aluno continua estudando na faculdade, só
// trocou de curso — fica numa linha própria, igual na planilha (25/09).
// Antes cada lugar tinha a própria cópia da lista: "Retorno" ficava fora de
// Ativos e de Perdas, e o ranking chamava de veterano quem tinha trancado.
// ==========================================
const VETERANOS_SITS = ['Rematrícula Assinada', 'Pendência Financeira', 'Não Assinou', 'Formando', 'Reprovado'];
const CALOUROS_SITS = [
  'Matrícula Nova', 'Matrícula Nova - Assinada',
  'Matrícula Nova - Retorno', 'Matrícula Nova - Retorno Assinada', 'Retorno',
  'Matrícula Nova - Transferência', 'Matrícula Nova - Transferência Assinada'
];
const ATIVOS_SITS = [...VETERANOS_SITS, ...CALOUROS_SITS];
// "Desistente" puro só existe no histórico; no sistema é Calouro/Veterano (25/09).
const PERDAS_SITS = ['Cancelou', 'Trancou', '1ª Evasão', '2ª Evasão', 'Transferência',
  'Desistente — Calouro', 'Desistente — Veterano', 'Desistente'];
const MUDANCA_CURSO_SITS = ['Mudança de Curso'];

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

// Usado só no guard de acesso (role/permissões no login) — uma instabilidade
// passageira de rede/servidor nessas duas chamadas não pode virar "sem
// acesso" e chutar quem já tem permissão de volta pro Meu Espaço. Tenta de
// novo uma vez antes de desistir.
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

    setCachedAuth(user, role, token);

    let level = 1;
    if (role === 'adm_l1') {
      level = 3;
    } else {
      try {
        const perms = await apiFetchComRetentativa('/usuarios/config/permissions');
        level = getEffectiveLevel(perms[role] || {}, meuOverrides, 'matriculas');
      } catch (e) {
        if (role === 'adm_l2') level = 3;
      }
    }

    if (level < 2) {
      window.location.href = '../../meu-espaco/index.html';
      return;
    }

    document.body.classList.toggle('hide-execute', level < 3);

    if (!appInitialized || initializedRole !== role || (cached && (cached.user.displayName !== user.displayName || cached.user.email !== user.email))) {
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

  setupLayout(user, role, 'matriculas', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  document.getElementById('app').classList.remove('hidden');

  if (document.getElementById('virar-semestre-root')) {
    initPaginaVirarSemestre();
  } else if (document.getElementById('alunos-tbody')) {
    initPaginaLancamento();
  } else if (document.getElementById('matriculas-relatorio-root')) {
    initPaginaRelatorio();
  } else if (document.getElementById('matriculas-aluno-indica-root')) {
    initPaginaAlunoIndica();
  } else if (document.getElementById('matriculas-comparativo-root')) {
    initPaginaComparativo();
  }
}

// Lista de semestres existentes (padrão + os já criados via "Virar Semestre")
// pros três seletores do módulo — busca uma vez por carregamento de página,
// nunca varre a coleção de alunos inteira só pra montar esse combo.
async function popularSelectSemestres(selectEl) {
  if (!selectEl) return;
  const valorAtual = selectEl.value;
  try {
    const { semestres } = await apiFetch('/matriculas/config/semestres');
    selectEl.innerHTML = semestres.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    selectEl.value = semestres.includes(valorAtual) ? valorAtual : semestres[semestres.length - 1];
  } catch (err) {
    showToast('Erro ao carregar semestres: ' + err.message, 'error');
  }
}

// ==========================================
// TELA DE LANÇAMENTO (index.html)
// ==========================================
let cursosFatec = [];
let opcoes = { situacoes: [], planosConfissao: [] };
let moduloSelecionado = 'fatec';
let semestreSelecionado = '2026.2';
let cursoSelecionadoId = null;
let cursoSelecionadoNome = null;

// Filtro de período tipo Excel: começa com tudo marcado (equivale a "sem
// filtro"); guarda só quem foi DESMARCADO, não quem está marcado — assim,
// se a lista de períodos mudar (Fatec x Medicina), o que nunca foi
// desmarcado continua marcado automaticamente.
const TODOS_OS_PERIODOS = [...Array.from({ length: 12 }, (_, i) => `${i + 1}º`), 'DP'];
let periodosDesmarcados = new Set();

// Mesma ideia pro filtro de Situação — guarda só quem foi desmarcado.
let situacoesDesmarcadas = new Set();

let alunos = [];
let alunosNextCursor = null;
let alunosHasMore = false;
let alunosCarregandoTodas = false;
let alunoEmEdicaoId = null;
let buscaAlunoTimer = null;

async function initPaginaLancamento() {
  await Promise.all([carregarOpcoes(), carregarCursosFatec()]);
  popularSelectsOpcoes();
  setupPeriodoMultiSelect();
  setupSituacaoMultiSelect();
  await popularSelectSemestres(document.getElementById('semestre-select'));
  semestreSelecionado = document.getElementById('semestre-select')?.value || semestreSelecionado;

  document.getElementById('modulo-select')?.addEventListener('change', (e) => {
    moduloSelecionado = e.target.value;
    cursoSelecionadoId = null;
    cursoSelecionadoNome = null;
    document.getElementById('curso-select').value = '';
    atualizarVisibilidadeCurso();
    atualizarBotaoNovoAluno();
    atualizarLabelImpressaoLista();
    if (podeCarregar()) { carregarAlunos(); atualizarContadorRegistros(); }
    else { renderTabelaAlunos([]); limparContadorRegistros(); }
  });

  document.getElementById('semestre-select')?.addEventListener('change', (e) => {
    semestreSelecionado = e.target.value;
    atualizarBotaoNovoAluno();
    atualizarLabelImpressaoLista();
    if (podeCarregar()) { carregarAlunos(); atualizarContadorRegistros(); }
    else { renderTabelaAlunos([]); limparContadorRegistros(); }
  });

  document.getElementById('curso-select')?.addEventListener('change', (e) => {
    cursoSelecionadoId = e.target.value || null;
    const curso = cursosFatec.find(c => c.id === cursoSelecionadoId);
    cursoSelecionadoNome = curso ? curso.name : null;
    atualizarBotaoNovoAluno();
    atualizarLabelImpressaoLista();
    if (podeCarregar()) { carregarAlunos(); atualizarContadorRegistros(); }
    else { renderTabelaAlunos([]); limparContadorRegistros(); }
  });

  ['plano-filtro'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (podeCarregar()) { carregarAlunos(); atualizarContadorRegistros(); }
    });
  });

  // Busca vai pro servidor (mesmo padrão de situação/período/plano) em vez
  // de carregar TODOS os alunos do módulo pra filtrar no navegador — sem
  // curso selecionado isso podia significar buscar as ~1700 matrículas do
  // semestre inteiro, página por página, só pra achar "amanda". Debounce de
  // 300ms pra não disparar 1 busca por tecla digitada.
  document.getElementById('busca-aluno')?.addEventListener('input', () => {
    clearTimeout(buscaAlunoTimer);
    buscaAlunoTimer = setTimeout(() => {
      if (podeCarregar()) recarregarPrimeiraPaginaAlunos();
    }, 300);
  });

  document.getElementById('btn-carregar-mais')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-carregar-mais');
    btn.disabled = true;
    btn.textContent = 'Carregando...';
    try {
      await buscarProximaPaginaAlunos(false);
      renderTabelaAlunos(alunos);
    } catch (err) {
      showToast('Erro ao carregar mais alunos: ' + err.message, 'error');
    } finally {
      atualizarBotaoCarregarMais();
    }
  });

  document.getElementById('btn-imprimir-lista')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const textoOriginal = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparando...';
    try {
      // Impressão precisa ver a lista inteira filtrada, não só a página já
      // carregada na tela — busca o restante antes de abrir o diálogo.
      if (alunosHasMore) await carregarTodasPaginasRestantes();
      renderTabelaAlunos(alunos);
    } catch (err) {
      showToast('Erro ao preparar impressão: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = textoOriginal;
    }
    window.print();
  });

  setupModalAluno();
  atualizarVisibilidadeCurso();
  atualizarBotaoNovoAluno();
  atualizarLabelImpressaoLista();
  if (podeCarregar()) { carregarAlunos(); atualizarContadorRegistros(); }
}

// Contador "X com esse filtro — Y no total" — usa aggregation query do
// Firestore (count()), não busca os documentos, então funciona instantâneo
// mesmo com Fatec tendo 1500+ alunos no módulo/semestre.
function limparContadorRegistros() {
  const el = document.getElementById('contador-registros');
  if (el) el.textContent = '';
}

async function atualizarContadorRegistros() {
  const el = document.getElementById('contador-registros');
  if (!el || !podeCarregar()) return;
  try {
    const params = new URLSearchParams({ modulo: moduloSelecionado, semestre: semestreSelecionado });
    if (cursoSelecionadoId) params.set('cursoId', cursoSelecionadoId);
    const periodos = periodosFiltroAtual();
    const situacoes = situacoesFiltroAtual();
    const plano = document.getElementById('plano-filtro')?.value;
    if (periodos.length) params.set('periodos', periodos.join(','));
    if (situacoes.length) params.set('situacoes', situacoes.join(','));
    if (plano) params.set('planoConfissao', plano);

    const { total, filtrados } = await apiFetch(`/matriculas/alunos/contagem?${params.toString()}`);
    el.textContent = (filtrados === total)
      ? `${total} aluno${total === 1 ? '' : 's'} no total`
      : `${filtrados} aluno${filtrados === 1 ? '' : 's'} com esse filtro — ${total} no total`;
  } catch (err) {
    limparContadorRegistros();
  }
}

// Curso é opcional pra LISTAR (dá pra ver "todos os cursos" e filtrar por
// período/situação através do módulo inteiro), mas é obrigatório pra CRIAR
// um aluno novo em Fatec (não existe aluno sem curso).
function podeCarregar() {
  return !!semestreSelecionado;
}
function podeCriarAluno() {
  return !!semestreSelecionado && (moduloSelecionado === 'medicina' || !!cursoSelecionadoId);
}

function atualizarVisibilidadeCurso() {
  const isFatec = moduloSelecionado === 'fatec';
  document.getElementById('curso-select')?.classList.toggle('hidden', !isFatec);
  document.getElementById('grupo-curso-aluno')?.classList.toggle('hidden', !isFatec);
}

function atualizarBotaoNovoAluno() {
  document.getElementById('btn-novo-aluno')?.toggleAttribute('disabled', !podeCriarAluno());
}

// Label do cabeçalho de impressão da lista (index.html) — mesmo padrão do
// atualizarLabelImpressaoRelatorio já usado em relatorio.html. Estava sendo
// chamada nos handlers de módulo/semestre/curso mas nunca tinha sido escrita:
// isso derrubava o handler inteiro com ReferenceError, então trocar o curso
// nunca chegava a recarregar a lista.
function atualizarLabelImpressaoLista() {
  const label = document.getElementById('print-filtro-label-lista');
  if (!label) return;
  const modulo = moduloSelecionado === 'medicina' ? 'Medicina' : 'Fatec';
  const partes = [modulo];
  if (moduloSelecionado !== 'medicina') partes.push(cursoSelecionadoNome || 'Todos os cursos');
  partes.push(semestreSelecionado);
  label.textContent = partes.filter(Boolean).join(' — ');
}

async function carregarOpcoes() {
  try {
    opcoes = await apiFetch('/matriculas/config/opcoes');
  } catch (err) {
    showToast('Erro ao carregar opções: ' + err.message, 'error');
  }
}

// Reaproveita a mesma proxy de `courses` já usada em Licitação — Medicina não
// entra na lista porque já é o outro módulo, selecionado à parte.
async function carregarCursosFatec() {
  try {
    const todos = await apiFetch('/financeiro/cursos');
    cursosFatec = todos.filter(c => (c.name || '').trim().toLowerCase() !== 'medicina');
  } catch (err) {
    showToast('Erro ao carregar cursos: ' + err.message, 'error');
  }
}

function popularSelectsOpcoes() {
  const selectCurso = document.getElementById('curso-select');
  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosFatec.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }

  montarPeriodoMultiSelect();

  montarSituacaoMultiSelect();
  const planoFiltro = document.getElementById('plano-filtro');
  if (planoFiltro) {
    planoFiltro.innerHTML = '<option value="">Todos os planos/confissão</option>' +
      opcoes.planosConfissao.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }

  const selectSituacaoAluno = document.getElementById('aluno-situacao');
  // Desistente: 1º período = calouro, outro = veterano — acerta sozinho ao
  // escolher a situação ou mudar o período (o servidor também garante isso).
  const acertarDesistente = () => {
    const sel = document.getElementById('aluno-situacao');
    const per = (document.getElementById('aluno-periodo')?.value || '').trim();
    if (!sel || !/^Desistente/.test(sel.value)) return;
    sel.value = per === '1º' ? 'Desistente — Calouro' : 'Desistente — Veterano';
  };
  selectSituacaoAluno?.addEventListener('change', acertarDesistente);
  document.getElementById('aluno-periodo')?.addEventListener('change', acertarDesistente);
  if (selectSituacaoAluno) {
    selectSituacaoAluno.innerHTML = opcoes.situacoes.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  }
  const selectPlanoAluno = document.getElementById('aluno-plano');
  if (selectPlanoAluno) {
    selectPlanoAluno.innerHTML = opcoes.planosConfissao.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }
  const selectCursoAluno = document.getElementById('aluno-curso');
  if (selectCursoAluno) {
    selectCursoAluno.innerHTML = cursosFatec.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
}

// Fatec vai até o 10º período (+ "DP" de dependência); Medicina até o 12º —
// lista única cobrindo os dois, filtrar por um período que não existe no
// módulo atual simplesmente não retorna ninguém.
// Monta o filtro de período tipo Excel: abre com tudo marcado, "Marcar
// todos"/"Desmarcar todos" e uma caixinha por período — a pessoa desmarca
// o que não quer ver, igual num filtro de coluna de planilha.
function montarPeriodoMultiSelect() {
  const opcoesEl = document.getElementById('periodo-opcoes');
  if (!opcoesEl) return;
  opcoesEl.innerHTML = TODOS_OS_PERIODOS.map(p => `
    <label>
      <input type="checkbox" class="periodo-checkbox" value="${esc(p)}" ${periodosDesmarcados.has(p) ? '' : 'checked'}>
      ${esc(p)}
    </label>
  `).join('');
  atualizarBotaoPeriodo();
}

function atualizarBotaoPeriodo() {
  const btn = document.getElementById('periodo-btn');
  if (!btn) return;
  const marcados = TODOS_OS_PERIODOS.length - periodosDesmarcados.size;
  if (periodosDesmarcados.size === 0) btn.textContent = 'Todos os períodos';
  else if (marcados === 0) btn.textContent = 'Nenhum período';
  else btn.textContent = `${marcados} período(s) selecionado(s)`;
}

// Lista de períodos a mandar pro servidor — vazio significa "sem filtro"
// (todos marcados), pra não esconder aluno com período em branco.
function periodosFiltroAtual() {
  if (periodosDesmarcados.size === 0) return [];
  return TODOS_OS_PERIODOS.filter(p => !periodosDesmarcados.has(p));
}

function setupPeriodoMultiSelect() {
  const wrap = document.getElementById('periodo-multiselect');
  const btn = document.getElementById('periodo-btn');
  const panel = document.getElementById('periodo-panel');
  const opcoesEl = document.getElementById('periodo-opcoes');
  if (!wrap || !btn || !panel || !opcoesEl) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) panel.classList.add('hidden');
  });

  wrap.querySelectorAll('.multi-select-acoes button').forEach(acaoBtn => {
    acaoBtn.addEventListener('click', () => {
      periodosDesmarcados = acaoBtn.dataset.acao === 'nenhum' ? new Set(TODOS_OS_PERIODOS) : new Set();
      montarPeriodoMultiSelect();
      if (podeCarregar()) { carregarAlunos(); atualizarContadorRegistros(); }
    });
  });

  opcoesEl.addEventListener('change', (e) => {
    if (!e.target.classList.contains('periodo-checkbox')) return;
    const valor = e.target.value;
    if (e.target.checked) periodosDesmarcados.delete(valor);
    else periodosDesmarcados.add(valor);
    atualizarBotaoPeriodo();
    if (podeCarregar()) { carregarAlunos(); atualizarContadorRegistros(); }
  });
}

// Mesmo filtro tipo Excel, agora pra Situação — lista vem de opcoes.situacoes
// (carregada do servidor), não é fixa como a de período.
function getSituacoesDisplay() {
  // Desde 25/09 "Desistente — Calouro/Veterano" são situações reais do
  // cadastro — o filtro usa a mesma lista, sem expandir nada.
  return opcoes.situacoes;
}

function montarSituacaoMultiSelect() {
  const opcoesEl = document.getElementById('situacao-opcoes');
  if (!opcoesEl) return;
  const display = getSituacoesDisplay();
  opcoesEl.innerHTML = display.map(s => `
    <label>
      <input type="checkbox" class="situacao-checkbox" value="${esc(s)}" ${situacoesDesmarcadas.has(s) ? '' : 'checked'}>
      ${esc(s)}
    </label>
  `).join('');
  atualizarBotaoSituacao();
}

function atualizarBotaoSituacao() {
  const btn = document.getElementById('situacao-btn');
  if (!btn) return;
  const display = getSituacoesDisplay();
  const marcados = display.length - situacoesDesmarcadas.size;
  if (situacoesDesmarcadas.size === 0) btn.textContent = 'Todas as situações';
  else if (marcados === 0) btn.textContent = 'Nenhuma situação';
  else btn.textContent = `${marcados} situação(ões) selecionada(s)`;
}

function situacoesFiltroAtual() {
  if (situacoesDesmarcadas.size === 0) return [];
  return getSituacoesDisplay().filter(s => !situacoesDesmarcadas.has(s));
}

function setupSituacaoMultiSelect() {
  const wrap = document.getElementById('situacao-multiselect');
  const btn = document.getElementById('situacao-btn');
  const panel = document.getElementById('situacao-panel');
  const opcoesEl = document.getElementById('situacao-opcoes');
  if (!wrap || !btn || !panel || !opcoesEl) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) panel.classList.add('hidden');
  });

  wrap.querySelectorAll('.multi-select-acoes button').forEach(acaoBtn => {
    acaoBtn.addEventListener('click', () => {
      situacoesDesmarcadas = acaoBtn.dataset.acao === 'nenhum' ? new Set(getSituacoesDisplay()) : new Set();
      montarSituacaoMultiSelect();
      if (podeCarregar()) { carregarAlunos(); atualizarContadorRegistros(); }
    });
  });

  opcoesEl.addEventListener('change', (e) => {
    if (!e.target.classList.contains('situacao-checkbox')) return;
    const valor = e.target.value;
    if (e.target.checked) situacoesDesmarcadas.delete(valor);
    else situacoesDesmarcadas.add(valor);
    atualizarBotaoSituacao();
    if (podeCarregar()) { carregarAlunos(); atualizarContadorRegistros(); }
  });
}

// Grupo de badge por SITUAÇÃO — cor por significado (ok/alerta/crítica/neutra),
// não por valor individual, senão vira uma cor aleatória por texto.
const SITUACAO_GRUPO = {
  'Matrícula Nova - Assinada': 'ok', 'Rematrícula Assinada': 'ok', 'Formando': 'ok',
  'Matrícula Nova - Retorno Assinada': 'ok', 'Matrícula Nova - Transferência Assinada': 'ok',
  'Matrícula Nova': 'alerta', 'Pendência Financeira': 'alerta', 'Não Assinou': 'alerta',
  'Matrícula Nova - Retorno': 'alerta', 'Matrícula Nova - Transferência': 'alerta',
  'Cancelou': 'critica', 'Trancou': 'critica', '1ª Evasão': 'critica', '2ª Evasão': 'critica',
  'Desistente': 'critica', 'Desistente — Calouro': 'critica', 'Desistente — Veterano': 'critica', 'Reprovado': 'critica',
  'Transferência': 'neutra', 'Mudança de Curso': 'neutra'
};
function situacaoBadgeClasse(situacao) {
  return `situacao-${SITUACAO_GRUPO[situacao] || 'neutra'}`;
}

async function buscarProximaPaginaAlunos(primeira) {
  const params = new URLSearchParams();
  params.set('modulo', moduloSelecionado);
  params.set('semestre', semestreSelecionado);
  if (cursoSelecionadoId) params.set('cursoId', cursoSelecionadoId);
  const periodos = periodosFiltroAtual();
  const situacoes = situacoesFiltroAtual();
  const plano = document.getElementById('plano-filtro')?.value;
  if (periodos.length) params.set('periodos', periodos.join(','));
  if (situacoes.length) params.set('situacoes', situacoes.join(','));
  if (plano) params.set('planoConfissao', plano);
  const busca = document.getElementById('busca-aluno')?.value.trim();
  if (busca) params.set('busca', busca);
  if (!primeira && alunosNextCursor) {
    params.set('cursorNome', alunosNextCursor.nome);
    params.set('cursorId', alunosNextCursor.id);
  }
  const resp = await apiFetch(`/matriculas/alunos?${params.toString()}`);
  alunos = primeira ? resp.alunos : [...alunos, ...resp.alunos];
  alunosHasMore = resp.hasMore;
  alunosNextCursor = resp.nextCursor;
}

async function carregarTodasPaginasRestantes() {
  if (alunosCarregandoTodas) return;
  alunosCarregandoTodas = true;
  const btn = document.getElementById('btn-carregar-mais');
  if (btn) { btn.disabled = true; btn.textContent = 'Carregando tudo pra buscar...'; }
  try {
    while (alunosHasMore) {
      await buscarProximaPaginaAlunos(false);
    }
  } finally {
    alunosCarregandoTodas = false;
  }
}

function atualizarBotaoCarregarMais() {
  const wrap = document.getElementById('carregar-mais-wrap');
  const btn = document.getElementById('btn-carregar-mais');
  if (!wrap || !btn) return;
  // Busca por nome agora pagina no servidor igual qualquer outro filtro —
  // não precisa mais esconder "Carregar mais" enquanto busca.
  wrap.classList.toggle('hidden', !alunosHasMore);
  btn.disabled = false;
  btn.textContent = 'Carregar mais';
}

async function recarregarPrimeiraPaginaAlunos() {
  const tbody = document.getElementById('alunos-tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="tabela-msg">Carregando...</td></tr>`;
  alunos = [];
  alunosNextCursor = null;
  try {
    await buscarProximaPaginaAlunos(true);
    renderTabelaAlunos(alunos);
    atualizarBotaoCarregarMais();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="tabela-msg">Erro ao carregar: ${esc(err.message)}</td></tr>`;
  }
}

// Troca de módulo/semestre/curso/período/situação/plano limpa uma busca por
// nome em andamento (o filtro mudou, a busca antiga não faz mais sentido).
async function carregarAlunos() {
  document.getElementById('busca-aluno').value = '';
  await recarregarPrimeiraPaginaAlunos();
}

function renderTabelaAlunos(lista) {
  const tbody = document.getElementById('alunos-tbody');
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="tabela-msg">Nenhum aluno encontrado para os filtros atuais.</td></tr>';
    return;
  }
  tbody.innerHTML = lista.map(a => `
    <tr>
      <td>${esc(a.nome)}${a.revisarManualmente ? '<span class="revisar-badge" title="Migrado da planilha com situação/plano fora do padrão — confira e edite.">⚠ revisar</span>' : ''}</td>
      <td>${esc(a.curso)}</td>
      <td>${esc(a.periodo)}</td>
      <td>${esc(a.cidade)}</td>
      <td><span class="status-badge ${situacaoBadgeClasse(a.situacao)}">${esc(a.situacao)}</span></td>
      <td>${esc(a.planoConfissao)}</td>
      <td>${esc(a.telefone)}</td>
      <td class="acoes-col">
        <button type="button" class="btn-icon" data-editar="${a.id}" title="Editar">✏️</button>
        <button type="button" class="btn-icon" data-excluir="${a.id}" data-nome="${esc(a.nome)}" title="Excluir">🗑️</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-editar]').forEach(btn => btn.addEventListener('click', () => {
    const aluno = alunos.find(a => a.id === btn.dataset.editar);
    if (aluno) abrirModalAluno(aluno);
  }));
  tbody.querySelectorAll('[data-excluir]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`Excluir o registro de "${btn.dataset.nome}"?`)) return;
    try {
      await apiFetch(`/matriculas/alunos/${btn.dataset.excluir}`, { method: 'DELETE' });
      showToast('Aluno excluído');
      await carregarAlunos();
    } catch (err) {
      showToast('Erro ao excluir: ' + err.message, 'error');
    }
  }));
}

// ==========================================
// "ALUNO INDICA" — busca o veterano por nome (entre os já matriculados no
// módulo/semestre do calouro que está sendo cadastrado) e guarda
// id+nome do escolhido. `null` explícito quando a pessoa limpa a seleção,
// pra dar pra desfazer um "indica" cadastrado errado.
// ==========================================
let alunoIndicadoPor = null; // { id, nome } | null
let indicadoPorDebounce = null;

function renderChipIndicadoPor() {
  const chip = document.getElementById('aluno-indicado-por-chip');
  const busca = document.getElementById('aluno-indicado-por-busca');
  document.getElementById('aluno-indicado-por-id').value = alunoIndicadoPor?.id || '';
  if (alunoIndicadoPor) {
    chip.innerHTML = `<span class="indicado-por-selecionado">${esc(alunoIndicadoPor.nome)} <button type="button" id="btn-limpar-indicado-por">✕</button></span>`;
    chip.classList.remove('hidden');
    busca.classList.add('hidden');
    document.getElementById('btn-limpar-indicado-por').addEventListener('click', () => {
      alunoIndicadoPor = null;
      busca.value = '';
      renderChipIndicadoPor();
    });
  } else {
    chip.classList.add('hidden');
    chip.innerHTML = '';
    busca.classList.remove('hidden');
  }
}

// Lista de semestres já existentes no sistema (busca uma vez só e guarda —
// não muda durante a sessão) — usada pra buscar o veterano em TODOS os
// semestres, não só o do calouro sendo cadastrado. Sem isso, um veterano que
// ainda não foi "virado" pro semestre novo (comum logo que abre um semestre)
// nunca aparecia na busca.
let semestresParaBuscaVeterano = null;
async function listaSemestresParaBuscaVeterano() {
  if (semestresParaBuscaVeterano) return semestresParaBuscaVeterano;
  try {
    const { semestres } = await apiFetch('/matriculas/config/semestres');
    semestresParaBuscaVeterano = semestres;
  } catch (err) {
    semestresParaBuscaVeterano = [semestreSelecionado];
  }
  return semestresParaBuscaVeterano;
}

async function buscarVeteranosParaIndicacao(termo) {
  const resultados = document.getElementById('aluno-indicado-por-resultados');
  if (!termo || termo.trim().length < 2) { resultados.classList.add('hidden'); return; }
  try {
    const semestres = await listaSemestresParaBuscaVeterano();
    // Busca em todos os semestres em paralelo (lista é pequena, poucas
    // dezenas no máximo) e junta os resultados — o mesmo termo pode achar
    // gente em semestres diferentes.
    const porSemestre = await Promise.all(semestres.map(async (semestre) => {
      const params = new URLSearchParams({ modulo: moduloSelecionado, semestre, busca: termo.trim(), pageSize: '8' });
      try {
        const resp = await apiFetch(`/matriculas/alunos?${params.toString()}`);
        return resp.alunos;
      } catch (err) {
        return [];
      }
    }));
    const candidatos = porSemestre.flat()
      .filter(a => a.id !== alunoEmEdicaoId) // aluno não pode indicar a si mesmo
      .sort((a, b) => (b.semestre || '').localeCompare(a.semestre || '')) // semestre mais recente primeiro
      .slice(0, 8);

    if (!candidatos.length) {
      resultados.innerHTML = '<div class="autocomplete-vazio">Nenhum aluno encontrado com esse nome neste módulo.</div>';
    } else {
      resultados.innerHTML = candidatos.map(a => `
        <div class="autocomplete-item" data-id="${a.id}" data-nome="${esc(a.nome)}">
          <strong>${esc(a.nome)}</strong>
          <span>${esc(a.curso)} — ${esc(a.periodo || '')} — ${esc(a.semestre)}</span>
        </div>
      `).join('');
      resultados.querySelectorAll('.autocomplete-item').forEach(item => {
        item.addEventListener('click', () => {
          alunoIndicadoPor = { id: item.dataset.id, nome: item.dataset.nome };
          resultados.classList.add('hidden');
          renderChipIndicadoPor();
        });
      });
    }
    resultados.classList.remove('hidden');
  } catch (err) {
    resultados.classList.add('hidden');
  }
}

function setupModalAluno() {
  const modal = document.getElementById('modal-aluno');
  if (!modal) return;

  document.getElementById('btn-novo-aluno')?.addEventListener('click', () => abrirModalAluno(null));
  document.getElementById('btn-cancelar-aluno')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('aluno-indicado-por-busca')?.addEventListener('input', (e) => {
    clearTimeout(indicadoPorDebounce);
    const termo = e.target.value;
    indicadoPorDebounce = setTimeout(() => buscarVeteranosParaIndicacao(termo), 300);
  });
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('aluno-indicado-por-resultados');
    if (wrap && !wrap.contains(e.target) && e.target.id !== 'aluno-indicado-por-busca') wrap.classList.add('hidden');
  });

  document.getElementById('form-aluno')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-salvar-aluno');
    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      const cursoSel = document.getElementById('aluno-curso');
      const cursoNome = cursoSel?.selectedOptions?.[0]?.textContent || cursoSelecionadoNome;
      const payload = {
        nome: document.getElementById('aluno-nome').value,
        periodo: document.getElementById('aluno-periodo').value,
        cidade: document.getElementById('aluno-cidade').value,
        telefone: document.getElementById('aluno-telefone').value,
        situacao: document.getElementById('aluno-situacao').value,
        planoConfissao: document.getElementById('aluno-plano').value,
        observacoes: document.getElementById('aluno-observacoes').value,
        indicadoPorAlunoId: alunoIndicadoPor?.id || null,
        indicadoPorNome: alunoIndicadoPor?.nome || null
      };
      if (moduloSelecionado === 'fatec') {
        payload.cursoId = cursoSel.value;
        payload.curso = cursoNome;
      }

      if (alunoEmEdicaoId) {
        await apiFetch(`/matriculas/alunos/${alunoEmEdicaoId}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Aluno atualizado');
      } else {
        payload.modulo = moduloSelecionado;
        payload.semestre = semestreSelecionado;
        await apiFetch('/matriculas/alunos', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Aluno cadastrado');
      }
      modal.classList.add('hidden');
      await carregarAlunos();
    } catch (err) {
      showToast('Erro ao salvar: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

function abrirModalAluno(aluno) {
  alunoEmEdicaoId = aluno ? aluno.id : null;
  document.getElementById('modal-aluno-title').textContent = aluno ? 'Editar Aluno' : 'Novo Aluno';
  document.getElementById('aluno-id').value = aluno?.id || '';
  document.getElementById('aluno-nome').value = aluno?.nome || '';
  document.getElementById('aluno-periodo').value = aluno?.periodo || '';
  document.getElementById('aluno-cidade').value = aluno?.cidade || '';
  document.getElementById('aluno-telefone').value = aluno?.telefone || '';
  document.getElementById('aluno-situacao').value = aluno?.situacao || opcoes.situacoes[0] || '';
  document.getElementById('aluno-plano').value = aluno?.planoConfissao || 'Não';
  document.getElementById('aluno-observacoes').value = aluno?.observacoes || '';

  const grupoCurso = document.getElementById('grupo-curso-aluno');
  const isFatec = (aluno ? aluno.modulo : moduloSelecionado) === 'fatec';
  grupoCurso?.classList.toggle('hidden', !isFatec);
  const selectCursoAluno = document.getElementById('aluno-curso');
  if (selectCursoAluno) selectCursoAluno.value = aluno?.cursoId || cursoSelecionadoId || '';

  alunoIndicadoPor = aluno?.indicadoPorAlunoId ? { id: aluno.indicadoPorAlunoId, nome: aluno.indicadoPorNome || '' } : null;
  document.getElementById('aluno-indicado-por-busca').value = '';
  document.getElementById('aluno-indicado-por-resultados').classList.add('hidden');
  renderChipIndicadoPor();
  carregarAlunosIndicados(aluno?.id || null);

  document.getElementById('modal-aluno').classList.remove('hidden');
}

// Mostra pra quem tá editando um veterano quantos calouros ele já indicou —
// só existe pra aluno já salvo (precisa do id pra consultar).
async function carregarAlunosIndicados(alunoId) {
  const wrap = document.getElementById('aluno-indicou-wrap');
  const lista = document.getElementById('aluno-indicou-lista');
  if (!alunoId) { wrap.classList.add('hidden'); return; }
  try {
    const { total, indicados } = await apiFetch(`/matriculas/alunos/${alunoId}/indicados`);
    if (!total) { wrap.classList.add('hidden'); return; }
    lista.innerHTML = `<strong style="color:var(--text-main);">${total} aluno(s) indicado(s):</strong><br>` +
      indicados.map(i => `${esc(i.nome)} — ${esc(i.curso)} (${esc(i.semestre)})`).join('<br>');
    wrap.classList.remove('hidden');
  } catch (err) {
    wrap.classList.add('hidden');
  }
}

// ==========================================
// TELA DE RELATÓRIO (relatorio.html)
// ==========================================
let relatorioEmAndamento = Promise.resolve(); // promessa da última carga, pra "Imprimir" nunca pegar dado desatualizado

async function initPaginaRelatorio() {
  const selectModulo = document.getElementById('rel-modulo-select');
  const selectSemestre = document.getElementById('rel-semestre-select');
  const selectCurso = document.getElementById('rel-curso-select');

  await carregarCursosFatec();
  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosFatec.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  await popularSelectSemestres(selectSemestre);
  atualizarVisibilidadeCursoRelatorio();

  selectModulo?.addEventListener('change', () => {
    if (selectCurso) selectCurso.value = '';
    atualizarVisibilidadeCursoRelatorio();
    atualizarLabelImpressaoRelatorio();
    relatorioEmAndamento = carregarRelatorio();
  });
  selectSemestre?.addEventListener('change', () => {
    atualizarLabelImpressaoRelatorio();
    relatorioEmAndamento = carregarRelatorio();
  });
  selectCurso?.addEventListener('change', () => {
    atualizarLabelImpressaoRelatorio();
    relatorioEmAndamento = carregarRelatorio();
  });

  atualizarLabelImpressaoRelatorio();
  const dataEmissao = document.getElementById('print-data-emissao');
  if (dataEmissao) dataEmissao.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  document.getElementById('btn-imprimir-relatorio')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const textoOriginal = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparando...';
    try {
      // Espera a busca em andamento (troca de módulo/semestre, por ex.)
      // terminar antes de imprimir — senão a impressão podia sair com os
      // dados da seleção anterior.
      await relatorioEmAndamento;
    } finally {
      btn.disabled = false;
      btn.innerHTML = textoOriginal;
    }
    window.print();
  });

  // Lupa do resumo → abre modal de detalhe usando dados do relatório atual
  // (vale pro resumo e pros cards do topo: Total de alunos, Ativos, Captados)
  document.addEventListener('click', e => {
    const btn = e.target.closest('.btn-detalhe-total[data-relatorio-chave]');
    if (!btn) return;
    abrirDetalheRelatorio(btn.dataset.relatorioChave);
  });

  // Fechar modal de detalhe
  document.getElementById('btn-fechar-detalhe-total')?.addEventListener('click', () => {
    document.getElementById('modal-detalhe-total')?.classList.add('hidden');
  });
  document.getElementById('modal-detalhe-total')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  relatorioEmAndamento = carregarRelatorio();
  await relatorioEmAndamento;
}

function atualizarVisibilidadeCursoRelatorio() {
  const isFatec = document.getElementById('rel-modulo-select')?.value !== 'medicina';
  document.getElementById('rel-curso-select')?.classList.toggle('hidden', !isFatec);
}

function atualizarLabelImpressaoRelatorio() {
  const label = document.getElementById('print-filtro-label');
  if (!label) return;
  const moduloValor = document.getElementById('rel-modulo-select')?.value;
  const modulo = moduloValor === 'medicina' ? 'Medicina' : 'Fatec';
  const semestre = document.getElementById('rel-semestre-select')?.value || '';
  const partes = [modulo];
  if (moduloValor !== 'medicina') {
    const cursoSelect = document.getElementById('rel-curso-select');
    const cursoNome = cursoSelect?.value ? cursoSelect.selectedOptions[0]?.textContent : 'Todos os cursos';
    partes.push(cursoNome);
  }
  partes.push(semestre);
  label.textContent = partes.filter(Boolean).join(' — ');
}

async function carregarRelatorio() {
  const modulo = document.getElementById('rel-modulo-select')?.value || 'fatec';
  const semestre = document.getElementById('rel-semestre-select')?.value || '2026.2';
  const cursoId = document.getElementById('rel-curso-select')?.value;
  try {
    const params = new URLSearchParams({ modulo, semestre });
    if (cursoId) params.set('cursoId', cursoId);
    const dados = await apiFetch(`/matriculas/relatorio?${params.toString()}`);
    renderRelatorio(dados);
  } catch (err) {
    showToast('Erro ao carregar relatório: ' + err.message, 'error');
  }
}

// Soma um grupo de situações pro KPI (ex.: "Cancelou / Trancou" junta 2
// situações distintas numa única leitura rápida) — sem exigir que o back
// mande o combinado já pronto.
function somaSituacoes(porSituacaoTotal, ...nomes) {
  return nomes.reduce((soma, n) => soma + (porSituacaoTotal[n] || 0), 0);
}


// ==========================================
// COMPARATIVO ENTRE SEMESTRES
// Uma coluna por semestre, uma linha por indicador — as mesmas definições dos
// cards (veterano = rematrícula, calouro = matrícula nova, perda = cancelou +
// trancou + evasões). Fica fora do carregamento do relatório de propósito:
// contar os semestres vivos custa uma leitura por aluno no Firestore, então só
// roda quando a pessoa pede.
// ==========================================
// `formula` vira tooltip (title) em cima de cada número da tabela — o
// pedido foi "passar o mouse e ver de onde vem" sem precisar abrir o código
// ou perguntar pra mim toda vez (22/09).
// Reorganizado em 3 blocos pra contar a história em ordem: o que somou
// (captação), o que diminuiu (perdas), e o total geral no fim — em vez de
// misturado (pedido 22/09). `secao` vira um cabeçalho dentro do cartão, sem
// chave/valor.
const LINHAS_COMPARATIVO = [
  { secao: 'O que somou (captação)' },
  { chave: 'veteranos', rotulo: 'Veteranos (rematrícula)',
    formula: 'Rematrícula Assinada + Pendência Financeira + Não Assinou + Formando + Reprovado (o "Total de Rematrícula" da planilha)' },
  { chave: 'calouros', rotulo: 'Calouros (matrícula nova)',
    formula: 'Matrícula Nova + Matrícula Nova - Assinada + Retorno + Matrícula Nova - Transferência (calouros ainda ativos)' },
  { chave: 'totalCalouros', rotulo: 'Total de Calouros captados', destaque: true, detalhavel: true,
    formula: 'Matrícula Nova + Matrícula Nova - Assinada + 1ª Evasão + 2ª Evasão + Retorno + Cancelou (só o de calouro) — todo mundo que entrou pela porta de calouro, ficando ou não.' },

  // Pendência Financeira e Não Assinou NÃO são perda — quem tá nessas duas
  // situações continua Ativo (ver fórmula de "ativos" logo abaixo), só falta
  // resolver uma pendência administrativa. Por isso ficam fora do bloco de
  // perdas e do "Total de perdas" (22/09).
  //
  // Cancelou e Trancou vêm separados por calouro/veterano (cruzando com
  // período: 1º = calouro, resto = veterano) — pedido 22/09, porque a
  // situação sozinha não diz quem era quem, e o setor precisa enxergar essa
  // diferença.
  { secao: 'O que diminuiu (perdas)' },
  { chave: 'primeiraEvasao', rotulo: '1ª Evasão',
    formula: 'Situação = 1ª Evasão — saiu antes de começar as aulas (só existe pra calouro)' },
  { chave: 'segundaEvasao', rotulo: '2ª Evasão',
    formula: 'Situação = 2ª Evasão' },
  { chave: 'cancelouCalouro', rotulo: 'Cancelou — calouro',
    formula: 'Situação = Cancelou, período 1º — saiu depois de começar as aulas / pagou 1ª mensalidade' },
  { chave: 'cancelouVeterano', rotulo: 'Cancelou — veterano',
    formula: 'Situação = Cancelou, período 2º em diante' },
  { chave: 'trancouCalouro', rotulo: 'Trancou — calouro',
    formula: 'Situação = Trancou, período 1º' },
  { chave: 'trancouVeterano', rotulo: 'Trancou — veterano',
    formula: 'Situação = Trancou, período 2º em diante' },
  { chave: 'transferencia', rotulo: 'Transferência',
    formula: 'Situação = Transferência — saiu para outra instituição' },
  { chave: 'desistente', rotulo: 'Desistente (total)',
    formula: 'Desistente — Calouro + Desistente — Veterano' },
  { chave: 'desistenteCalouro', rotulo: 'Desistente — calouro', ocultarSeZerado: true,
    formula: 'Situação = Desistente — Calouro (período 1º) — entra na perda de captação' },
  { chave: 'desistenteVeterano', rotulo: 'Desistente — veterano', ocultarSeZerado: true,
    formula: 'Situação = Desistente — Veterano (período 2º em diante) — entra na perda sobre o total, não na captação' },
  { chave: 'perdas', rotulo: 'Total de perdas', destaque: true,
    formula: 'Cancelou + Trancou + 1ª Evasão + 2ª Evasão + Transferência + Desistente (todo mundo que saiu da faculdade). Mudança de Curso não entra — continua estudando.' },

  { secao: 'Total geral' },
  { chave: 'pendenciaFinanceira', rotulo: 'Pendência financeira',
    formula: 'Situação = Pendência Financeira — continua Ativo, só falta resolver o pagamento. Não é perda.' },
  { chave: 'naoAssinou', rotulo: 'Não assinou',
    formula: 'Situação = Não Assinou — continua Ativo, só falta assinar. Não é perda.' },
  { chave: 'mudancaDeCurso', rotulo: 'Mudança de curso', ocultarSeZerado: true,
    formula: 'Situação = Mudança de Curso — trocou de curso dentro da faculdade. Não é perda (continua estudando) e não conta como ativo no curso antigo. Ativos + Perdas + Mudança de curso = Total de alunos.' },
  { chave: 'ativos', rotulo: 'Ativos', destaque: true, detalhavel: true,
    formula: 'Veteranos + Calouros (Rematrícula Assinada + Pendência + Não Assinou + Formando + Reprovado + Matrícula Nova + Assinada + Retorno + Transferência de entrada). Ativos + Total de perdas + Mudança de curso = Total de alunos.' },
  { chave: 'total', rotulo: 'Total de alunos', destaque: true, detalhavel: true,
    formula: 'Todo mundo que matriculou nesse semestre — inclui quem cancelou, trancou ou evadiu depois. Não é reduzido com o tempo.' },
  { chave: 'perdaCaptacao', rotulo: '% de perda de captação', percentual: true,
    formula: '(Cancelou Calouro + Desistente Calouro) ÷ Total de Calouros captados. Evasões, Desistente Veterano, Cancelou Veterano e Trancou ficam de fora.' },
  { chave: 'perdaTotal', rotulo: '% de perda sobre o total', percentual: true,
    formula: 'Total de perdas ÷ Total de alunos — todo mundo que saiu da faculdade, não importa a forma (Cancelou + Trancou + 1ª/2ª Evasão + Transferência + Desistente), calouro ou veterano. Mudança de Curso não entra: continua estudando.' }
];

async function initPaginaComparativo() {
  const selectModulo = document.getElementById('comp-modulo-select');
  selectModulo?.addEventListener('change', () => {
    atualizarLabelImpressaoComparativo();
    carregarComparativo();
  });

  document.getElementById('btn-imprimir-comparativo')?.addEventListener('click', () => window.print());

  const modal = document.getElementById('modal-detalhe-total');
  document.getElementById('btn-fechar-detalhe-total')?.addEventListener('click', () => modal.classList.add('hidden'));
  modal?.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  atualizarLabelImpressaoComparativo();
  const dataEmissao = document.getElementById('print-data-emissao');
  if (dataEmissao) dataEmissao.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  await carregarComparativo();
}

function atualizarLabelImpressaoComparativo() {
  const label = document.getElementById('print-filtro-label');
  if (!label) return;
  const modulo = document.getElementById('comp-modulo-select')?.value === 'medicina' ? 'Medicina' : 'Fatec';
  label.textContent = modulo;
}

// Guardado pra alimentar o modal "como chegou nesse número" sem precisar
// buscar de novo — atualizado toda vez que o comparativo recarrega.
let ultimoComparativo = { modulo: 'fatec', linhas: [] };
let ultimoRelatorioLinha = null; // dados do semestre atual na tela de relatório

async function carregarComparativo() {
  const modulo = document.getElementById('comp-modulo-select')?.value || 'fatec';
  document.getElementById('rel-comparativo-sub').textContent = 'Carregando...';
  document.getElementById('comparativo-grid').innerHTML = '';

  try {
    const dados = await apiFetch(`/matriculas/comparativo?modulo=${encodeURIComponent(modulo)}`);
    renderComparativo(dados);
  } catch (err) {
    document.getElementById('rel-comparativo-sub').textContent = 'Erro ao carregar: ' + err.message;
  }
}

function renderComparativo(dados) {
  const linhas = dados.linhas || [];
  ultimoComparativo = dados;
  const sub = document.getElementById('rel-comparativo-sub');
  const grid = document.getElementById('comparativo-grid');

  if (!linhas.length) {
    sub.textContent = 'Nenhum semestre com dados para comparar.';
    grid.innerHTML = '';
    return;
  }
  sub.textContent = `${linhas.length} semestres · módulo ${dados.modulo === 'medicina' ? 'Medicina' : 'Fatec'}`;

  const fmt = (valor, ehPercentual) => {
    if (valor === null || valor === undefined) return '—';
    return ehPercentual ? `${valor.toFixed(1)}%` : String(valor);
  };

  // Um cartão/tabelinha por semestre (pedido pra facilitar a leitura, em vez
  // de uma tabela só larga com 9 colunas precisando rolar pro lado — 22/09).
  grid.innerHTML = linhas.map(l => {
    const marcaHistorico = l.historico ? '<span class="comparativo-hist" title="Dados históricos da planilha">°</span>' : '';
    const corpo = LINHAS_COMPARATIVO
      .filter(def => def.secao || !def.ocultarSeZerado || (l[def.chave] || 0) > 0)
      .map(def => {
        if (def.secao) {
          return `<tr class="linha-secao"><td colspan="2">${esc(def.secao)}</td></tr>`;
        }
        const classes = [def.destaque ? 'linha-destaque' : '', def.separador ? 'linha-separador' : '']
          .filter(Boolean).join(' ');
        const titulo = def.formula ? ` title="${esc(def.formula)}"` : '';
        // Total de alunos / Total de Calouros captados ganham um botão que
        // abre o detalhe de como o número foi somado (pedido 22/09).
        const valorHtml = def.detalhavel
          ? `<button type="button" class="btn-detalhe-total" data-semestre="${esc(l.semestre)}" data-chave="${esc(def.chave)}" title="Ver como chegou nesse número">${fmt(l[def.chave], def.percentual)} <span class="btn-detalhe-total-icone">🔍</span></button>`
          : fmt(l[def.chave], def.percentual);
        return `<tr class="${classes}"><td${titulo}>${esc(def.rotulo)}</td><td${titulo}>${valorHtml}</td></tr>`;
      }).join('');
    return `
      <div class="comparativo-card">
        <h3 class="comparativo-card-titulo">${esc(l.semestre)}${marcaHistorico}</h3>
        <table class="data-table comparativo-card-table">
          <tbody>${corpo}</tbody>
        </table>
      </div>
    `;
  }).join('');

  const temHistorico = linhas.some(l => l.historico);
  document.getElementById('rel-comparativo-nota').textContent = temHistorico
    ? '° Semestre fechado: números vindos da planilha usada antes do Órbita, guardados só como contagem. Não há lista de alunos para abrir nesses semestres.'
    : '';

  grid.querySelectorAll('.btn-detalhe-total').forEach(btn => btn.addEventListener('click', () => {
    abrirDetalheTotal(btn.dataset.semestre, btn.dataset.chave);
  }));
}

// Componentes de cada total detalhável — mesma soma que o backend faz, só
// que reconstruída aqui a partir do `porSituacaoTotal` bruto que a API
// manda, pra não precisar duplicar isso nos dois lados sem necessidade.
const COMPONENTES_TOTAL = {
  // Ativos: situações que contam como ativo no semestre (ver ATIVOS_SITS no topo)
  ativos: ATIVOS_SITS,
  // Total de alunos = a soma de TODAS as situações do semestre, sem exceção.
  total: null,
  // Total de Calouros captados: mesmas situações da fórmula em
  // src/rotas/matriculas.js, com Cancelou trocado pelo componente já
  // separado por período (cancelouCalouro).
  totalCalouros: [
    'Matrícula Nova', 'Matrícula Nova - Assinada',
    'Matrícula Nova - Retorno', 'Matrícula Nova - Retorno Assinada', 'Retorno',
    '1ª Evasão', '2ª Evasão'
  ]
};

// Monta o "como chegou nesse número" (lupa 🔍) com subtotal por grupo, pra
// conferir a soma na tela — usado no Relatório (cards e resumo) e no
// Comparativo. Total = Ativos + Perdas + Mudança de curso; Ativos =
// Veteranos + Calouros. Os grupos são os do topo do arquivo (25/09).
function montarDetalhe(chave, ps, linha) {
  const itens = [];
  const grupo = (titulo, sits, cor, rotuloSubtotal) => {
    const rows = sits.map(s => [s, ps[s] || 0]).filter(([, q]) => q > 0);
    const sub = rows.reduce((a, [, q]) => a + q, 0);
    itens.push({ secao: titulo, tipo: `header-${cor}` });
    if (rows.length) rows.forEach(([nome, qtd]) => itens.push({ nome, qtd, tipo: cor }));
    else itens.push({ nome: '(nenhum)', qtd: 0, tipo: cor });
    itens.push({ nome: rotuloSubtotal, qtd: sub, tipo: cor, subtotal: true });
    return sub;
  };

  if (chave === 'ativos' || chave === 'total') {
    const vet = grupo('Veteranos', VETERANOS_SITS, 'verde', 'Subtotal veteranos');
    const cal = grupo('Calouros', CALOUROS_SITS, 'verde', 'Subtotal calouros');
    if (chave === 'ativos') return itens;
    itens.push({ nome: `= Ativos (${vet} veteranos + ${cal} calouros)`, qtd: vet + cal, tipo: 'verde', subtotal: true });
    grupo('Perdas — saíram da faculdade', PERDAS_SITS, 'vermelho', 'Subtotal perdas');
    if (MUDANCA_CURSO_SITS.some(s => ps[s])) grupo('Mudou de curso — continua na faculdade', MUDANCA_CURSO_SITS, 'neutro', 'Subtotal mudança de curso');
    const conhecidas = new Set([...ATIVOS_SITS, ...PERDAS_SITS, ...MUDANCA_CURSO_SITS]);
    const outros = Object.entries(ps).filter(([s, q]) => !conhecidas.has(s) && q > 0);
    if (outros.length) {
      itens.push({ secao: '⚠ Outros — situação fora dos grupos', tipo: 'header-neutro' });
      outros.forEach(([nome, qtd]) => itens.push({ nome, qtd, tipo: 'neutro' }));
    }
  } else if (chave === 'totalCalouros') {
    COMPONENTES_TOTAL.totalCalouros.forEach(situacao => {
      const qtd = ps[situacao] || 0;
      if (qtd > 0) itens.push([situacao, qtd]);
    });
    if (linha.cancelouCalouro) itens.push(['Cancelou (calouro)', linha.cancelouCalouro]);
    if (linha.desistenteCalouro) itens.push(['Desistente (calouro)', linha.desistenteCalouro]);
  }
  return itens;
}

function abrirDetalheTotal(semestre, chave) {
  const linha = (ultimoComparativo.linhas || []).find(l => l.semestre === semestre);
  if (!linha) return;
  const porSituacaoTotal = linha.porSituacaoTotal || {};

  const linhasDetalhe = montarDetalhe(chave, porSituacaoTotal, linha);

  const def = LINHAS_COMPARATIVO.find(d => d.chave === chave);
  document.getElementById('detalhe-total-titulo').textContent = `${def?.rotulo || chave} — ${semestre}`;
  document.getElementById('detalhe-total-sub').textContent = def?.formula || '';
  // Renderização: suporta tanto array [nome, qtd] quanto objeto {nome, qtd, tipo, secao}
  const totalValor = chave === 'total' ? linha[chave] : (
    chave === 'ativos' ? linha.ativos : linha[chave]
  );
  document.getElementById('detalhe-total-tbody').innerHTML =
    linhasDetalhe.map(item => {
      if (Array.isArray(item)) {
        const [nome, qtd] = item;
        return `<tr><td>${esc(nome)}</td><td>${qtd}</td></tr>`;
      }
      if (item.secao) {
        const cls = item.tipo === 'header-verde' ? 'detalhe-secao-verde'
                  : item.tipo === 'header-vermelho' ? 'detalhe-secao-vermelho'
                  : 'detalhe-secao-neutro';
        return `<tr class="${cls} linha-secao-header"><td colspan="2">${esc(item.secao)}</td></tr>`;
      }
      const cls = (item.tipo === 'verde' ? 'detalhe-row-verde'
                : item.tipo === 'vermelho' ? 'detalhe-row-vermelho'
                : '') + (item.subtotal ? ' linha-subtotal' : '');
      return `<tr class="${cls}"><td>${esc(item.nome)}</td><td>${item.qtd}</td></tr>`;
    }).join('') +
    `<tr class="linha-destaque linha-separador"><td>Total</td><td>${totalValor}</td></tr>`;

  document.getElementById('modal-detalhe-total').classList.remove('hidden');
}

function abrirDetalheRelatorio(chave) {
  const linha = ultimoRelatorioLinha;
  if (!linha) return;
  const porSituacaoTotal = linha.porSituacaoTotal || {};

  const linhasDetalhe = montarDetalhe(chave, porSituacaoTotal, linha);

  const def = LINHAS_COMPARATIVO.find(d => d.chave === chave);
  document.getElementById('detalhe-total-titulo').textContent = `${def?.rotulo || chave} — ${linha.semestre}`;
  document.getElementById('detalhe-total-sub').textContent = def?.formula || '';
  const totalValor = chave === 'total' ? linha.total : (chave === 'ativos' ? linha.ativos : linha[chave]);
  document.getElementById('detalhe-total-tbody').innerHTML =
    linhasDetalhe.map(item => {
      if (Array.isArray(item)) {
        const [nome, qtd] = item;
        return `<tr><td>${esc(nome)}</td><td>${qtd}</td></tr>`;
      }
      if (item.secao) {
        const cls = item.tipo === 'header-verde' ? 'detalhe-secao-verde'
                  : item.tipo === 'header-vermelho' ? 'detalhe-secao-vermelho'
                  : 'detalhe-secao-neutro';
        return `<tr class="${cls} linha-secao-header"><td colspan="2">${esc(item.secao)}</td></tr>`;
      }
      const cls = (item.tipo === 'verde' ? 'detalhe-row-verde'
                : item.tipo === 'vermelho' ? 'detalhe-row-vermelho'
                : '') + (item.subtotal ? ' linha-subtotal' : '');
      return `<tr class="${cls}"><td>${esc(item.nome)}</td><td>${item.qtd}</td></tr>`;
    }).join('') +
    `<tr class="linha-destaque linha-separador"><td>Total</td><td>${totalValor}</td></tr>`;

  document.getElementById('modal-detalhe-total').classList.remove('hidden');
}

function renderRelatorio(dados) {
  const { total, pendentesRevisao, cursos, porCursoSituacao, porSituacaoTotal, porPlano, situacoes, planosConfissao } = dados;

  // Semestre fechado (2023.1–2025.2): veio de `matriculas_historico`, que só
  // tem contagem. Sem esse aviso, alguém vai clicar procurando a lista de
  // alunos do ano e achar que o sistema perdeu os dados.
  const avisoHist = document.getElementById('rel-aviso-historico');
  if (avisoHist) {
    avisoHist.classList.toggle('hidden', !dados.historico);
    if (dados.historico) {
      const origem = dados.arquivoOrigem ? ' Origem: ' + dados.arquivoOrigem + '.' : '';
      document.getElementById('rel-aviso-historico-txt').textContent =
        ' Estes totais vieram da planilha usada antes do Órbita e servem para comparação. ' +
        'Não há detalhamento por aluno para abrir neste semestre.' + origem;
    }
  }

  // Definições do jeito que a coordenação/financeiro já usa (mesmo conceito
  // da planilha antiga): Veterano = rematrícula; Calouro = matrícula nova do
  // semestre; Ativos = quem ainda está no jogo (assinou, tá pendente, não
  // assinou ainda ou é matrícula nova) — 1ª Evasão e Cancelou são coisas
  // diferentes (saiu antes x depois das aulas começarem/1ª mensalidade).
  document.getElementById('kpi-total').textContent = total;
  document.getElementById('kpi-veteranos').textContent = somaSituacoes(porSituacaoTotal, ...VETERANOS_SITS);
  document.getElementById('kpi-calouros').textContent = somaSituacoes(porSituacaoTotal, ...CALOUROS_SITS);
  // "Total de Calouros captados" = todo mundo que entrou pela porta de
  // calouro, independente de ter ficado — mesma conta da planilha antiga
  // (aba Relatório Fatec, célula que soma matrícula nova + assinada + 1ª/2ª
  // evasão + retorno + cancelou). "Retorno" tem 3 grafias possíveis (ver
  // comentário em src/rotas/matriculas.js).
  // Cancelou de calouro (período 1º) vem pronto do servidor; recorte por curso
  // de semestre fechado não tem essa quebra, aí usa o Cancelou bruto.
  const cancelouCalouro = (dados.cancelouCalouro ?? null) !== null ? dados.cancelouCalouro : (porSituacaoTotal['Cancelou'] || 0);
  const totalCalourosCaptados = somaSituacoes(porSituacaoTotal,
    'Matrícula Nova', 'Matrícula Nova - Assinada',
    'Matrícula Nova - Retorno', 'Matrícula Nova - Retorno Assinada', 'Retorno',
    '1ª Evasão', '2ª Evasão') + cancelouCalouro + (dados.desistenteCalouro || 0);
  document.getElementById('kpi-total-calouros').textContent = totalCalourosCaptados;
  document.getElementById('kpi-ativos').textContent = somaSituacoes(porSituacaoTotal, ...ATIVOS_SITS);
  document.getElementById('kpi-pendencia').textContent = porSituacaoTotal['Pendência Financeira'] || 0;
  document.getElementById('kpi-nao-assinou').textContent = porSituacaoTotal['Não Assinou'] || 0;
  document.getElementById('kpi-1-evasao').textContent = porSituacaoTotal['1ª Evasão'] || 0;

  const card2Evasao = document.getElementById('kpi-2-evasao-card');
  if ((porSituacaoTotal['2ª Evasão'] || 0) > 0) {
    card2Evasao.classList.remove('hidden');
    document.getElementById('kpi-2-evasao').textContent = porSituacaoTotal['2ª Evasão'];
  } else {
    card2Evasao.classList.add('hidden');
  }

  // Cancelou e Trancou — breakdown por período (calouro = 1º, veterano = 2º+)
  const cancelouCalouroBd = (dados.cancelouCalouro ?? null) !== null ? dados.cancelouCalouro : (porSituacaoTotal['Cancelou'] || 0);
  const cancelouVeteranoBd = (dados.cancelouVeterano ?? null) !== null ? dados.cancelouVeterano : 0;
  const trancouCalouroBd  = dados.trancouCalouro  || 0;
  const trancouVeteranoBd = dados.trancouVeterano || 0;
  const desistCalouroBd   = dados.desistenteCalouro  || 0;
  const desistVeteranoBd  = dados.desistenteVeterano || 0;
  document.getElementById('kpi-cancelou-calouro').textContent  = cancelouCalouroBd;
  document.getElementById('kpi-cancelou-veterano').textContent = cancelouVeteranoBd;
  document.getElementById('kpi-trancou-calouro').textContent   = trancouCalouroBd;
  document.getElementById('kpi-trancou-veterano').textContent  = trancouVeteranoBd;
  const cardDesistC = document.getElementById('kpi-desistente-calouro-card');
  const cardDesistV = document.getElementById('kpi-desistente-veterano-card');
  if (desistCalouroBd > 0) {
    cardDesistC.classList.remove('hidden');
    document.getElementById('kpi-desistente-calouro').textContent = desistCalouroBd;
  } else { cardDesistC.classList.add('hidden'); }
  if (desistVeteranoBd > 0) {
    cardDesistV.classList.remove('hidden');
    document.getElementById('kpi-desistente-veterano').textContent = desistVeteranoBd;
  } else { cardDesistV.classList.add('hidden'); }

  // "Perda de captação" = (Cancelou de calouro + Desistente de calouro) ÷
  // Total de Calouros captados. Evasões, Trancou e Desistente de veterano NÃO
  // entram no numerador — regra confirmada pela coordenação (25/09). O
  // denominador é todo mundo que entrou como calouro, ficando ou não.
  // "Perda total" continua olhando todo mundo que saiu, de qualquer jeito,
  // sobre o total do semestre — inclui veterano de propósito.
  const perdasCalouros = cancelouCalouro + (dados.desistenteCalouro || 0);
  const totalPerdas = somaSituacoes(porSituacaoTotal, ...PERDAS_SITS);
  const formatarPercentual = (numerador, denominador) =>
    denominador > 0 ? `${((numerador / denominador) * 100).toFixed(1)}%` : '—';
  document.getElementById('kpi-perda-captacao').textContent = formatarPercentual(perdasCalouros, totalCalourosCaptados);
  document.getElementById('kpi-perda-total').textContent = formatarPercentual(totalPerdas, total);

  const cardRevisar = document.getElementById('kpi-revisar-card');
  if (pendentesRevisao > 0) {
    cardRevisar.classList.remove('hidden');
    document.getElementById('kpi-revisar').textContent = pendentesRevisao;
  } else {
    cardRevisar.classList.add('hidden');
  }

  // Pivô Situação x Curso — só lista situação que tem pelo menos 1 aluno em
  // algum curso, senão a tabela fica enorme com linha zerada de ponta a ponta.
  // ---- RESUMO DO SEMESTRE (mesma estrutura dos cards comparativos) ----
  const cancelouCalouroDados = (dados.cancelouCalouro ?? null) !== null ? dados.cancelouCalouro : (porSituacaoTotal['Cancelou'] || 0);
  const cancelouVeteranoDados = (dados.cancelouVeterano ?? null) !== null ? dados.cancelouVeterano : Math.max(0, (porSituacaoTotal['Cancelou'] || 0) - cancelouCalouroDados);
  const trancouCalouroDados = dados.trancouCalouro || 0;
  const trancouVeteranoDados = dados.trancouVeterano || 0;
  {
    const ativosTotal = somaSituacoes(porSituacaoTotal, ...ATIVOS_SITS);
    const totalPerdas2 = somaSituacoes(porSituacaoTotal, ...PERDAS_SITS);
    const totalCalouros2 = somaSituacoes(porSituacaoTotal,
      'Matrícula Nova', 'Matrícula Nova - Assinada',
      'Matrícula Nova - Retorno', 'Matrícula Nova - Retorno Assinada', 'Retorno',
      '1ª Evasão', '2ª Evasão') + cancelouCalouroDados + (dados.desistenteCalouro || 0);
    // % Perda Captação: Cancelou Calouro + Desistente Calouro — evasões e Desistente Veterano NÃO entram
    const perdasCalouros2 = cancelouCalouroDados + (dados.desistenteCalouro || 0);
    const linhaRes = {
      semestre: document.getElementById('rel-semestre-select')?.value || '',
      veteranos: somaSituacoes(porSituacaoTotal, ...VETERANOS_SITS),
      calouros: somaSituacoes(porSituacaoTotal, ...CALOUROS_SITS),
      totalCalouros: totalCalouros2,
      primeiraEvasao: porSituacaoTotal['1ª Evasão'] || 0,
      segundaEvasao: porSituacaoTotal['2ª Evasão'] || 0,
      cancelouCalouro: cancelouCalouroDados,
      cancelouVeterano: cancelouVeteranoDados,
      trancouCalouro: trancouCalouroDados,
      trancouVeterano: trancouVeteranoDados,
      transferencia: porSituacaoTotal['Transferência'] || 0,
      desistente: (dados.desistenteCalouro || 0) + (dados.desistenteVeterano || 0),
      desistenteCalouro: dados.desistenteCalouro || 0,
      desistenteVeterano: dados.desistenteVeterano || 0,
      mudancaDeCurso: porSituacaoTotal['Mudança de Curso'] || 0,
      perdas: totalPerdas2,
      pendenciaFinanceira: porSituacaoTotal['Pendência Financeira'] || 0,
      naoAssinou: porSituacaoTotal['Não Assinou'] || 0,
      ativos: ativosTotal,
      total,
      perdaCaptacao: totalCalouros2 > 0 ? (perdasCalouros2 / totalCalouros2) * 100 : null,
      perdaTotal: total > 0 ? (totalPerdas2 / total) * 100 : null,
      porSituacaoTotal,
    };
    ultimoRelatorioLinha = linhaRes;

    const fmt = (v, pct) => {
      if (pct) return v == null ? '—' : `${v.toFixed(1)}%`;
      return v == null ? '—' : String(v);
    };
    const resumoTbody = document.getElementById('resumo-semestre-tbody');
    if (resumoTbody) {
      // mapa secao → classe CSS
      const SECAO_CLASSE = {
        'O que somou (captação)': 'soma',
        'O que diminuiu (perdas)': 'perda',
        'Total geral': 'geral',
      };
      let secaoAtual = 'soma';
      resumoTbody.innerHTML = LINHAS_COMPARATIVO.map(def => {
        if (def.secao) {
          secaoAtual = SECAO_CLASSE[def.secao] || 'geral';
          return `<tr class="linha-secao linha-secao-${secaoAtual}"><td colspan="2">${esc(def.secao)}</td></tr>`;
        }
        const val = linhaRes[def.chave];
        if (def.ocultarSeZerado && !val) return '';
        // classe de cor da linha
        let corClasse = `secao-${secaoAtual}`;
        if (def.chave === 'ativos') corClasse = 'secao-geral-ativos';
        if (def.percentual) corClasse = 'secao-geral-pct';
        const classes = ['linha-comparativo', def.destaque ? 'linha-destaque' : '', corClasse].filter(Boolean).join(' ');
        const titulo = def.formula ? ` title="${esc(def.formula)}"` : '';
        const valorHtml = def.detalhavel
          ? `<button type="button" class="btn-detalhe-total" data-relatorio-chave="${esc(def.chave)}" title="Ver como chegou nesse número">${fmt(val, def.percentual)} <span class="btn-detalhe-total-icone">🔍</span></button>`
          : fmt(val, def.percentual);
        return `<tr class="${classes}"><td${titulo}>${esc(def.rotulo)}</td><td${titulo}>${valorHtml}</td></tr>`;
      }).join('');
    }
  }
  // ---- fim resumo ----

  // ---- RANKING POR CURSO (decrescente por total) ----
  {
    // Veteranos + Calouros = Ativos; Ativos + Perdas = Total (por curso e na
    // linha TOTAL, que bate com os cards). Antes "Veteranos" era Total −
    // Calouros captados, que jogava trancou/cancelou/desistente de veterano
    // pra dentro de veterano (Psicologia 2026.2 mostrava 221 veteranos, eram
    // 215 + 6 trancados) (25/09).
    const cancelouCalouroPorCurso = dados.cancelouCalouroPorCurso || {};
    const desistenteCalouroPorCurso = dados.desistenteCalouroPorCurso || {};
    // Semestre fechado não guarda Cancelou por período por curso — usa o
    // Cancelou bruto do curso (a planilha chamava essa linha de "cancelamento
    // de CALOURO").
    const semQuebraPorCurso = !!dados.historico && !Object.keys(cancelouCalouroPorCurso).length;
    const CALOUROS_CAPTADOS_SITS = [
      'Matrícula Nova', 'Matrícula Nova - Assinada',
      'Matrícula Nova - Retorno', 'Matrícula Nova - Retorno Assinada', 'Retorno',
      '1ª Evasão', '2ª Evasão'
    ];

    const somaCurso = (sitMap, ...sits) => sits.reduce((acc, s) => acc + (sitMap[s] || 0), 0);

    const cursoRows = (dados.cursos || []).map(curso => {
      const sitMap = (dados.porCursoSituacao || {})[curso] || {};
      const totalCurso = Object.values(sitMap).reduce((a, b) => a + b, 0);
      const cancelouCalouroC = semQuebraPorCurso ? (sitMap['Cancelou'] || 0) : (cancelouCalouroPorCurso[curso] || 0);
      const desistenteCalouroC = semQuebraPorCurso ? 0 : (desistenteCalouroPorCurso[curso] || 0);
      const calourosCapCurso = somaCurso(sitMap, ...CALOUROS_CAPTADOS_SITS) + cancelouCalouroC + desistenteCalouroC;
      const veteranosCurso = somaCurso(sitMap, ...VETERANOS_SITS);
      const calourosCurso = somaCurso(sitMap, ...CALOUROS_SITS);
      const ativosCurso = veteranosCurso + calourosCurso;
      const perdasCurso = somaCurso(sitMap, ...PERDAS_SITS);
      const mudancaCurso = somaCurso(sitMap, ...MUDANCA_CURSO_SITS);
      const outrosCurso = totalCurso - ativosCurso - perdasCurso - mudancaCurso; // situação fora dos grupos — deveria ser 0
      if (outrosCurso) console.warn('[Relatório] situação sem grupo em', curso, sitMap);
      return { curso, totalCurso, veteranosCurso, calourosCurso, ativosCurso, perdasCurso, mudancaCurso, calourosCapCurso, outrosCurso };
    }).sort((a, b) => b.totalCurso - a.totalCurso);

    const somaCol = (k) => cursoRows.reduce((acc, r) => acc + r[k], 0);

    const rankingTbody = document.getElementById('ranking-curso-tbody');
    if (rankingTbody) {
      if (!cursoRows.length) {
        rankingTbody.innerHTML = '<tr><td colspan="8" class="tabela-msg">Nenhum aluno lançado para esse semestre ainda.</td></tr>';
      } else {
        const linhaCurso = (r, i) => `
          <tr class="ranking-curso-row${i === 0 ? ' ranking-primeiro' : ''}">
            <td class="ranking-curso-nome">${esc(r.curso)}</td>
            <td class="ranking-num ranking-num-total">${r.totalCurso}</td>
            <td class="ranking-num">${r.veteranosCurso}</td>
            <td class="ranking-num">${r.calourosCurso}</td>
            <td class="ranking-num ranking-num-ativos">${r.ativosCurso}</td>
            <td class="ranking-num">${r.perdasCurso}</td>
            <td class="ranking-num">${r.mudancaCurso}</td>
            <td class="ranking-num ranking-num-captados">${r.calourosCapCurso}</td>
          </tr>`;
        const outros = somaCol('outrosCurso');
        rankingTbody.innerHTML = cursoRows.map(linhaCurso).join('') + `
          <tr class="ranking-curso-row ranking-total">
            <td class="ranking-curso-nome"><strong>TOTAL</strong></td>
            <td class="ranking-num ranking-num-total"><strong>${somaCol('totalCurso')}</strong></td>
            <td class="ranking-num"><strong>${somaCol('veteranosCurso')}</strong></td>
            <td class="ranking-num"><strong>${somaCol('calourosCurso')}</strong></td>
            <td class="ranking-num ranking-num-ativos"><strong>${somaCol('ativosCurso')}</strong></td>
            <td class="ranking-num"><strong>${somaCol('perdasCurso')}</strong></td>
            <td class="ranking-num"><strong>${somaCol('mudancaCurso')}</strong></td>
            <td class="ranking-num ranking-num-captados"><strong>${somaCol('calourosCapCurso')}</strong></td>
          </tr>` + (outros ? `
          <tr><td colspan="8" class="tabela-msg">⚠ ${outros} aluno(s) com situação fora de Ativos/Perdas/Mudança de curso — a conta não fecha com o Total.</td></tr>` : '');
      }
    }
  }
  // ---- fim ranking ----

    const thead = document.getElementById('situacao-curso-thead');
  const tbody = document.getElementById('situacao-curso-tbody');
  if (!cursos.length) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td class="tabela-msg">Nenhum aluno lançado para esse módulo/semestre ainda.</td></tr>';
  } else {
    thead.innerHTML = `<tr><th>Situação</th>${cursos.map(c => `<th>${esc(c)}</th>`).join('')}<th>Total</th></tr>`;
    tbody.innerHTML = situacoes
      .filter(sit => (porSituacaoTotal[sit] || 0) > 0)
      .map(sit => {
        const linhaTotal = porSituacaoTotal[sit] || 0;
        return `<tr>
          <td><span class="status-badge ${situacaoBadgeClasse(sit)}">${esc(sit)}</span></td>
          ${cursos.map(c => `<td>${(porCursoSituacao[c] && porCursoSituacao[c][sit]) || 0}</td>`).join('')}
          <td><strong>${linhaTotal}</strong></td>
        </tr>`;
      }).join('') || '<tr><td class="tabela-msg">Nenhum aluno lançado para esse módulo/semestre ainda.</td></tr>';
  }

  const planoTbody = document.getElementById('plano-tbody');
  planoTbody.innerHTML = planosConfissao
    .filter(p => (porPlano[p] || 0) > 0)
    .map(p => `<tr><td>${esc(p)}</td><td>${porPlano[p] || 0}</td></tr>`)
    .join('') || '<tr><td colspan="2" class="tabela-msg">Nenhum aluno lançado para esse módulo/semestre ainda.</td></tr>';
}

// ==========================================
// ALUNO INDICA (aluno-indica.html) — ranking de quem já indicou calouro,
// quantos e quem. Mesmo padrão de módulo/semestre/curso da tela de relatório.
// ==========================================
let indicaEmAndamento = Promise.resolve();

async function initPaginaAlunoIndica() {
  const selectModulo = document.getElementById('indica-modulo-select');
  const selectSemestre = document.getElementById('indica-semestre-select');
  const selectCurso = document.getElementById('indica-curso-select');

  await carregarCursosFatec();
  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosFatec.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  await popularSelectSemestres(selectSemestre);
  atualizarVisibilidadeCursoIndica();
  atualizarLabelImpressaoIndica();

  selectModulo?.addEventListener('change', () => {
    if (selectCurso) selectCurso.value = '';
    atualizarVisibilidadeCursoIndica();
    atualizarLabelImpressaoIndica();
    indicaEmAndamento = carregarAlunoIndica();
  });
  selectSemestre?.addEventListener('change', () => {
    atualizarLabelImpressaoIndica();
    indicaEmAndamento = carregarAlunoIndica();
  });
  selectCurso?.addEventListener('change', () => {
    atualizarLabelImpressaoIndica();
    indicaEmAndamento = carregarAlunoIndica();
  });

  const dataEmissao = document.getElementById('print-data-emissao');
  if (dataEmissao) dataEmissao.textContent = 'Emitido em ' + new Date().toLocaleString('pt-BR');

  document.getElementById('btn-imprimir-indica')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const textoOriginal = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Preparando...';
    try {
      await indicaEmAndamento;
    } finally {
      btn.disabled = false;
      btn.innerHTML = textoOriginal;
    }
    window.print();
  });

  indicaEmAndamento = carregarAlunoIndica();
  await indicaEmAndamento;
}

function atualizarVisibilidadeCursoIndica() {
  const isFatec = document.getElementById('indica-modulo-select')?.value !== 'medicina';
  document.getElementById('indica-curso-select')?.classList.toggle('hidden', !isFatec);
}

function atualizarLabelImpressaoIndica() {
  const label = document.getElementById('print-filtro-label-indica');
  if (!label) return;
  const moduloValor = document.getElementById('indica-modulo-select')?.value;
  const modulo = moduloValor === 'medicina' ? 'Medicina' : 'Fatec';
  const semestre = document.getElementById('indica-semestre-select')?.value || '';
  const partes = [modulo];
  if (moduloValor !== 'medicina') {
    const cursoSelect = document.getElementById('indica-curso-select');
    const cursoNome = cursoSelect?.value ? cursoSelect.selectedOptions[0]?.textContent : 'Todos os cursos';
    partes.push(cursoNome);
  }
  partes.push(semestre);
  label.textContent = partes.filter(Boolean).join(' — ');
}

async function carregarAlunoIndica() {
  const modulo = document.getElementById('indica-modulo-select')?.value || 'fatec';
  const semestre = document.getElementById('indica-semestre-select')?.value || '2026.2';
  const cursoId = document.getElementById('indica-curso-select')?.value;
  const tbody = document.getElementById('indica-tbody');
  tbody.innerHTML = '<tr><td colspan="3" class="tabela-msg">Carregando...</td></tr>';
  try {
    const params = new URLSearchParams({ modulo, semestre });
    if (cursoId) params.set('cursoId', cursoId);
    const { totalIndicacoes, veteranosQueIndicaram, veteranos } = await apiFetch(`/matriculas/aluno-indica?${params.toString()}`);
    document.getElementById('indica-kpi-veteranos').textContent = veteranosQueIndicaram;
    document.getElementById('indica-kpi-total').textContent = totalIndicacoes;

    if (!veteranos.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="tabela-msg">Ninguém indicou calouro nesse módulo/semestre ainda.</td></tr>';
      return;
    }
    tbody.innerHTML = veteranos.map(v => `
      <tr>
        <td>${esc(v.veteranoNome)}</td>
        <td>${v.quantidade}</td>
        <td>${v.indicados.map(i => `${esc(i.nome)} (${esc(i.curso)})`).join(', ')}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="tabela-msg">Erro: ${esc(err.message)}</td></tr>`;
  }
}

// ==========================================
// TELA VIRAR SEMESTRE (virar-semestre.html)
// ==========================================
// Quem vai pro próximo semestre é escolha manual, linha a linha — não existe
// regra automática por situação aqui. O período (+1) e a situação nova
// ("Não Assinou") são só sugestão editável antes de confirmar.
let vsAlunos = [];

function vsAvancarPeriodo(periodoOriginal) {
  const m = (periodoOriginal || '').trim().match(/^(\d+)º$/);
  if (!m) return periodoOriginal || '';
  return `${parseInt(m[1], 10) + 1}º`;
}

async function initPaginaVirarSemestre() {
  await Promise.all([carregarOpcoes(), carregarCursosFatec()]);

  const selectCurso = document.getElementById('vs-curso-filtro');
  if (selectCurso) {
    selectCurso.innerHTML = '<option value="">Todos os cursos</option>' +
      cursosFatec.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  }
  const periodoFiltro = document.getElementById('vs-periodo-filtro');
  if (periodoFiltro) {
    const periodos = [...Array.from({ length: 12 }, (_, i) => `${i + 1}º`), 'DP'];
    periodoFiltro.innerHTML = '<option value="">Todos os períodos</option>' +
      periodos.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  }
  const situacaoFiltro = document.getElementById('vs-situacao-filtro');
  if (situacaoFiltro) {
    situacaoFiltro.innerHTML = '<option value="">Todas as situações</option>' +
      opcoes.situacoes.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  }

  await popularSelectSemestres(document.getElementById('vs-origem-select'));
  vsAtualizarVisibilidadeCurso();

  document.getElementById('vs-modulo-select')?.addEventListener('change', () => {
    vsAtualizarVisibilidadeCurso();
    vsResetarCarregamento();
  });
  document.getElementById('vs-origem-select')?.addEventListener('change', vsResetarCarregamento);

  document.getElementById('btn-vs-carregar')?.addEventListener('click', vsCarregarAlunos);

  ['vs-curso-filtro', 'vs-periodo-filtro', 'vs-situacao-filtro'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', vsRenderTabela);
  });
  document.getElementById('vs-busca')?.addEventListener('input', vsRenderTabela);

  document.getElementById('btn-vs-marcar-filtrados')?.addEventListener('click', () => vsMarcarFiltrados(true));
  document.getElementById('btn-vs-desmarcar-filtrados')?.addEventListener('click', () => vsMarcarFiltrados(false));
  document.getElementById('vs-check-todos-cabecalho')?.addEventListener('change', (e) => vsMarcarFiltrados(e.target.checked));
  document.getElementById('btn-vs-limpar-selecao')?.addEventListener('click', () => {
    vsAlunos.forEach(a => { a._selecionado = false; });
    vsRenderTabela();
  });

  document.getElementById('vs-destino-input')?.addEventListener('input', vsAtualizarContadorEBotao);
  document.getElementById('btn-vs-confirmar')?.addEventListener('click', vsConfirmar);
}

function vsAtualizarVisibilidadeCurso() {
  const isFatec = document.getElementById('vs-modulo-select')?.value !== 'medicina';
  document.getElementById('vs-curso-filtro')?.classList.toggle('hidden', !isFatec);
}

function vsResetarCarregamento() {
  vsAlunos = [];
  document.getElementById('vs-area-selecao')?.classList.add('hidden');
  document.getElementById('vs-barra-confirmar')?.classList.add('hidden');
}

async function vsCarregarAlunos() {
  const modulo = document.getElementById('vs-modulo-select')?.value;
  const semestre = document.getElementById('vs-origem-select')?.value;
  if (!modulo || !semestre) return;

  const btn = document.getElementById('btn-vs-carregar');
  btn.disabled = true;
  btn.textContent = 'Carregando...';
  try {
    const carregados = [];
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const params = new URLSearchParams({ modulo, semestre, pageSize: '200' });
      if (cursor) { params.set('cursorNome', cursor.nome); params.set('cursorId', cursor.id); }
      const resp = await apiFetch(`/matriculas/alunos?${params.toString()}`);
      carregados.push(...resp.alunos);
      hasMore = resp.hasMore;
      cursor = resp.nextCursor;
    }
    vsAlunos = carregados.map(a => ({
      ...a,
      _selecionado: false,
      _periodoNovo: vsAvancarPeriodo(a.periodo),
      _situacaoNova: 'Não Assinou'
    }));
    document.getElementById('vs-area-selecao')?.classList.remove('hidden');
    document.getElementById('vs-barra-confirmar')?.classList.remove('hidden');
    document.getElementById('vs-busca').value = '';
    vsRenderTabela();
  } catch (err) {
    showToast('Erro ao carregar alunos: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Carregar alunos';
  }
}

function vsAlunosFiltrados() {
  const curso = document.getElementById('vs-curso-filtro')?.value;
  const periodo = document.getElementById('vs-periodo-filtro')?.value;
  const situacao = document.getElementById('vs-situacao-filtro')?.value;
  const termo = document.getElementById('vs-busca')?.value.trim().toLowerCase();
  return vsAlunos.filter(a =>
    (!curso || a.curso === curso) &&
    (!periodo || a.periodo === periodo) &&
    (!situacao || a.situacao === situacao) &&
    (!termo || a.nome.toLowerCase().includes(termo))
  );
}

function vsSituacaoOptionsHtml(selecionada) {
  return opcoes.situacoes.map(s => `<option value="${esc(s)}" ${s === selecionada ? 'selected' : ''}>${esc(s)}</option>`).join('');
}

function vsRenderTabela() {
  const tbody = document.getElementById('vs-tbody');
  const filtrados = vsAlunosFiltrados();

  if (!vsAlunos.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Escolha módulo e semestre de origem e clique em "Carregar alunos".</td></tr>';
  } else if (!filtrados.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="tabela-msg">Nenhum aluno encontrado para os filtros atuais.</td></tr>';
  } else {
    tbody.innerHTML = filtrados.map(a => `
      <tr>
        <td><input type="checkbox" data-vs-check="${a.id}" ${a._selecionado ? 'checked' : ''}></td>
        <td>${esc(a.nome)}</td>
        <td>${esc(a.curso)}</td>
        <td>${esc(a.periodo)}</td>
        <td><input type="text" data-vs-periodo="${a.id}" value="${esc(a._periodoNovo)}" style="width: 4.5rem; padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px;"></td>
        <td><span class="status-badge ${situacaoBadgeClasse(a.situacao)}">${esc(a.situacao)}</span></td>
        <td><select data-vs-situacao="${a.id}" style="padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: 6px;">${vsSituacaoOptionsHtml(a._situacaoNova)}</select></td>
      </tr>`).join('');
  }

  tbody.querySelectorAll('[data-vs-check]').forEach(el => el.addEventListener('change', (e) => {
    const aluno = vsAlunos.find(a => a.id === el.dataset.vsCheck);
    if (aluno) aluno._selecionado = e.target.checked;
    vsAtualizarContadorEBotao();
  }));
  tbody.querySelectorAll('[data-vs-periodo]').forEach(el => el.addEventListener('input', (e) => {
    const aluno = vsAlunos.find(a => a.id === el.dataset.vsPeriodo);
    if (aluno) aluno._periodoNovo = e.target.value;
  }));
  tbody.querySelectorAll('[data-vs-situacao]').forEach(el => el.addEventListener('change', (e) => {
    const aluno = vsAlunos.find(a => a.id === el.dataset.vsSituacao);
    if (aluno) aluno._situacaoNova = e.target.value;
  }));

  vsAtualizarContadorEBotao();
}

function vsMarcarFiltrados(valor) {
  vsAlunosFiltrados().forEach(a => { a._selecionado = valor; });
  vsRenderTabela();
}

function vsAtualizarContadorEBotao() {
  const selecionados = vsAlunos.filter(a => a._selecionado).length;
  document.getElementById('vs-contador-selecionados').textContent = `${selecionados} aluno${selecionados === 1 ? '' : 's'} selecionado${selecionados === 1 ? '' : 's'}`;

  const destino = document.getElementById('vs-destino-input')?.value.trim();
  const origem = document.getElementById('vs-origem-select')?.value;
  const destinoValido = /^\d{4}\.\d$/.test(destino || '') && destino !== origem;
  document.getElementById('btn-vs-confirmar').disabled = !(selecionados > 0 && destinoValido);
}

async function vsConfirmar() {
  const semestreOrigem = document.getElementById('vs-origem-select')?.value;
  const semestreDestino = document.getElementById('vs-destino-input')?.value.trim();
  const selecionados = vsAlunos.filter(a => a._selecionado);
  if (!selecionados.length) return;

  if (!confirm(`Copiar ${selecionados.length} aluno(s) de ${semestreOrigem} para ${semestreDestino}?\n\nOs registros de ${semestreOrigem} não serão alterados nem apagados.`)) return;

  const btn = document.getElementById('btn-vs-confirmar');
  btn.disabled = true;
  btn.textContent = 'Gravando...';
  try {
    const overrides = {};
    selecionados.forEach(a => { overrides[a.id] = { periodo: a._periodoNovo, situacao: a._situacaoNova }; });

    const resp = await apiFetch('/matriculas/virar-semestre', {
      method: 'POST',
      body: JSON.stringify({
        semestreOrigem,
        semestreDestino,
        alunoIds: selecionados.map(a => a.id),
        overrides
      })
    });

    showToast(`${resp.copiados} aluno(s) copiado(s) para ${semestreDestino}.`);
    if (resp.avisosPeriodo?.length) {
      showToast(`${resp.avisosPeriodo.length} aluno(s) com período fora do padrão "Nº" — confira manualmente.`, 'error');
    }

    vsResetarCarregamento();
    document.getElementById('vs-destino-input').value = '';
    await popularSelectSemestres(document.getElementById('vs-origem-select'));
  } catch (err) {
    showToast('Erro ao virar semestre: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar virada de semestre';
    vsAtualizarContadorEBotao();
  }
}
