// ================================================================
//  ÓRBITA — MÓDULO BANCO MED-FATEC
//  Banco de questões clínicas (Medicina) + exportação Moodle XML
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../core/layout.js";
import { escapeHTML as esc, sanitizeHTML } from "../core/security.js";
import { getEffectiveLevel } from "../core/permissions.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

let currentUser = null;
let currentRole = null;
// Só coordenação/ADM veem quem elaborou cada questão — pedido explícito
// (14/09): professor ver o que outro professor cadastrou é antiético, ele só
// pode ver o que ele mesmo lançou e o que tem disponível no banco (sem saber
// de quem é). Espelha podeVerAutoria() do backend (src/rotas/banco-med-fatec.js).
function podeVerAutoria() {
  return currentRole === 'adm_l1' || currentRole === 'coord_medicina';
}

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
    let msg = `Erro na API: ${res.status}`;
    try { const body = await res.json(); if (body.error) msg = body.error; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

// Download de arquivo (usado na exportação do XML) — precisa do token
// no header, então não dá pra ser um <a href> simples.
async function apiDownload(endpoint) {
  let token = '';
  if (currentUser && typeof currentUser.getIdToken === 'function') {
    token = await currentUser.getIdToken();
  }
  const res = await fetch(`${API_BASE}${endpoint}`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) {
    let msg = `Erro ao exportar: ${res.status}`;
    try { const body = await res.json(); if (body.error) msg = body.error; } catch (e) {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const nomeArquivo = match ? match[1] : 'prova.xml';

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nomeArquivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---- Compressão de imagem no navegador (mesmo padrão do módulo Ferida) ----
const LIMITE_BASE64 = 950000;

// Núcleo comum: recebe a imagem já como data URL e comprime em cascata até
// caber no limite de 1 MiB do documento do Firestore.
function comprimirDataUrl(dataUrl) {
  const tentativas = [
    { dim: 1600, q: 0.85 },
    { dim: 1400, q: 0.72 },
    { dim: 1200, q: 0.62 },
    { dim: 1000, q: 0.52 },
    { dim: 800, q: 0.45 }
  ];
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Já cabe sem precisar reprocessar (ex.: imagem pequena vinda do Moodle)
      if (dataUrl.length <= LIMITE_BASE64 && /^data:image\/jpeg/.test(dataUrl)) return resolve(dataUrl);
      for (const t of tentativas) {
        const scale = Math.min(1, t.dim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL('image/jpeg', t.q);
        if (out.length <= LIMITE_BASE64) return resolve(out);
      }
      reject(new Error('Imagem grande demais mesmo após compressão.'));
    };
    img.onerror = () => reject(new Error('Não foi possível carregar a imagem.'));
    img.src = dataUrl;
  });
}

// Upload manual (input type=file) — lê o arquivo e delega a compressão.
function comprimirImagem(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => comprimirDataUrl(reader.result).then(resolve, reject);
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

// ---- Estado local ----
// Nunca carregamos o banco inteiro de uma vez — cada pedaço é buscado sob
// demanda, filtrado no servidor, e só o necessário pra tela atual fica em
// memória (economia de leitura no Firestore: o banco cresce bastante com
// as importações do AVA).
let categorias = [];
let professores = []; // [{uid, nome}] — quem tem login no banco (professor_medicina + coord_medicina), pro filtro "ver questões de um professor"
let questoesBanco = [];      // questões "publicada" do período escolhido no filtro do Banco de Questões
let questoesRevisao = [];    // questões status=revisao_importacao (fila de revisão — sempre carregada, é pequena)
let questoesProvaAtual = []; // questões da disciplina da prova aberta em "Montar Prova" (carregado ao abrir o modal)
let provas = [];
let imagemAtual = null; // { nome, dataUrl } | null
let provaEmEdicao = null; // prova sendo montada no modal

// As 7 áreas de formação do ENAMED — espelha AREAS_ENAMED do backend
// (src/rotas/banco-med-fatec.js). Cruza disciplina/período de propósito:
// é assim que a matriz do ENAMED organiza a prova.
const AREAS_ENAMED = [
  'Clínica Médica',
  'Cirurgia',
  'Pediatria',
  'Ginecologia e Obstetrícia',
  'Saúde Mental',
  'Medicina de Família e Comunidade',
  'Medicina Preventiva e Social'
];

const DIFICULDADE_LABEL = { facil: 'Fácil', media: 'Média', intermediaria: 'Intermediária', dificil: 'Difícil' };
const TIPO_LABEL = {
  multichoice_unica: 'Múltipla escolha (uma correta)',
  multichoice_multipla: 'Múltipla escolha (várias corretas)',
  verdadeiro_falso: 'Verdadeiro/Falso'
};

// Ícones SVG inline (nunca emoji/glifo unicode como substituto de ícone).
const ICONS = {
  editar: '<svg class="bmf-icon" viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 0 1 4 4L7 21l-4 1 1-4Z"/></svg>',
  excluir: '<svg class="bmf-icon" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  imagem: '<svg class="bmf-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  montar: '<svg class="bmf-icon" viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  sucesso: '<svg class="bmf-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
  alerta: '<svg class="bmf-icon" viewBox="0 0 24 24"><path d="M12 3l10 18H2Z"/><line x1="12" y1="9" x2="12" y2="14"/><line x1="12" y1="17.2" x2="12" y2="17.2"/></svg>'
};

function nomeCategoria(id) {
  const c = categorias.find(c => c.id === id);
  if (!c) return '—';
  return `${c.periodo}º Período · ${c.nome}${c.nomeBreve ? ` (${c.nomeBreve})` : ''}`;
}

// ================================================================
//  CARREGAMENTO DE DADOS
// ================================================================
async function carregarQuestoesRevisao() {
  questoesRevisao = await apiFetch('/banco-med-fatec/questoes?status=revisao_importacao');
}

async function carregarProfessores() {
  professores = await apiFetch('/banco-med-fatec/professores');
}

// Mostra quantas questões publicadas o banco tem em cada dificuldade, direto
// nas opções do filtro (ex.: "Fácil (23)") — usa count() agregado no
// servidor, não lê os documentos, então não pesa na economia do banco.
// Mesmas cores usadas nos cards de referência da aba "Questões ENAMED".
const AREA_COR = {
  'Clínica Médica': '#2F6FA8',
  'Cirurgia': '#A2543B',
  'Pediatria': '#4B8F63',
  'Ginecologia e Obstetrícia': '#9A4F76',
  'Saúde Mental': '#6E63A6',
  'Medicina de Família e Comunidade': '#B98A2E',
  'Medicina Preventiva e Social': '#3F8686'
};

// Contagem real de questões publicadas por área ENAMED — mostra o quanto o
// banco já tem de conteúdo em cada área, não só a referência estática de
// disciplina→área.
async function carregarContagemAreaEnamed() {
  const grid = document.getElementById('bmf-area-contagem-grid');
  grid.innerHTML = '<p class="bmf-empty">Carregando…</p>';
  try {
    const contagem = await apiFetch('/banco-med-fatec/questoes/contagem-area-enamed');
    grid.innerHTML = AREAS_ENAMED.map(area => `
      <div class="bmf-area-contagem-card" style="--area-cor:${AREA_COR[area]};">
        <div class="bmf-area-contagem-numero">${contagem[area] || 0}</div>
        <div class="bmf-area-contagem-nome">${esc(area)}</div>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = '<p class="bmf-empty">Não deu pra carregar a contagem agora.</p>';
    console.error(err);
  }
}

async function atualizarContagemDificuldade() {
  try {
    const contagem = await apiFetch('/banco-med-fatec/questoes/contagem-dificuldade');
    document.querySelectorAll('#bmf-filtro-dificuldade option[value]:not([value=""])').forEach(opt => {
      const label = DIFICULDADE_LABEL[opt.value] || opt.value;
      opt.textContent = `${label} (${contagem[opt.value] || 0})`;
    });
  } catch (err) {
    console.error(err);
  }
}

// Lê os filtros de período, área ENAMED e dificuldade (os três pedem ao
// servidor — só a disciplina refina em memória) e busca se pelo menos um
// deles estiver escolhido. Área ENAMED cruza disciplinas e períodos de
// propósito (é assim que o ENAMED organiza a prova), dificuldade sozinha
// também cruza tudo (ex.: "ver todas as fáceis do banco"), e busca por
// título funciona sozinha via busca por prefixo (tituloBusca) — nenhum dos
// quatro depende do período estar selecionado.
async function carregarQuestoesBanco() {
  const periodo = document.getElementById('bmf-filtro-periodo').value;
  const area = document.getElementById('bmf-filtro-area-enamed').value;
  const dificuldade = document.getElementById('bmf-filtro-dificuldade').value;
  const professorSel = document.getElementById('bmf-filtro-professor').value;
  const busca = document.getElementById('bmf-filtro-busca').value.trim();
  if (!periodo && !area && !dificuldade && !professorSel && busca.length < 2) { questoesBanco = []; return; }

  const params = new URLSearchParams({ status: 'publicada' });
  if (periodo) params.set('periodo', periodo);
  if (area) params.set('areaEnamed', area);
  if (dificuldade) params.set('dificuldade', dificuldade);
  if (professorSel) params.set('criadoPor', professorSel === 'me' ? currentUser.uid : professorSel);
  if (busca.length >= 2) params.set('busca', busca);
  questoesBanco = await apiFetch(`/banco-med-fatec/questoes?${params.toString()}`);
}

// Recarrega a lista e re-renderiza, sempre deixando algum retorno visível —
// zero resultado ("nenhuma questão com esses filtros") ou erro de verdade
// (sessão expirada, falha de rede) nunca ficam em branco sem explicação.
async function atualizarListaQuestoes() {
  const grid = document.getElementById('bmf-questoes-grid');
  const vazio = document.getElementById('bmf-questoes-vazio');
  grid.innerHTML = '';
  vazio.classList.add('hidden');
  grid.innerHTML = '<p class="bmf-empty">Carregando…</p>';
  try {
    await carregarQuestoesBanco();
    renderQuestoes();
  } catch (err) {
    console.error(err);
    grid.innerHTML = '';
    vazio.textContent = `Não deu pra carregar as questões agora (${err.message}). Tenta recarregar a página — se a sessão expirou, um novo login resolve.`;
    vazio.classList.remove('hidden');
  }
}

async function carregarQuestoesDaCategoria(categoriaId) {
  questoesProvaAtual = await apiFetch(`/banco-med-fatec/questoes?categoriaId=${encodeURIComponent(categoriaId)}&status=publicada`);
}

// Simulado ENAMED: puxa questões de qualquer disciplina/período que tenham
// essa área marcada — mesma ideia do carregarQuestoesDaCategoria acima, só
// que filtrando pela área em vez da disciplina.
async function carregarQuestoesDaArea(areaEnamed) {
  questoesProvaAtual = await apiFetch(`/banco-med-fatec/questoes?areaEnamed=${encodeURIComponent(areaEnamed)}&status=publicada`);
}

// Recarrega categorias/provas/fila-de-revisão (sempre leves) e, só se já
// houver um período escolhido no filtro, as questões daquele período — nunca
// o banco inteiro.
async function carregarTudo() {
  try {
    [categorias, provas] = await Promise.all([
      apiFetch('/banco-med-fatec/categorias'),
      apiFetch('/banco-med-fatec/provas')
    ]);
    await carregarQuestoesRevisao();
    popularSelectsCategoria();
    atualizarContagemDificuldade();

    // Lista de colegas por nome só existe pra quem pode ver autoria — pro
    // professor comum o select fica só com "Todos"/"Minhas questões" (o
    // endpoint /professores nem responde pra ele, ver podeVerAutoria no
    // backend), então nem faz sentido chamar.
    if (podeVerAutoria()) await carregarProfessores();
    popularSelectFiltroProfessor();

    await carregarQuestoesBanco();

    renderQuestoes();
    renderProvas();
    renderRevisao();
  } catch (err) {
    console.error(err);
  }
}

function ordinal(n) { return `${n}º`; }

// Popula os selects de "Período" (1º a 12º, grade da Medicina) usados no
// filtro do banco e nos formulários de questão/prova/nova disciplina.
function popularSelectsPeriodo() {
  const ids = ['bmf-filtro-periodo', 'bmf-q-periodo', 'bmf-p-periodo', 'bmf-q-categoria-nova-periodo', 'bmf-prova-filtro-periodo'];
  ids.map(id => document.getElementById(id)).forEach(sel => {
    if (!sel || sel.dataset.montado) return;
    for (let p = 1; p <= 12; p++) {
      const opt = document.createElement('option');
      opt.value = String(p);
      opt.textContent = sel.id === 'bmf-q-categoria-nova-periodo' ? `${ordinal(p)} Per.` : `${ordinal(p)} Período`;
      sel.appendChild(opt);
    }
    sel.dataset.montado = '1';
  });
}

// Popula os selects de "Área ENAMED" (filtro do banco, form de questão e
// form de nova prova) — mesma lista fixa nos três, igual período.
function popularSelectsAreaEnamed() {
  const ids = ['bmf-filtro-area-enamed', 'bmf-q-area-enamed', 'bmf-p-area-enamed'];
  ids.map(id => document.getElementById(id)).forEach(sel => {
    if (!sel || sel.dataset.montado) return;
    AREAS_ENAMED.forEach(area => {
      const opt = document.createElement('option');
      opt.value = area;
      opt.textContent = area;
      sel.appendChild(opt);
    });
    sel.dataset.montado = '1';
  });
}

// Filtro "ver questões de um professor" — "Minhas questões" (valor fixo
// "me") já cobre o usuário atual, então ele não entra de novo na lista
// enumerada (evita duas entradas apontando pra mesma pessoa). Refeito a
// cada carregarTudo() porque a lista de professores pode mudar (login
// novo criado) e o valor <option> muda de conteúdo, não só de aparecer.
function popularSelectFiltroProfessor() {
  const sel = document.getElementById('bmf-filtro-professor');
  const valorAtual = sel.value;
  sel.innerHTML = '<option value="">Todos os professores</option><option value="me">Minhas questões</option>';
  professores.filter(p => p.uid !== currentUser?.uid).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.uid;
    opt.textContent = p.nome;
    sel.appendChild(opt);
  });
  if (valorAtual && [...sel.options].some(o => o.value === valorAtual)) sel.value = valorAtual;
}

// Filtro do banco: disciplinas agrupadas por período (<optgroup>) — dá pra
// ver tudo de uma vez, já filtrado se um período específico for escolhido.
function popularSelectsCategoria() {
  const sel = document.getElementById('bmf-filtro-categoria');
  const filtroPeriodo = document.getElementById('bmf-filtro-periodo').value;
  const valorAtual = sel.value;
  sel.innerHTML = '<option value="">Todas as disciplinas</option>';

  const porPeriodo = new Map();
  categorias.forEach(c => {
    if (filtroPeriodo && String(c.periodo) !== filtroPeriodo) return;
    if (!porPeriodo.has(c.periodo)) porPeriodo.set(c.periodo, []);
    porPeriodo.get(c.periodo).push(c);
  });

  [...porPeriodo.keys()].sort((a, b) => a - b).forEach(periodo => {
    const group = document.createElement('optgroup');
    group.label = `${ordinal(periodo)} Período`;
    porPeriodo.get(periodo).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      const rotulo = c.nomeBreve ? `${c.nome} (${c.nomeBreve})` : c.nome;
      opt.textContent = `${rotulo} — ${c.totalQuestoes || 0} questão(ões)`;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  });

  if (valorAtual && [...sel.options].some(o => o.value === valorAtual)) sel.value = valorAtual;
}

// Formulários de questão/prova: fluxo em cascata — escolhe o período
// primeiro, o select de disciplina já filtra sozinho pra só aquele período
// (pedido do professor: "ela seleciona o período aí já traz as disciplinas
// corretas daquele período", em vez de rolar uma lista longa de todas).
function popularDisciplinasDoPeriodo(selectDisciplinaId, periodo, valorParaSelecionar) {
  const sel = document.getElementById(selectDisciplinaId);
  sel.innerHTML = '';

  if (!periodo) {
    sel.innerHTML = '<option value="">Selecione o período primeiro</option>';
    return;
  }

  const daPeriodo = categorias.filter(c => String(c.periodo) === String(periodo));
  if (!daPeriodo.length) {
    sel.innerHTML = '<option value="" disabled selected>Nenhuma disciplina cadastrada neste período</option>';
    return;
  }

  daPeriodo.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.nomeBreve ? `${c.nome} (${c.nomeBreve})` : c.nome;
    sel.appendChild(opt);
  });

  if (valorParaSelecionar && daPeriodo.some(c => c.id === valorParaSelecionar)) {
    sel.value = valorParaSelecionar;
  }
}

// ================================================================
//  RENDER: BANCO DE QUESTÕES
// ================================================================
// Tira acento pra comparar — o servidor já busca por tituloBusca sem acento
// (prefixo), então esse refino em memória tem que ignorar acento também,
// senão esconde de novo resultado que o servidor já tinha trazido certo.
function semAcento(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function questoesFiltradas() {
  // questoesBanco já vem do servidor filtrado por período + status=publicada
  // — aqui só refinamos dentro do que já está em memória (disciplina/
  // dificuldade/busca não precisam de nova ida ao Firestore).
  const cat = document.getElementById('bmf-filtro-categoria').value;
  const dif = document.getElementById('bmf-filtro-dificuldade').value;
  const busca = semAcento(document.getElementById('bmf-filtro-busca').value.trim().toLowerCase());

  return questoesBanco.filter(q => {
    if (cat && q.categoriaId !== cat) return false;
    if (dif && q.dificuldade !== dif) return false;
    // Inclui o nome da disciplina aqui também — o servidor já busca por
    // título+disciplina (tituloBuscaTokens), então esse refino em memória
    // precisa considerar os mesmos campos, senão descarta de novo quem só
    // batia pela disciplina (ex.: busca "habilidades" achando questões da
    // disciplina "Habilidades Clínicas" cujo título não menciona a palavra).
    // elaboradoPor só existe na resposta pra quem pode ver autoria (backend
    // já anonimiza pra professor) — "|| ''" evita "undefined" virar texto
    // pesquisável quando o campo nem vem.
    if (busca && !semAcento(`${q.titulo} ${q.elaboradoPor || ''} ${nomeCategoria(q.categoriaId)}`.toLowerCase()).includes(busca)) return false;
    return true;
  });
}

function nomeCategoriaObj(id) {
  return categorias.find(c => c.id === id);
}

// Seleção em massa (mesmo padrão do item bank do quiz.one: marca várias
// questões na lista e já manda pra uma prova, sem precisar reabrir um modal
// e buscar tudo de novo).
let questoesSelecionadas = new Set();

function renderQuestoes() {
  const grid = document.getElementById('bmf-questoes-grid');
  const vazio = document.getElementById('bmf-questoes-vazio');
  const contagemEl = document.getElementById('bmf-questoes-contagem');

  // Sem período, área ENAMED, dificuldade, professor nem busca (2+ letras),
  // não tem o que listar (e não fomos buscar nada no servidor) — pede pra
  // escolher em vez de mostrar "vazio".
  const periodoEscolhido = document.getElementById('bmf-filtro-periodo').value;
  const areaEscolhida = document.getElementById('bmf-filtro-area-enamed').value;
  const dificuldadeEscolhida = document.getElementById('bmf-filtro-dificuldade').value;
  const professorEscolhido = document.getElementById('bmf-filtro-professor').value;
  const buscaEscolhida = document.getElementById('bmf-filtro-busca').value.trim();
  if (!periodoEscolhido && !areaEscolhida && !dificuldadeEscolhida && !professorEscolhido && buscaEscolhida.length < 2) {
    grid.innerHTML = '';
    contagemEl.classList.add('hidden');
    vazio.textContent = 'Selecione um período, uma área ENAMED, uma dificuldade, um professor, ou busque por título acima.';
    vazio.classList.remove('hidden');
    renderBarraSelecao();
    return;
  }

  const lista = questoesFiltradas();

  // Tira da seleção qualquer questão que não esteja mais na lista filtrada
  // (foi excluída, ou mudou de disciplina) — evita "selecionadas fantasmas".
  const idsVisiveis = new Set(lista.map(q => q.id));
  [...questoesSelecionadas].forEach(id => { if (!idsVisiveis.has(id)) questoesSelecionadas.delete(id); });

  grid.innerHTML = '';
  const algumFiltroAtivo = periodoEscolhido || areaEscolhida || dificuldadeEscolhida || professorEscolhido || buscaEscolhida.length >= 2 ||
    document.getElementById('bmf-filtro-categoria').value;
  if (professorEscolhido === 'me') {
    // Mensagem específica pro professor entender que é sobre o PRÓPRIO
    // cadastro, não um erro/bug (evita achar que o filtro quebrou quando na
    // verdade ele mesmo ainda não lançou nenhuma questão).
    vazio.textContent = 'Ainda não foram cadastradas questões com o seu perfil.';
  } else {
    vazio.textContent = algumFiltroAtivo
      ? 'Nenhuma questão encontrada com esses filtros. Tenta ajustar período/disciplina/área/dificuldade/professor ou o termo buscado.'
      : 'Nenhuma questão encontrada. Que tal cadastrar a primeira?';
  }
  vazio.classList.toggle('hidden', lista.length > 0);
  contagemEl.classList.toggle('hidden', lista.length === 0);
  if (lista.length) {
    contagemEl.textContent = professorEscolhido === 'me'
      ? `Você criou ${lista.length} questão(ões) com esses filtros.`
      : `${lista.length} questão(ões) encontrada(s).`;
  }

  lista.forEach(q => {
    const row = document.createElement('div');
    row.className = 'bmf-q-row';
    row.innerHTML = `
      <input type="checkbox" class="bmf-q-row-check" data-id="${q.id}" ${questoesSelecionadas.has(q.id) ? 'checked' : ''} aria-label="Selecionar questão">
      <div class="bmf-q-row-main">
        <div class="bmf-q-row-badges">
          <span class="bmf-badge bmf-badge-${q.dificuldade}">${DIFICULDADE_LABEL[q.dificuldade] || q.dificuldade}</span>
          <span class="bmf-badge bmf-badge-tipo">${q.imagem ? ICONS.imagem : ''}${TIPO_LABEL[q.tipoMoodle] || q.tipoMoodle}</span>
          ${q.areaEnamed ? `<span class="bmf-badge bmf-badge-area">${esc(q.areaEnamed)}</span>` : ''}
        </div>
        <div class="bmf-q-row-titulo">${esc(q.titulo)}</div>
        <div class="bmf-q-row-meta">${q.periodo ? `${ordinal(q.periodo)} Período · ` : ''}${esc(nomeCategoria(q.categoriaId))}${podeVerAutoria() ? ` · por ${esc(q.elaboradoPor || '—')}` : ''}</div>
      </div>
      <div class="bmf-q-row-actions">
        <button class="bmf-icon-btn bmf-btn-editar-questao action-execute" data-id="${q.id}" title="Editar questão">${ICONS.editar}</button>
        <button class="bmf-icon-btn bmf-icon-btn-perigo bmf-btn-excluir-questao action-execute" data-id="${q.id}" title="Excluir questão">${ICONS.excluir}</button>
      </div>
    `;
    grid.appendChild(row);
  });

  grid.querySelectorAll('.bmf-btn-editar-questao').forEach(btn => {
    btn.addEventListener('click', () => abrirModalQuestao(btn.dataset.id));
  });
  grid.querySelectorAll('.bmf-btn-excluir-questao').forEach(btn => {
    btn.addEventListener('click', () => excluirQuestao(btn.dataset.id));
  });
  grid.querySelectorAll('.bmf-q-row-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) questoesSelecionadas.add(chk.dataset.id);
      else questoesSelecionadas.delete(chk.dataset.id);
      renderBarraSelecao();
    });
  });

  renderBarraSelecao();
}

function renderBarraSelecao() {
  const barra = document.getElementById('bmf-selecao-bar');
  const n = questoesSelecionadas.size;
  barra.classList.toggle('hidden', n === 0);
  if (n > 0) {
    document.getElementById('bmf-selecao-contagem').textContent = `${n} questão(ões) selecionada(s)`;
  }
}

// ================================================================
//  RENDER: PROVAS
// ================================================================
function provasFiltradas() {
  const periodo = document.getElementById('bmf-prova-filtro-periodo').value;
  return provas.filter(p => {
    // Simulado ENAMED não pertence a um período só (cruza vários) — sempre
    // aparece, independente do filtro de período escolhido.
    if (p.tipo === 'enamed') return true;
    if (periodo && String(nomeCategoriaObj(p.categoriaId)?.periodo) !== periodo) return false;
    return true;
  });
}

function renderProvas() {
  const grid = document.getElementById('bmf-provas-grid');
  const vazio = document.getElementById('bmf-provas-vazio');
  const lista = provasFiltradas();
  grid.innerHTML = '';
  vazio.classList.toggle('hidden', lista.length > 0);

  lista.forEach(p => {
    const row = document.createElement('div');
    row.className = 'bmf-prova-row';
    const totalExport = (p.exportacoes || []).length;
    row.innerHTML = `
      <div class="bmf-prova-row-main">
        <div class="bmf-q-row-badges">
          ${p.semestre ? `<span class="bmf-badge bmf-badge-tipo">${esc(p.semestre)}</span>` : ''}
          ${p.tipo === 'enamed' ? '<span class="bmf-badge bmf-badge-tipo">Simulado ENAMED</span>' : ''}
        </div>
        <div class="bmf-prova-row-titulo">${esc(p.nome)}</div>
        <div class="bmf-prova-row-meta">${esc(p.tipo === 'enamed' ? p.areaEnamed : nomeCategoria(p.categoriaId))} · ${(p.questoesIds || []).length} questão(ões)${totalExport ? ` · exportada ${totalExport}x` : ''} · por ${esc(p.criadoPorNome || '—')}</div>
      </div>
      <div class="bmf-prova-row-acoes">
        <button class="btn btn-secondary bmf-btn-montar-prova action-execute" data-id="${p.id}">
          ${ICONS.montar}
          <span>Montar / Exportar</span>
        </button>
        <button class="bmf-icon-btn bmf-icon-btn-perigo bmf-btn-excluir-prova-linha action-execute" data-id="${p.id}" data-nome="${esc(p.nome)}" title="Excluir prova">${ICONS.excluir}</button>
      </div>
    `;
    grid.appendChild(row);
  });

  grid.querySelectorAll('.bmf-btn-excluir-prova-linha').forEach(btn => {
    btn.addEventListener('click', () => excluirProvaPorId(btn.dataset.id, btn.dataset.nome));
  });

  grid.querySelectorAll('.bmf-btn-montar-prova').forEach(btn => {
    btn.addEventListener('click', () => abrirModalMontarProva(btn.dataset.id));
  });
}

// ================================================================
//  MODAL: QUESTÃO (criar/editar)
// ================================================================
function novaLinhaAlternativa(texto = '', correta = false, tipoRadio = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'bmf-alt-linha';
  wrapper.innerHTML = `
    <input type="${tipoRadio ? 'radio' : 'checkbox'}" name="bmf-alt-correta" class="bmf-alt-correta" ${correta ? 'checked' : ''}>
    <input type="text" class="form-control bmf-alt-texto" placeholder="Texto da alternativa" value="${esc(texto)}">
    <button type="button" class="bmf-icon-btn bmf-icon-btn-perigo bmf-alt-remover" title="Remover alternativa">
      <svg class="bmf-icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;
  wrapper.querySelector('.bmf-alt-remover').addEventListener('click', () => wrapper.remove());
  return wrapper;
}

function renderAlternativasEditor(alternativas, tipoMoodle) {
  const lista = document.getElementById('bmf-alternativas-lista');
  lista.innerHTML = '';
  const tipoRadio = tipoMoodle === 'multichoice_unica';
  alternativas.forEach(a => lista.appendChild(novaLinhaAlternativa(a.texto, a.correta, tipoRadio)));
}

function ajustarEditorPorTipo() {
  const tipo = document.getElementById('bmf-q-tipo').value;
  const lista = document.getElementById('bmf-alternativas-lista');
  const addBtn = document.getElementById('bmf-btn-add-alternativa');

  if (tipo === 'verdadeiro_falso') {
    lista.innerHTML = '';
    lista.appendChild(novaLinhaAlternativa('Verdadeiro', true, true));
    lista.appendChild(novaLinhaAlternativa('Falso', false, true));
    lista.querySelectorAll('.bmf-alt-texto').forEach(inp => inp.disabled = true);
    lista.querySelectorAll('.bmf-alt-remover').forEach(btn => btn.style.display = 'none');
    addBtn.classList.add('hidden');
    return;
  }

  addBtn.classList.remove('hidden');
  const tipoRadio = tipo === 'multichoice_unica';
  lista.querySelectorAll('.bmf-alt-correta').forEach(inp => {
    inp.type = tipoRadio ? 'radio' : 'checkbox';
    inp.name = tipoRadio ? 'bmf-alt-correta' : '';
  });
  if (!lista.children.length) {
    lista.appendChild(novaLinhaAlternativa('', false, tipoRadio));
    lista.appendChild(novaLinhaAlternativa('', false, tipoRadio));
  }
}

function limparFormQuestao() {
  document.getElementById('bmf-form-questao').reset();
  document.getElementById('bmf-q-id').value = '';
  document.getElementById('bmf-q-erro').classList.add('hidden');
  document.getElementById('bmf-nova-categoria-group').classList.add('hidden');
  popularDisciplinasDoPeriodo('bmf-q-categoria', '');
  imagemAtual = null;
  document.getElementById('bmf-q-imagem-preview').classList.add('hidden');
  document.getElementById('bmf-q-imagem-input').value = '';
  document.getElementById('bmf-q-imagem-nome').textContent = 'Escolher imagem…';
  renderAlternativasEditor([{ texto: '', correta: false }, { texto: '', correta: false }], 'multichoice_unica');
  // bmf-q-enunciado/justificativa são <div contenteditable>, não <textarea> —
  // form.reset() não limpa eles, tem que zerar na mão.
  document.getElementById('bmf-q-enunciado').innerHTML = '';
  document.getElementById('bmf-q-justificativa').innerHTML = '';
}

function abrirModalQuestao(id) {
  limparFormQuestao();
  const modal = document.getElementById('bmf-modal-questao');
  const titulo = document.getElementById('bmf-questao-modal-titulo');

  if (id) {
    const q = questoesBanco.find(q => q.id === id);
    if (!q) return;
    titulo.textContent = 'Editar Questão';
    document.getElementById('bmf-q-id').value = q.id;
    document.getElementById('bmf-q-titulo').value = q.titulo;
    const categoriaAtual = nomeCategoriaObj(q.categoriaId);
    if (categoriaAtual) {
      document.getElementById('bmf-q-periodo').value = String(categoriaAtual.periodo);
      popularDisciplinasDoPeriodo('bmf-q-categoria', categoriaAtual.periodo, q.categoriaId);
    }
    document.getElementById('bmf-q-dificuldade').value = q.dificuldade;
    document.getElementById('bmf-q-tipo').value = q.tipoMoodle;
    document.getElementById('bmf-q-area-enamed').value = q.areaEnamed || '';
    document.getElementById('bmf-q-enunciado').innerHTML = q.enunciadoHtml || '';
    document.getElementById('bmf-q-justificativa').innerHTML = q.justificativa || '';
    document.getElementById('bmf-q-fonte').value = q.fonte || '';
    renderAlternativasEditor(q.alternativas, q.tipoMoodle);
    if (q.tipoMoodle === 'verdadeiro_falso') ajustarEditorPorTipo();
    if (q.imagem && q.imagem.dataUrl) {
      imagemAtual = q.imagem;
      document.getElementById('bmf-q-imagem-img').src = q.imagem.dataUrl;
      document.getElementById('bmf-q-imagem-preview').classList.remove('hidden');
      document.getElementById('bmf-q-imagem-nome').textContent = q.imagem.nome || 'Imagem carregada';
    }
  } else {
    titulo.textContent = 'Nova Questão';
    // Sem disciplina nenhuma cadastrada, o select de disciplina fica vazio —
    // já abre o painel de criação em vez de deixar a professora procurando o "+".
    if (categorias.length === 0) {
      document.getElementById('bmf-nova-categoria-group').classList.remove('hidden');
    }
  }

  modal.classList.add('active');
}

function fecharModalQuestao() {
  document.getElementById('bmf-modal-questao').classList.remove('active');
}

function lerAlternativasDoForm() {
  return [...document.querySelectorAll('#bmf-alternativas-lista .bmf-alt-linha')].map(linha => ({
    texto: linha.querySelector('.bmf-alt-texto').value.trim(),
    correta: linha.querySelector('.bmf-alt-correta').checked
  }));
}

async function salvarQuestao(e) {
  e.preventDefault();
  const erroEl = document.getElementById('bmf-q-erro');
  erroEl.classList.add('hidden');

  const id = document.getElementById('bmf-q-id').value;
  const payload = {
    titulo: document.getElementById('bmf-q-titulo').value.trim(),
    categoriaId: document.getElementById('bmf-q-categoria').value,
    dificuldade: document.getElementById('bmf-q-dificuldade').value,
    tipoMoodle: document.getElementById('bmf-q-tipo').value,
    areaEnamed: document.getElementById('bmf-q-area-enamed').value,
    enunciadoHtml: sanitizeHTML(document.getElementById('bmf-q-enunciado').innerHTML.trim()),
    alternativas: lerAlternativasDoForm(),
    justificativa: sanitizeHTML(document.getElementById('bmf-q-justificativa').innerHTML.trim()),
    fonte: document.getElementById('bmf-q-fonte').value.trim(),
    imagem: imagemAtual
  };

  try {
    if (id) {
      await apiFetch(`/banco-med-fatec/questoes/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiFetch('/banco-med-fatec/questoes', { method: 'POST', body: JSON.stringify(payload) });
    }
    fecharModalQuestao();
    await carregarTudo();
  } catch (err) {
    erroEl.textContent = err.message;
    erroEl.classList.remove('hidden');
  }
}

async function excluirQuestao(id) {
  if (!confirm('Remover esta questão do banco compartilhado? Ela sairá de qualquer prova que a use.')) return;
  try {
    await apiFetch(`/banco-med-fatec/questoes/${id}`, { method: 'DELETE' });
    await carregarTudo();
  } catch (err) {
    alert('Erro ao excluir: ' + err.message);
  }
}

// ================================================================
//  MODAL: NOVA PROVA
// ================================================================
// Quando "Nova Prova" é aberta a partir da seleção em massa do banco (ver
// abrirModalAdicionarProva), essas questões já entram na prova assim que
// ela é criada — sem precisar reabrir "Montar Prova" pra selecioná-las de novo.
let questoesParaNovaProva = null;

// Alterna entre "Por disciplina" (categoria+período, como sempre foi) e
// "Simulado ENAMED" (só a área, cruzando período/disciplina) — troca qual
// grupo de campos fica visível e o valor guardado no input hidden bmf-p-tipo.
function selecionarTipoProva(tipo) {
  document.getElementById('bmf-p-tipo').value = tipo;
  document.querySelectorAll('.bmf-tipo-prova-btn').forEach(b => b.classList.toggle('active', b.dataset.tipo === tipo));
  document.getElementById('bmf-p-grupo-disciplina').classList.toggle('hidden', tipo !== 'disciplina');
  document.getElementById('bmf-p-grupo-enamed').classList.toggle('hidden', tipo !== 'enamed');
}

function abrirModalNovaProva(prefill) {
  if (categorias.length === 0) {
    alert('Ainda não há nenhuma disciplina cadastrada. Cadastre uma disciplina primeiro pela aba "Banco de Questões" (botão "+ Nova Questão" → "+" ao lado de Disciplina).');
    return;
  }
  document.getElementById('bmf-form-prova-novo').reset();
  selecionarTipoProva('disciplina');
  questoesParaNovaProva = prefill?.questoesIds || null;
  if (prefill?.categoriaId) {
    const cat = nomeCategoriaObj(prefill.categoriaId);
    if (cat) {
      document.getElementById('bmf-p-periodo').value = String(cat.periodo);
      popularDisciplinasDoPeriodo('bmf-p-categoria', cat.periodo, cat.id);
    }
  } else {
    popularDisciplinasDoPeriodo('bmf-p-categoria', '');
  }
  // Sugere o semestre corrente (jan-jun = .1, jul-dez = .2) — o professor pode trocar.
  const hoje = new Date();
  document.getElementById('bmf-p-semestre').value = `${hoje.getFullYear()}.${hoje.getMonth() < 6 ? '1' : '2'}`;
  document.getElementById('bmf-modal-prova-novo').classList.add('active');
}
function fecharModalNovaProva() {
  document.getElementById('bmf-modal-prova-novo').classList.remove('active');
}

async function criarProva(e) {
  e.preventDefault();
  const erroEl = document.getElementById('bmf-p-erro');
  const tipo = document.getElementById('bmf-p-tipo').value;
  const categoriaId = document.getElementById('bmf-p-categoria').value;
  const areaEnamed = document.getElementById('bmf-p-area-enamed').value;

  if (tipo === 'disciplina' && !categoriaId) {
    if (erroEl) { erroEl.textContent = 'Selecione a disciplina da prova.'; erroEl.classList.remove('hidden'); }
    return;
  }
  if (tipo === 'enamed' && !areaEnamed) {
    if (erroEl) { erroEl.textContent = 'Selecione a área ENAMED da prova.'; erroEl.classList.remove('hidden'); }
    return;
  }

  try {
    const questoesIds = questoesParaNovaProva || [];
    await apiFetch('/banco-med-fatec/provas', {
      method: 'POST',
      body: JSON.stringify({
        nome: document.getElementById('bmf-p-nome').value.trim(),
        semestre: document.getElementById('bmf-p-semestre').value.trim(),
        tipo,
        categoriaId: tipo === 'disciplina' ? categoriaId : undefined,
        areaEnamed: tipo === 'enamed' ? areaEnamed : undefined,
        questoesIds
      })
    });
    const veioDaSelecao = questoesParaNovaProva && questoesParaNovaProva.length > 0;
    questoesParaNovaProva = null;
    fecharModalNovaProva();
    if (veioDaSelecao) {
      questoesSelecionadas.clear();
      fecharModalAdicionarProva();
    }
    await carregarTudo();
  } catch (err) {
    alert('Erro ao criar prova: ' + err.message);
  }
}

// ================================================================
//  ADICIONAR SELEÇÃO EM MASSA A UMA PROVA (fluxo do item bank)
// ================================================================
function abrirModalAdicionarProva() {
  const idsSelecionados = [...questoesSelecionadas];
  const erroEl = document.getElementById('bmf-adicionar-prova-erro');
  const sub = document.getElementById('bmf-adicionar-prova-sub');
  const lista = document.getElementById('bmf-adicionar-prova-lista');
  erroEl.classList.add('hidden');

  const questoesSelecionadasObjs = questoesBanco.filter(q => idsSelecionados.includes(q.id));
  const categoriasDistintas = new Set(questoesSelecionadasObjs.map(q => q.categoriaId));

  if (categoriasDistintas.size > 1) {
    erroEl.textContent = 'As questões selecionadas são de disciplinas diferentes. Uma prova pertence a uma única disciplina — selecione questões de uma disciplina por vez.';
    erroEl.classList.remove('hidden');
    lista.innerHTML = '';
    sub.textContent = '';
    document.getElementById('bmf-modal-adicionar-prova').classList.add('active');
    return;
  }

  const categoriaId = [...categoriasDistintas][0];
  sub.textContent = `${idsSelecionados.length} questão(ões) de "${nomeCategoria(categoriaId)}" — escolha a prova de destino:`;

  const provasDaDisciplina = provas.filter(p => p.categoriaId === categoriaId);
  lista.innerHTML = '';

  provasDaDisciplina.forEach(p => {
    const linha = document.createElement('button');
    linha.type = 'button';
    linha.className = 'bmf-prova-q-linha';
    linha.style.cssText = 'width:100%; text-align:left; background:none; border:none; cursor:pointer;';
    const jaTem = (p.questoesIds || []).filter(id => idsSelecionados.includes(id)).length;
    linha.innerHTML = `
      <span class="bmf-prova-q-titulo">${esc(p.nome)} <span style="color:var(--text-secondary); font-weight:500;">(${esc(p.semestre || '')})</span></span>
      <span class="bmf-q-meta">${jaTem ? `${jaTem} já estão aqui` : ''}</span>
    `;
    linha.addEventListener('click', () => adicionarSelecaoNaProva(p.id, idsSelecionados));
    lista.appendChild(linha);
  });

  const criarNova = document.createElement('button');
  criarNova.type = 'button';
  criarNova.className = 'bmf-prova-q-linha';
  criarNova.style.cssText = 'width:100%; text-align:left; background:none; border:none; cursor:pointer; color:var(--med-azul-escuro); font-weight:700;';
  criarNova.innerHTML = `<span class="bmf-prova-q-titulo">+ Criar nova prova com estas questões</span>`;
  criarNova.addEventListener('click', () => {
    fecharModalAdicionarProva();
    abrirModalNovaProva({ categoriaId, questoesIds: idsSelecionados });
  });
  lista.appendChild(criarNova);

  document.getElementById('bmf-modal-adicionar-prova').classList.add('active');
}

function fecharModalAdicionarProva() {
  document.getElementById('bmf-modal-adicionar-prova').classList.remove('active');
}

async function adicionarSelecaoNaProva(provaId, idsParaAdicionar) {
  const erroEl = document.getElementById('bmf-adicionar-prova-erro');
  erroEl.classList.add('hidden');
  try {
    const prova = provas.find(p => p.id === provaId);
    const questoesIds = [...new Set([...(prova.questoesIds || []), ...idsParaAdicionar])];
    await apiFetch(`/banco-med-fatec/provas/${provaId}`, {
      method: 'PUT',
      body: JSON.stringify({ nome: prova.nome, categoriaId: prova.categoriaId, questoesIds })
    });
    questoesSelecionadas.clear();
    fecharModalAdicionarProva();
    await carregarTudo();
    alert(`Adicionado à prova "${prova.nome}"!`);
  } catch (err) {
    erroEl.textContent = err.message;
    erroEl.classList.remove('hidden');
  }
}

// ================================================================
//  MODAL: MONTAR / EXPORTAR PROVA
// ================================================================
// Fonte única de verdade da seleção enquanto o modal está aberto — os
// checkboxes só refletem este Set, nunca o contrário. Sem isso, filtrar
// pela busca (que remove do DOM as linhas que não batem) fazia a seleção de
// itens fora do filtro sumir na hora de salvar/exportar.
let selecaoProvaAtual = new Set();

function renderListaSelecaoQuestoes() {
  const busca = document.getElementById('bmf-prova-busca').value.trim().toLowerCase();
  const lista = document.getElementById('bmf-prova-questoes-lista');
  lista.innerHTML = '';

  // questoesProvaAtual já vem do servidor filtrado pela disciplina da prova
  // (GET /questoes?categoriaId=...) — cada prova pertence a uma disciplina
  // só, então misturar questões de outras disciplinas aqui não fazia sentido.
  const disponiveis = questoesProvaAtual.filter(q => !busca || q.titulo.toLowerCase().includes(busca));

  if (!questoesProvaAtual.length) {
    const rotuloVazio = provaEmEdicao.tipo === 'enamed' ? `área "${esc(provaEmEdicao.areaEnamed)}"` : `disciplina "${esc(nomeCategoria(provaEmEdicao.categoriaId))}"`;
    lista.innerHTML = `<p class="bmf-empty" style="padding:1.5rem;">Ainda não há questões marcadas com essa ${rotuloVazio}. Cadastre/marque questões na aba Banco de Questões.</p>`;
    return;
  }

  disponiveis.forEach(q => {
    const item = document.createElement('div');
    item.className = 'bmf-prova-q-item';
    const alternativasHtml = (q.alternativas || []).map(a =>
      `<li class="${a.correta ? 'bmf-prova-q-alt-correta' : ''}">${esc(a.texto)}</li>`
    ).join('');
    item.innerHTML = `
      <div class="bmf-prova-q-linha">
        <input type="checkbox" class="bmf-prova-q-check" value="${q.id}" ${selecaoProvaAtual.has(q.id) ? 'checked' : ''} aria-label="Selecionar questão">
        <span class="bmf-badge bmf-badge-${q.dificuldade}">${DIFICULDADE_LABEL[q.dificuldade]}</span>
        <button type="button" class="bmf-prova-q-titulo bmf-prova-q-expandir" data-id="${q.id}">${esc(q.titulo)}</button>
        <button type="button" class="bmf-icon-btn bmf-prova-q-expandir" data-id="${q.id}" title="Ver enunciado">
          <svg class="bmf-icon" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
      <div class="bmf-prova-q-detalhe hidden" id="bmf-prova-q-detalhe-${q.id}">
        <div class="bmf-prova-q-enunciado">${q.enunciadoHtml || ''}</div>
        ${q.imagem && q.imagem.dataUrl ? `<img src="${q.imagem.dataUrl}" alt="Imagem clínica" class="bmf-prova-q-imagem">` : ''}
        <ul class="bmf-prova-q-alternativas">${alternativasHtml}</ul>
        ${q.justificativa ? `<p class="bmf-prova-q-justificativa"><strong>Justificativa:</strong> ${q.justificativa}</p>` : ''}
      </div>
    `;
    lista.appendChild(item);
  });

  lista.querySelectorAll('.bmf-prova-q-expandir').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(`bmf-prova-q-detalhe-${btn.dataset.id}`)?.classList.toggle('hidden');
    });
  });

  lista.querySelectorAll('.bmf-prova-q-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) selecaoProvaAtual.add(chk.value);
      else selecaoProvaAtual.delete(chk.value);
    });
  });
}

async function abrirModalMontarProva(id) {
  provaEmEdicao = provas.find(p => p.id === id);
  if (!provaEmEdicao) return;
  selecaoProvaAtual = new Set(provaEmEdicao.questoesIds || []);
  const rotuloEscopo = provaEmEdicao.tipo === 'enamed' ? provaEmEdicao.areaEnamed : nomeCategoria(provaEmEdicao.categoriaId);
  document.getElementById('bmf-prova-montar-titulo').textContent = `Montar Prova — ${provaEmEdicao.nome} (${rotuloEscopo})`;
  document.getElementById('bmf-prova-busca').value = '';
  document.getElementById('bmf-prova-qtd-input').value = '';
  document.getElementById('bmf-prova-erro').classList.add('hidden');
  document.getElementById('bmf-modal-prova-montar').classList.add('active');
  document.getElementById('bmf-prova-questoes-lista').innerHTML = '<p class="bmf-empty" style="padding:1.5rem;">Carregando questões…</p>';
  try {
    if (provaEmEdicao.tipo === 'enamed') {
      await carregarQuestoesDaArea(provaEmEdicao.areaEnamed);
    } else {
      await carregarQuestoesDaCategoria(provaEmEdicao.categoriaId);
    }
  } catch (err) {
    questoesProvaAtual = [];
  }
  renderListaSelecaoQuestoes();
}

// "Todas" / "aleatórias" agem só sobre o que está visível no momento (já
// filtrado pela busca) — selecionar tudo não deve alcançar o que a busca escondeu.
function selecionarTodasVisiveis(marcar) {
  document.querySelectorAll('#bmf-prova-questoes-lista .bmf-prova-q-check').forEach(chk => {
    chk.checked = marcar;
    if (marcar) selecaoProvaAtual.add(chk.value);
    else selecaoProvaAtual.delete(chk.value);
  });
}

function selecionarQuantidadeAleatoria(qtd) {
  const checks = [...document.querySelectorAll('#bmf-prova-questoes-lista .bmf-prova-q-check')];
  checks.forEach(chk => { chk.checked = false; selecaoProvaAtual.delete(chk.value); });
  const embaralhadas = checks
    .map(chk => ({ chk, ordem: Math.random() }))
    .sort((a, b) => a.ordem - b.ordem)
    .map(x => x.chk);
  embaralhadas.slice(0, qtd).forEach(chk => { chk.checked = true; selecaoProvaAtual.add(chk.value); });
}

function fecharModalMontarProva() {
  document.getElementById('bmf-modal-prova-montar').classList.remove('active');
  provaEmEdicao = null;
  selecaoProvaAtual = new Set();
}

function questoesIdsSelecionadas() {
  return [...selecaoProvaAtual];
}

async function salvarSelecaoProva() {
  const erroEl = document.getElementById('bmf-prova-erro');
  erroEl.classList.add('hidden');
  try {
    const questoesIds = questoesIdsSelecionadas();
    await apiFetch(`/banco-med-fatec/provas/${provaEmEdicao.id}`, {
      method: 'PUT',
      body: JSON.stringify({ nome: provaEmEdicao.nome, categoriaId: provaEmEdicao.categoriaId, questoesIds })
    });
    provaEmEdicao.questoesIds = questoesIds;
    await carregarTudo();
    alert('Seleção salva!');
  } catch (err) {
    erroEl.textContent = err.message;
    erroEl.classList.remove('hidden');
  }
}

async function exportarProva() {
  const erroEl = document.getElementById('bmf-prova-erro');
  erroEl.classList.add('hidden');
  try {
    await salvarSelecaoProvaSilencioso();
    await apiDownload(`/banco-med-fatec/provas/${provaEmEdicao.id}/exportar`);
    await carregarTudo();
  } catch (err) {
    erroEl.textContent = err.message;
    erroEl.classList.remove('hidden');
  }
}

async function salvarSelecaoProvaSilencioso() {
  const questoesIds = questoesIdsSelecionadas();
  await apiFetch(`/banco-med-fatec/provas/${provaEmEdicao.id}`, {
    method: 'PUT',
    body: JSON.stringify({ nome: provaEmEdicao.nome, categoriaId: provaEmEdicao.categoriaId, questoesIds })
  });
  provaEmEdicao.questoesIds = questoesIds;
}

async function excluirProva() {
  if (!provaEmEdicao) return;
  const ok = await excluirProvaPorId(provaEmEdicao.id, provaEmEdicao.nome);
  if (ok) fecharModalMontarProva();
}

// Usado tanto pelo botão "Excluir Prova" dentro do modal "Montar Prova"
// quanto pelo ícone de lixeira direto na linha da prova (não precisa abrir o
// modal só pra apagar uma prova de teste). Devolve true se excluiu de fato.
async function excluirProvaPorId(id, nome) {
  if (!confirm(`Excluir a prova "${nome}"? Isso não afeta as questões do banco.`)) return false;
  try {
    await apiFetch(`/banco-med-fatec/provas/${id}`, { method: 'DELETE' });
    await carregarTudo();
    return true;
  } catch (err) {
    alert('Erro ao excluir: ' + err.message);
    return false;
  }
}

// ================================================================
//  IMPORTAÇÃO DO AVA (Moodle XML)
// ================================================================
// Parsing 100% no navegador (DOMParser, nativo) — evita mandar pro
// servidor um arquivo que pode vir gigante (imagem embutida em base64
// dentro do XML costuma pesar muito mais que o resto do arquivo inteiro).
// Só o resultado já normalizado (e a imagem já recomprimida) vai pra API.

function textoDe(el, seletor) {
  const alvo = el.querySelector(seletor);
  return alvo ? alvo.textContent : '';
}

// Tira acento/pontuação/maiúsculas — usado só pra sugerir a disciplina
// mais provável (o professor sempre confirma antes de valer).
function normalizarTexto(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// Numeral romano guarda info importante (é o que diferencia "Saúde,
// Comunidade... I" de "...II" etc) mesmo sendo curto — não pode ser
// descartado junto com conectivos tipo "E"/"DE"/"DO".
const ROMANOS_DISCIPLINA = new Set(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']);
function tokenizarTexto(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(w => w.length >= 3 || ROMANOS_DISCIPLINA.has(w));
}

// Sugere a disciplina comparando PALAVRAS do nome completo (não a abreviação
// — "FORM.DES.ENV.HUM." nunca aparece como pedaço literal de "Formação,
// Desenvolvimento e Envelhecimento Humano", então comparar substring contra
// o nomeBreve praticamente nunca batia). Exige pelo menos 2 palavras em
// comum e pelo menos metade das palavras da disciplina batendo; se mais de
// uma disciplina empata no placar (ex.: "Saúde, Comunidade..." sem o
// numeral do período no texto importado), não arrisca palpite — deixa em
// branco pro professor escolher.
function sugerirCategoria(categoriaSugeridaTexto) {
  const tokensAlvo = new Set(tokenizarTexto(categoriaSugeridaTexto));
  if (!tokensAlvo.size) return null;

  let melhorScore = 0;
  let empatados = [];
  categorias.forEach(c => {
    const tokensNome = tokenizarTexto(c.nome);
    if (!tokensNome.length) return;
    const bateram = tokensNome.filter(t => tokensAlvo.has(t)).length;
    if (bateram < 2) return;
    const score = bateram / tokensNome.length;
    if (score < 0.5) return;
    if (score > melhorScore) { melhorScore = score; empatados = [c]; }
    else if (score === melhorScore) { empatados.push(c); }
  });
  return empatados.length === 1 ? empatados[0] : null;
}

async function extrairImagemDoMoodle(questionEl) {
  const fileEl = questionEl.querySelector('questiontext > file');
  if (!fileEl) return null;
  const nome = fileEl.getAttribute('name') || 'imagem';
  const base64 = (fileEl.textContent || '').trim();
  if (!base64) return null;
  const ext = (nome.split('.').pop() || 'jpg').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${base64}`;
  try {
    const comprimida = await comprimirDataUrl(dataUrl);
    return { nome: nome.replace(/\.[^.]+$/, ''), dataUrl: comprimida };
  } catch (err) {
    console.warn('Não deu pra comprimir imagem importada:', nome, err.message);
    return null;
  }
}

// Remove a <img> que aponta pro @@PLUGINFILE@@ (a imagem já vira o campo
// `imagem` separado do nosso schema, não fica solta dentro do enunciado).
// Quando o professor cola de Word/Google Docs no editor do Moodle, o HTML
// vem cheio de lixo de formatação (style="mso-fareast-font-family: Aptos...",
// comentários condicionais <!--[if ...]-->, spans vazios) que o Moodle
// preserva ao pé da letra na exportação. Isso não muda o conteúdo da
// questão, só a marcação — aqui a gente tira o lixo e mantém a estrutura
// (parágrafo, negrito, lista, imagem).
function limparHtmlColado(html) {
  if (!html) return html;
  const div = document.createElement('div');
  div.innerHTML = html;

  // comentários condicionais do Word (<!--[if ...]-->...<!--[endif]-->)
  const comentarios = [];
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_COMMENT);
  let noAtual;
  while ((noAtual = walker.nextNode())) comentarios.push(noAtual);
  comentarios.forEach(c => c.remove());

  div.querySelectorAll('*').forEach(el => {
    el.removeAttribute('style');
    el.removeAttribute('lang');
    el.removeAttribute('class');
    // span sem nenhum atributo (sobrou só carregando o style que já tiramos)
    // não serve mais pra nada — troca o span pelos filhos dele direto.
    if (el.tagName === 'SPAN' && el.attributes.length === 0) {
      el.replaceWith(...el.childNodes);
    }
  });

  return div.innerHTML.replace(/<p>\s*<\/p>/gi, '').trim();
}

function removerImgPluginfile(html) {
  return (html || '')
    .replace(/<img[^>]*@@PLUGINFILE@@[^>]*>/gi, '')
    .replace(/<p>\s*<\/p>/gi, '') // some o parágrafo que só existia pra segurar a imagem
    .trim();
}

function tagDoMoodle(questionEl, prefixo) {
  const tags = [...questionEl.querySelectorAll('tags > tag > text')].map(t => t.textContent);
  const achada = tags.find(t => t.startsWith(`${prefixo}:`));
  return achada ? achada.slice(prefixo.length + 1) : '';
}

const DIFICULDADE_POR_LABEL = { 'Fácil': 'facil', 'Média': 'media', 'Intermediária': 'intermediaria', 'Difícil': 'dificil' };

// O Moodle NÃO tem campo nativo de dificuldade — quando existe, é um texto
// que o próprio professor escreveu à mão em algum campo (geralmente o
// "Comentário geral", que só o professor vê, nunca o aluno), sem padrão
// fixo. Isso só ajuda nos poucos casos em que alguém seguiu esse formato —
// pra maioria das questões exportadas direto do AVA não tem essa informação
// em lugar nenhum, e "média" continua sendo o padrão razoável.
const DIFICULDADE_POR_TEXTO_LIVRE = {
  'facil': 'facil', 'fácil': 'facil',
  'media': 'media', 'média': 'media',
  'intermediaria': 'intermediaria', 'intermediária': 'intermediaria',
  'dificil': 'dificil', 'difícil': 'dificil'
};

// Padrão mais comum encontrado no banco real: a dificuldade vem colada no
// FINAL do título da questão, depois de um traço/travessão — ex.: "TBL -
// Ossos do Membro Superior – Intermediária", "Músculos do Membro Inferior -
// difícil". Nada a ver com o bloco "Categoria de dificuldade:" (mais raro).
const RE_DIFICULDADE_NO_TITULO = /[-–—:]\s*(fácil|facil|média|media|intermediária|intermediaria|difícil|dificil)\s*$/i;
function dificuldadeDoTitulo(titulo) {
  const m = RE_DIFICULDADE_NO_TITULO.exec((titulo || '').trim());
  return m ? DIFICULDADE_POR_TEXTO_LIVRE[m[1].toLowerCase()] : null;
}

function extrairMetadadoDoTextoLivre(...camposHtml) {
  const div = document.createElement('div');
  div.innerHTML = camposHtml.filter(Boolean).join('\n');
  const plano = div.textContent;

  const difMatch = /dificuldade[^:]{0,40}:\s*(fácil|facil|intermediária|intermediaria|difícil|dificil|média|media)/i.exec(plano);
  const autorMatch = /elaborado por:\s*([^\n\r]+)/i.exec(plano);

  return {
    dificuldade: difMatch ? DIFICULDADE_POR_TEXTO_LIVRE[difMatch[1].toLowerCase()] : null,
    autor: autorMatch ? autorMatch[1].trim() : null
  };
}

async function questaoMoodleParaSchema(questionEl) {
  const tipo = questionEl.getAttribute('type');
  const titulo = textoDe(questionEl, 'name > text').trim() || '(sem título)';
  const enunciadoBruto = textoDe(questionEl, 'questiontext > text');
  const imagem = await extrairImagemDoMoodle(questionEl);
  const enunciadoHtml = limparHtmlColado(removerImgPluginfile(enunciadoBruto));
  const justificativa = textoDe(questionEl, 'generalfeedback > text').trim();

  // Round-trip: se veio de uma exportação nossa, os tags/rodapé de FONTE já
  // estão no formato que a gente mesmo gera — aproveita em vez de perder.
  const fonteMatch = /<p><em>FONTE:\s*(.*?)<\/em><\/p>\s*$/i.exec(justificativa);
  const fonte = fonteMatch ? fonteMatch[1].trim() : '';
  const justificativaSemFonte = fonteMatch ? justificativa.slice(0, fonteMatch.index).trim() : justificativa;

  // 1) tag do Moodle no formato que a gente mesmo gera (round-trip de uma
  //    exportação nossa); 2) dificuldade colada no final do título (padrão
  //    mais comum no banco real, ex. "... - Intermediária"); 3) texto livre
  //    tipo "Categoria de dificuldade (...): fácil" no comentário geral;
  //    4) "média" como padrão, quando nada disso aparece.
  const metadado = extrairMetadadoDoTextoLivre(enunciadoBruto, justificativa);
  const dificuldadeLabel = tagDoMoodle(questionEl, 'dificuldade');
  const dificuldade = DIFICULDADE_POR_LABEL[dificuldadeLabel] || dificuldadeDoTitulo(titulo) || metadado.dificuldade || 'media';
  const elaboradoPor = tagDoMoodle(questionEl, 'autor') || metadado.autor || 'Importado do AVA';

  const alternativas = [...questionEl.querySelectorAll(':scope > answer')].map(a => {
    const fraction = parseFloat(a.getAttribute('fraction') || '0');
    const textoAlt = document.createElement('div');
    textoAlt.innerHTML = textoDe(a, 'text');
    return { texto: textoAlt.textContent.trim(), correta: fraction > 0 };
  });

  let tipoMoodle;
  if (tipo === 'truefalse') {
    tipoMoodle = 'verdadeiro_falso';
  } else if (tipo === 'multichoiceset') {
    tipoMoodle = 'multichoice_multipla';
  } else {
    tipoMoodle = 'multichoice_unica';
  }

  // truefalse do Moodle vem como respostas "true"/"false" — normaliza pro
  // texto Verdadeiro/Falso que o resto do app espera pra esse tipo.
  const alternativasFinal = tipoMoodle === 'verdadeiro_falso'
    ? alternativas.map(a => ({ texto: a.texto === 'true' ? 'Verdadeiro' : 'Falso', correta: a.correta }))
    : alternativas;

  return {
    titulo,
    enunciadoHtml,
    imagem,
    justificativa: limparHtmlColado(justificativaSemFonte),
    fonte,
    dificuldade,
    elaboradoPor,
    tipoMoodle,
    alternativas: alternativasFinal
  };
}

// Um arquivo do Moodle pode trazer só uma disciplina (uma categoria) ou
// várias de uma vez (quando exportado com "incluir subcategorias" a partir
// de um contexto compartilhado) — nesse caso, cada troca de categoria vem
// marcada por um <question type="category"> no meio do arquivo, e tudo que
// vem depois dela pertence a essa categoria até a próxima marca aparecer.
// Por isso devolvemos uma LISTA de grupos, um por categoria encontrada,
// cada um virando seu próprio lote de revisão — nunca misturamos disciplinas
// diferentes num só lote.
async function parseMoodleXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Arquivo XML inválido ou corrompido.');

  const todasQuestoes = [...doc.querySelectorAll('quiz > question')];
  const grupos = [];
  let grupoAtual = null;

  for (const qEl of todasQuestoes) {
    const tipo = qEl.getAttribute('type');

    if (tipo === 'category') {
      const bruto = textoDe(qEl, 'category > text');
      const caminho = bruto.replace(/^\$module\$\/top\//, '').replace(/^\$course\$\/top\//, '').replace(/^\$system\$\/top\//, '').trim();
      // Só o último pedaço do caminho (a subcategoria/disciplina em si, não
      // a árvore inteira) — ex: "Medicina/OPT. I - 6927" vira "OPT. I - 6927".
      const nomeCurto = caminho.split('/').filter(Boolean).pop() || caminho;
      grupoAtual = { categoriaSugeridaTexto: nomeCurto, questoes: [] };
      grupos.push(grupoAtual);
      continue;
    }

    if (!TIPOS_MOODLE_SUPORTADOS.includes(tipo)) continue;
    if (!grupoAtual) {
      grupoAtual = { categoriaSugeridaTexto: '', questoes: [] };
      grupos.push(grupoAtual);
    }
    grupoAtual.questoes.push(await questaoMoodleParaSchema(qEl));
  }

  // Categorias "pai" que não tinham nenhuma questão direta (só existiam pra
  // organizar as subcategorias) não viram lote vazio.
  return grupos.filter(g => g.questoes.length > 0);
}

const TIPOS_MOODLE_SUPORTADOS = ['multichoice', 'multichoiceset', 'truefalse'];

async function importarArquivosAva(fileList) {
  const arquivos = [...fileList];
  if (!arquivos.length) return;

  const itens = [];
  for (const file of arquivos) {
    try {
      const texto = await file.text();
      const grupos = await parseMoodleXml(texto);
      if (!grupos.length) {
        itens.push({ arquivo: file.name, falhou: true, mensagem: 'Nenhuma questão de tipo suportado encontrada.' });
        continue;
      }

      // Um arquivo pode trazer mais de uma disciplina (exportação com
      // subcategorias) — cada categoria encontrada vira seu próprio lote,
      // sem misturar questões de disciplinas diferentes.
      for (const grupo of grupos) {
        const resp = await apiFetch('/banco-med-fatec/questoes/importar-lote', {
          method: 'POST',
          body: JSON.stringify({ categoriaSugeridaTexto: grupo.categoriaSugeridaTexto, questoes: grupo.questoes })
        });
        if (resp.duplicadas && resp.duplicadas.length) console.info(`Duplicatas ignoradas em ${file.name} / ${grupo.categoriaSugeridaTexto}:`, resp.duplicadas);
        if (resp.erros && resp.erros.length) console.warn(`Erros ao importar ${file.name} / ${grupo.categoriaSugeridaTexto}:`, resp.erros);
        itens.push({
          arquivo: file.name,
          categoria: grupo.categoriaSugeridaTexto || '(sem categoria)',
          criadas: resp.criadas || 0,
          duplicadas: (resp.duplicadas || []).length,
          erros: (resp.erros || []).length
        });
      }
    } catch (err) {
      itens.push({ arquivo: file.name, falhou: true, mensagem: err.message });
    }
  }

  mostrarResultadoImportacao(itens);
  await carregarTudo();
}

// Modal de resultado da importação — substitui o alert() nativo por um
// resumo com um card por disciplina/arquivo, fácil de escanear quando o
// professor importa vários arquivos/categorias de uma vez.
function mostrarResultadoImportacao(itens) {
  const lista = document.getElementById('bmf-resultado-importacao-lista');
  const totalCriadas = itens.reduce((acc, it) => acc + (it.criadas || 0), 0);
  const totalDuplicadas = itens.reduce((acc, it) => acc + (it.duplicadas || 0), 0);
  const totalErros = itens.reduce((acc, it) => acc + (it.erros || 0), 0);

  lista.innerHTML = itens.map(it => {
    if (it.falhou) {
      return `
        <div class="bmf-resultado-item bmf-resultado-erro">
          ${ICONS.alerta}
          <div>
            <div class="bmf-resultado-item-titulo">${esc(it.arquivo)}</div>
            <div class="bmf-resultado-item-detalhe">Falhou — ${esc(it.mensagem)}</div>
          </div>
        </div>`;
    }
    const detalhes = [`${it.criadas} questão(ões) importada(s)`];
    if (it.duplicadas) detalhes.push(`${it.duplicadas} já existente(s) no banco (ignorada${it.duplicadas > 1 ? 's' : ''})`);
    if (it.erros) detalhes.push(`${it.erros} com erro (ver console)`);
    return `
      <div class="bmf-resultado-item">
        ${ICONS.sucesso}
        <div>
          <div class="bmf-resultado-item-titulo">${esc(it.categoria)}</div>
          <div class="bmf-resultado-item-detalhe">${esc(detalhes.join(' · '))}</div>
          <div class="bmf-resultado-item-arquivo">${esc(it.arquivo)}</div>
        </div>
      </div>`;
  }).join('');

  const resumoPartes = [];
  resumoPartes.push(totalCriadas ? `${totalCriadas} nova(s), aguardando revisão` : 'Nenhuma questão nova importada');
  if (totalDuplicadas) resumoPartes.push(`${totalDuplicadas} já existia(m) no banco e foi(ram) ignorada(s)`);
  if (totalErros) resumoPartes.push(`${totalErros} com erro`);
  document.getElementById('bmf-resultado-importacao-resumo').textContent = resumoPartes.join(' · ') + '.';

  document.getElementById('bmf-modal-resultado-importacao').classList.add('active');
}

function fecharModalResultadoImportacao(irParaRevisao) {
  document.getElementById('bmf-modal-resultado-importacao').classList.remove('active');
  if (irParaRevisao) document.querySelector('.bmf-tab-btn[data-tab="revisao"]')?.click();
}

// ================================================================
//  RENDER: REVISÃO DE IMPORTAÇÃO
// ================================================================
function lotesPendentes() {
  const porLote = new Map();
  questoesRevisao.forEach(q => {
    if (!porLote.has(q.loteId)) porLote.set(q.loteId, { loteId: q.loteId, categoriaSugeridaTexto: q.categoriaSugeridaTexto, questoes: [] });
    porLote.get(q.loteId).questoes.push(q);
  });
  return [...porLote.values()];
}

function renderRevisao() {
  const lotes = lotesPendentes();
  const lista = document.getElementById('bmf-revisao-lista');
  const vazio = document.getElementById('bmf-revisao-vazio');
  const badge = document.getElementById('bmf-revisao-badge');

  badge.classList.toggle('hidden', lotes.length === 0);
  badge.textContent = String(lotes.length);
  vazio.classList.toggle('hidden', lotes.length > 0);
  lista.innerHTML = '';

  lotes.forEach(lote => {
    const grupo = document.createElement('div');
    grupo.className = 'bmf-revisao-grupo';
    const sugestao = sugerirCategoria(lote.categoriaSugeridaTexto);
    grupo.innerHTML = `
      <div class="bmf-revisao-cabecalho">
        <h4>${lote.questoes.length} questão(ões) importada(s)</h4>
        <p class="bmf-q-meta">Vieram do arquivo do AVA como <strong>"${esc(lote.categoriaSugeridaTexto || '(sem categoria identificada)')}"</strong></p>
      </div>

      <div class="bmf-revisao-lista-titulos">
        ${lote.questoes.map((q, i) => `<div>${i + 1}. ${esc(q.titulo)}</div>`).join('')}
      </div>

      <div class="bmf-revisao-instrucao">
        <strong>1.</strong> Confira/ajuste a disciplina abaixo (${sugestao ? 'já veio sugerida com base no nome do arquivo' : 'não consegui adivinhar, selecione manualmente'}).
        <strong>2.</strong> Clique em "Confirmar Disciplina" — só depois disso as questões entram no banco compartilhado.
      </div>

      <div class="bmf-revisao-acoes">
        <div>
          <label class="form-label" style="font-size:0.75rem;">Período</label>
          <select class="form-control bmf-revisao-periodo"><option value="">Período</option></select>
        </div>
        <div>
          <label class="form-label" style="font-size:0.75rem;">Disciplina</label>
          <select class="form-control bmf-revisao-categoria"><option value="">Selecione o período primeiro</option></select>
        </div>
        <button type="button" class="btn btn-primary bmf-btn-confirmar-lote action-execute">Confirmar Disciplina</button>
      </div>
      <button type="button" class="bmf-revisao-descartar bmf-btn-descartar-lote action-execute">Descartar este lote</button>
    `;
    lista.appendChild(grupo);

    const selPeriodo = grupo.querySelector('.bmf-revisao-periodo');
    const selCategoria = grupo.querySelector('.bmf-revisao-categoria');
    for (let p = 1; p <= 12; p++) {
      const opt = document.createElement('option');
      opt.value = String(p);
      opt.textContent = `${ordinal(p)} Período`;
      selPeriodo.appendChild(opt);
    }
    if (sugestao) {
      selPeriodo.value = String(sugestao.periodo);
      popularDisciplinasEmSelect(selCategoria, sugestao.periodo, sugestao.id);
    }
    selPeriodo.addEventListener('change', () => popularDisciplinasEmSelect(selCategoria, selPeriodo.value));

    grupo.querySelector('.bmf-btn-confirmar-lote').addEventListener('click', async () => {
      const categoriaId = selCategoria.value;
      if (!categoriaId) { alert('Selecione a disciplina antes de confirmar.'); return; }
      try {
        await apiFetch(`/banco-med-fatec/questoes/lote/${lote.loteId}/resolver`, {
          method: 'PUT',
          body: JSON.stringify({ categoriaId })
        });
        await carregarTudo();
      } catch (err) {
        alert('Erro ao confirmar: ' + err.message);
      }
    });

    grupo.querySelector('.bmf-btn-descartar-lote').addEventListener('click', async () => {
      if (!confirm(`Descartar as ${lote.questoes.length} questões deste lote? Essa ação não pode ser desfeita.`)) return;
      try {
        await apiFetch(`/banco-med-fatec/questoes/lote/${lote.loteId}`, { method: 'DELETE' });
        await carregarTudo();
      } catch (err) {
        alert('Erro ao descartar: ' + err.message);
      }
    });
  });
}

// Igual a popularDisciplinasDoPeriodo, mas recebendo o <select> direto (os
// cards de revisão são criados dinamicamente, sem id fixo por elemento).
function popularDisciplinasEmSelect(sel, periodo, valorParaSelecionar) {
  sel.innerHTML = '';
  if (!periodo) { sel.innerHTML = '<option value="">Selecione o período primeiro</option>'; return; }
  const daPeriodo = categorias.filter(c => String(c.periodo) === String(periodo));
  if (!daPeriodo.length) { sel.innerHTML = '<option value="" disabled selected>Nenhuma disciplina cadastrada neste período</option>'; return; }
  daPeriodo.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.nomeBreve ? `${c.nome} (${c.nomeBreve})` : c.nome;
    sel.appendChild(opt);
  });
  if (valorParaSelecionar && daPeriodo.some(c => c.id === valorParaSelecionar)) sel.value = valorParaSelecionar;
}

// ================================================================
//  EVENTOS
// ================================================================
// Fecha o modal aberto no momento com a tecla Esc — mapeia cada overlay pro
// fechamento certo (alguns limpam estado, tipo provaEmEdicao/imagemAtual).
function fecharModalAtivoComEsc() {
  const mapa = [
    ['bmf-modal-questao', fecharModalQuestao],
    ['bmf-modal-prova-novo', fecharModalNovaProva],
    ['bmf-modal-prova-montar', fecharModalMontarProva],
    ['bmf-modal-adicionar-prova', fecharModalAdicionarProva],
    ['bmf-modal-resultado-importacao', () => fecharModalResultadoImportacao(false)],
    ['bmf-modal-relatorio', fecharModalRelatorio]
  ];
  for (const [id, fechar] of mapa) {
    const modal = document.getElementById(id);
    if (modal && modal.classList.contains('active')) { fechar(); return; }
  }
}

// Relatório do banco: período/disciplina/total de questões — reaproveita o
// totalQuestoes que o GET /categorias já traz (count() agregado no
// servidor), sem precisar de outra ida ao Firestore. A tabela por professor
// já vem pronta do servidor (count() agregado por criadoPor).
function abrirModalRelatorio() {
  const corpo = document.getElementById('bmf-relatorio-corpo');
  const total = categorias.reduce((acc, c) => acc + (c.totalQuestoes || 0), 0);
  document.getElementById('bmf-relatorio-resumo').textContent =
    `${total} questão(ões) publicada(s) no banco, em ${categorias.length} disciplina(s) cadastrada(s).`;

  corpo.innerHTML = categorias.length
    ? categorias.map(c => `
        <tr>
          <td>${ordinal(c.periodo)}</td>
          <td>${esc(c.nome)}</td>
          <td>${c.totalQuestoes || 0}</td>
        </tr>`).join('') + `<tr class="bmf-relatorio-total"><td colspan="2">Total</td><td>${total}</td></tr>`
    : '<tr class="bmf-relatorio-vazia"><td colspan="3">Nenhuma disciplina cadastrada ainda.</td></tr>';

  document.getElementById('bmf-modal-relatorio').classList.add('active');
  // Quebra por professor é coisa de coordenação/ADM (ver podeVerAutoria) —
  // pro professor comum o bloco nem aparece (o endpoint responde 403 mesmo).
  document.getElementById('bmf-relatorio-professor-bloco').classList.toggle('hidden', !podeVerAutoria());
  if (podeVerAutoria()) carregarRelatorioProfessor();
}

async function carregarRelatorioProfessor() {
  const corpoProf = document.getElementById('bmf-relatorio-professor-corpo');
  corpoProf.innerHTML = '<tr><td colspan="2">Carregando…</td></tr>';
  try {
    const contagem = await apiFetch('/banco-med-fatec/questoes/contagem-professor');
    corpoProf.innerHTML = contagem.length
      ? contagem.map(p => `<tr><td>${esc(p.nome)}</td><td>${p.total}</td></tr>`).join('')
      : '<tr class="bmf-relatorio-vazia"><td colspan="2">Nenhum professor cadastrado ainda.</td></tr>';
  } catch (err) {
    corpoProf.innerHTML = '<tr class="bmf-relatorio-vazia"><td colspan="2">Não deu pra carregar agora.</td></tr>';
    console.error(err);
  }
}
function fecharModalRelatorio() {
  document.getElementById('bmf-modal-relatorio').classList.remove('active');
}

function bindEventos() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fecharModalAtivoComEsc();
  });

  document.querySelectorAll('.bmf-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bmf-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.getElementById('bmf-view-banco').classList.toggle('hidden', tab !== 'banco');
      document.getElementById('bmf-view-provas').classList.toggle('hidden', tab !== 'provas');
      document.getElementById('bmf-view-revisao').classList.toggle('hidden', tab !== 'revisao');
      document.getElementById('bmf-view-colinha').classList.toggle('hidden', tab !== 'colinha');
      if (tab === 'colinha') carregarContagemAreaEnamed();
    });
  });

  document.getElementById('bmf-filtro-periodo').addEventListener('change', async () => {
    popularSelectsCategoria();
    await atualizarListaQuestoes();
  });
  document.getElementById('bmf-filtro-area-enamed').addEventListener('change', atualizarListaQuestoes);
  document.getElementById('bmf-filtro-categoria').addEventListener('change', renderQuestoes);
  document.getElementById('bmf-filtro-dificuldade').addEventListener('change', atualizarListaQuestoes);
  document.getElementById('bmf-filtro-professor').addEventListener('change', atualizarListaQuestoes);
  let debounceBusca;
  document.getElementById('bmf-filtro-busca').addEventListener('input', () => {
    clearTimeout(debounceBusca);
    debounceBusca = setTimeout(atualizarListaQuestoes, 350);
  });

  document.getElementById('bmf-btn-nova-questao').addEventListener('click', () => abrirModalQuestao(null));
  document.getElementById('bmf-btn-importar-ava').addEventListener('click', () => {
    document.getElementById('bmf-importar-ava-input').click();
  });
  document.getElementById('bmf-importar-ava-input').addEventListener('change', async (e) => {
    const arquivos = e.target.files;
    if (!arquivos.length) return;
    const btn = document.getElementById('bmf-btn-importar-ava');
    btn.disabled = true;
    btn.textContent = 'Importando...';
    try {
      await importarArquivosAva(arquivos);
    } finally {
      btn.disabled = false;
      btn.textContent = '⬆ Importar do AVA';
      e.target.value = '';
    }
  });
  document.getElementById('bmf-btn-cancelar-questao').addEventListener('click', fecharModalQuestao);

  // Barra de ferramentas do editor (negrito/itálico/lista) — mousedown com
  // preventDefault pra não perder a seleção de texto antes do execCommand rodar.
  document.querySelectorAll('.bmf-rte-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const alvoId = btn.closest('.bmf-rte-toolbar').dataset.alvo;
      document.getElementById(alvoId).focus();
      document.execCommand(btn.dataset.cmd, false, null);
    });
  });
  document.getElementById('bmf-form-questao').addEventListener('submit', salvarQuestao);
  document.getElementById('bmf-q-periodo').addEventListener('change', (e) => {
    popularDisciplinasDoPeriodo('bmf-q-categoria', e.target.value);
  });
  document.getElementById('bmf-p-periodo').addEventListener('change', (e) => {
    popularDisciplinasDoPeriodo('bmf-p-categoria', e.target.value);
  });
  document.getElementById('bmf-q-tipo').addEventListener('change', ajustarEditorPorTipo);
  document.getElementById('bmf-btn-add-alternativa').addEventListener('click', () => {
    const tipoRadio = document.getElementById('bmf-q-tipo').value === 'multichoice_unica';
    document.getElementById('bmf-alternativas-lista').appendChild(novaLinhaAlternativa('', false, tipoRadio));
  });

  document.getElementById('bmf-btn-add-categoria').addEventListener('click', () => {
    document.getElementById('bmf-nova-categoria-group').classList.toggle('hidden');
  });
  document.getElementById('bmf-btn-cancelar-categoria').addEventListener('click', () => {
    document.getElementById('bmf-nova-categoria-group').classList.add('hidden');
  });
  document.getElementById('bmf-btn-salvar-categoria').addEventListener('click', async () => {
    const nome = document.getElementById('bmf-q-categoria-nova').value.trim();
    const periodo = parseInt(document.getElementById('bmf-q-categoria-nova-periodo').value, 10);
    if (!nome) return;
    if (!periodo) { alert('Selecione o período da disciplina.'); return; }
    try {
      const resp = await apiFetch('/banco-med-fatec/categorias', { method: 'POST', body: JSON.stringify({ nome, periodo }) });
      categorias.push({ id: resp.id, nome, periodo });
      popularSelectsCategoria();
      // A disciplina nova nasce no período que acabou de ser escolhido —
      // reflete isso no seletor de período/disciplina do formulário da questão.
      document.getElementById('bmf-q-periodo').value = String(periodo);
      popularDisciplinasDoPeriodo('bmf-q-categoria', periodo, resp.id);
      document.getElementById('bmf-q-categoria-nova').value = '';
      document.getElementById('bmf-q-categoria-nova-periodo').value = '';
      document.getElementById('bmf-nova-categoria-group').classList.add('hidden');
    } catch (err) {
      alert('Erro ao criar disciplina: ' + err.message);
    }
  });

  document.getElementById('bmf-q-imagem-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await comprimirImagem(file);
      imagemAtual = { nome: file.name.replace(/\.[^.]+$/, ''), dataUrl };
      document.getElementById('bmf-q-imagem-img').src = dataUrl;
      document.getElementById('bmf-q-imagem-preview').classList.remove('hidden');
      document.getElementById('bmf-q-imagem-nome').textContent = file.name;
    } catch (err) {
      alert('Erro ao processar imagem: ' + err.message);
    }
  });
  document.getElementById('bmf-btn-remover-imagem').addEventListener('click', () => {
    imagemAtual = null;
    document.getElementById('bmf-q-imagem-input').value = '';
    document.getElementById('bmf-q-imagem-preview').classList.add('hidden');
    document.getElementById('bmf-q-imagem-nome').textContent = 'Escolher imagem…';
  });

  document.getElementById('bmf-prova-filtro-periodo').addEventListener('change', renderProvas);
  document.getElementById('bmf-btn-nova-prova').addEventListener('click', () => abrirModalNovaProva());
  document.getElementById('bmf-btn-limpar-selecao').addEventListener('click', () => {
    questoesSelecionadas.clear();
    renderQuestoes();
  });
  document.getElementById('bmf-btn-adicionar-prova').addEventListener('click', abrirModalAdicionarProva);
  document.getElementById('bmf-btn-fechar-adicionar-prova').addEventListener('click', fecharModalAdicionarProva);
  document.getElementById('bmf-btn-cancelar-prova-novo').addEventListener('click', fecharModalNovaProva);
  document.getElementById('bmf-form-prova-novo').addEventListener('submit', criarProva);
  document.querySelectorAll('.bmf-tipo-prova-btn').forEach(btn => {
    btn.addEventListener('click', () => selecionarTipoProva(btn.dataset.tipo));
  });

  document.getElementById('bmf-prova-busca').addEventListener('input', renderListaSelecaoQuestoes);
  document.getElementById('bmf-prova-selecionar-todas').addEventListener('click', () => selecionarTodasVisiveis(true));
  document.getElementById('bmf-prova-desmarcar-todas').addEventListener('click', () => selecionarTodasVisiveis(false));
  document.getElementById('bmf-prova-selecionar-qtd').addEventListener('click', () => {
    const qtd = parseInt(document.getElementById('bmf-prova-qtd-input').value, 10);
    if (!qtd || qtd < 1) { alert('Informe uma quantidade válida.'); return; }
    selecionarQuantidadeAleatoria(qtd);
  });
  document.getElementById('bmf-btn-fechar-montar').addEventListener('click', fecharModalMontarProva);
  document.getElementById('bmf-btn-salvar-selecao').addEventListener('click', salvarSelecaoProva);
  document.getElementById('bmf-btn-exportar-prova').addEventListener('click', exportarProva);
  document.getElementById('bmf-btn-excluir-prova').addEventListener('click', excluirProva);

  document.getElementById('bmf-btn-fechar-resultado-importacao').addEventListener('click', () => fecharModalResultadoImportacao(false));
  document.getElementById('bmf-btn-ir-revisao-resultado').addEventListener('click', () => fecharModalResultadoImportacao(true));

  document.getElementById('bmf-btn-relatorio').addEventListener('click', abrirModalRelatorio);
  document.getElementById('bmf-btn-fechar-relatorio').addEventListener('click', fecharModalRelatorio);
}

// ================================================================
//  AUTH GUARD (mesmo padrão dos demais módulos do Órbita)
// ================================================================
let appInitialized = false;
let initializedRole = null;

async function initApp(user, role) {
  if (appInitialized && initializedRole === role) return;
  appInitialized = true;
  initializedRole = role;
  currentRole = role;

  const guard = document.getElementById('auth-guard');
  if (guard) guard.classList.add('hidden');

  setupLayout(user, role, 'banco-med-fatec', async () => {
    clearCachedAuth();
    await signOut(auth);
    window.location.href = '../auth/login.html';
  });

  bindEventos();
  popularSelectsPeriodo();
  popularSelectsAreaEnamed();
  ajustarEditorPorTipo();
  // Busca por autor não faz sentido pra quem não vê autoria (o campo nem
  // vem na resposta) — placeholder deixa isso explícito em vez de prometer
  // uma busca que não funciona.
  if (!podeVerAutoria()) {
    document.getElementById('bmf-filtro-busca').placeholder = 'Buscar por título...';
  }
  await carregarTudo();
}

const cached = getCachedAuth();
if (cached) {
  currentUser = cached.user;
  initApp(cached.user, cached.role);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    clearCachedAuth();
    window.location.href = '../auth/login.html';
    return;
  }

  currentUser = user;

  let role = 'visitante';
  let meuOverrides = null;
  try {
    const userData = await apiFetch('/usuarios/me');
    role = userData.role || 'visitante';
    meuOverrides = userData.permissoes || null;
  } catch (err) {
    role = cached ? cached.role : 'visitante';
  }

  let userLevel = 1;
  try {
    const allPerms = await apiFetch('/usuarios/config/permissions');
    userLevel = getEffectiveLevel(allPerms[role] || {}, meuOverrides, 'banco-med-fatec');
  } catch (err) {
    // Falha silenciosa por segurança — sem permissão confirmada, não libera.
  }

  const token = await user.getIdToken();
  setCachedAuth(user, role, token);

  if (role !== 'adm_l1' && userLevel < 2) {
    window.location.href = '../meu-espaco/index.html';
    return;
  }
  if (role !== 'adm_l1' && userLevel < 3) {
    document.body.classList.add('hide-execute');
  }

  if (!appInitialized || initializedRole !== role) {
    initApp(user, role);
  }
});
