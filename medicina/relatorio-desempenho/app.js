// ================================================================
//  ÓRBITA — MÓDULO RELATÓRIO DESEMPENHO (Medicina)
//  Análise psicométrica das provas do AVA: o docente sobe o export de
//  "Estatísticas do questionário" (CSV, Excel ou PDF) e recebe o relatório
//  de facilidade × discriminação por questão, pronto pra imprimir.
//
//  A conta e a leitura do arquivo ficam no servidor
//  (src/utils/parseEstatisticasAva.js) — aqui é só tela.
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";
import { getEffectiveLevel } from "../../core/permissions.js";
import {
  montarRelatorioHTML, identificacaoTurma, CORES_HEX, pct, dataCurta
} from "./relatorio-render.js?v=5";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';

const MODULO = 'relatorio-desempenho';

let currentUser = null;
let currentRole = null;
let appInitialized = false;
let initializedRole = null;

const TITULO_PAGINA = document.title;

let relatorios = [];
let relatorioAtual = null;
let categorias = [];

// ---------------- API ----------------

async function apiFetch(endpoint, options = {}) {
  let token = '';
  if (currentUser && typeof currentUser.getIdToken === 'function') token = await currentUser.getIdToken();
  else if (auth.currentUser) token = await auth.currentUser.getIdToken();

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    let msg = `Erro na API: ${res.status}`;
    try { const body = await res.json(); if (body.error) msg = body.error; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------------- Tela: lista ----------------

const el = id => document.getElementById(id);

// Turma "T.1", "T.2"... — vem do campo turma ou, nos relatórios antigos, do
// "2026.2 - T.3 - 2° PER - ..." que o AVA manda no nome do curso.
function turmaDe(r) {
  const m = `${r.turma || ''} ${r.cursoTurma || ''}`.match(/\bT\s*\.?\s*(\d+)\b/i);
  return m ? `T.${m[1]}` : '';
}

function relatorioVisivel(r) {
  const disc = el('rd-filtro-disciplina').value;
  const sem = el('rd-filtro-semestre').value;
  const turma = el('rd-filtro-turma').value;
  const busca = el('rd-filtro-busca').value.trim().toLowerCase();

  if (disc && (r.disciplina || '') !== disc) return false;
  if (sem && (r.semestre || '') !== sem) return false;
  if (turma && turmaDe(r) !== turma) return false;
  if (busca) {
    const alvo = `${r.titulo || ''} ${r.cursoTurma || ''} ${r.turma || ''} ${r.disciplina || ''} ${r.professor || ''}`.toLowerCase();
    if (!alvo.includes(busca)) return false;
  }
  return true;
}

function renderLista() {
  const alvo = el('rd-lista');
  const visiveis = relatorios.filter(relatorioVisivel);

  if (!visiveis.length) {
    const vazioPorFiltro = relatorios.length > 0;
    alvo.innerHTML = `
      <div class="rd-vazio">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>
        <h3>${vazioPorFiltro ? 'Nenhum relatório com esses filtros' : 'Nenhum relatório ainda'}</h3>
        <p>${vazioPorFiltro
          ? 'Ajuste a disciplina, o semestre ou a busca.'
          : 'Exporte as Estatísticas do questionário no AVA e clique em “Novo Relatório”.'}</p>
      </div>`;
    return;
  }

  // Separado por turma (T.1 / T.2 / T.3...), cada grupo com seu cabeçalho;
  // relatório sem turma identificada fica por último.
  const grupos = new Map();
  visiveis.forEach(r => {
    const t = turmaDe(r) || 'Sem turma';
    if (!grupos.has(t)) grupos.set(t, []);
    grupos.get(t).push(r);
  });
  const ordem = [...grupos.keys()].sort((a, b) =>
    (a === 'Sem turma') - (b === 'Sem turma') || a.localeCompare(b, 'pt-BR', { numeric: true }));

  alvo.innerHTML = ordem.map(t => `
    <div class="rd-grupo-turma">${esc(t === 'Sem turma' ? t : `Turma ${t}`)}
      <span>${grupos.get(t).length} relatório${grupos.get(t).length === 1 ? '' : 's'}</span>
    </div>` + grupos.get(t).map(linhaRelatorio).join('')).join('');
}

function linhaRelatorio(r) {
  const resumo = r.resumo || {};
  const revisar = resumo.paraRevisar || 0;
  const meta = [
    r.disciplina || r.cursoTurma,
    r.turma,
    r.semestre,
    dataCurta(r.aplicacao),
    r.nAlunos ? `${r.nAlunos} alunos` : null,
    podeVerAutoria() && r.criadoPorNome ? r.criadoPorNome : null
  ].filter(Boolean).join(' · ');

  return `
    <div class="rd-row" data-id="${esc(r.id)}">
      <div class="rd-row-corpo">
        <div class="rd-row-badges">
          <span class="badge badge-neutro">${resumo.total || 0} questões</span>
          <span class="badge" style="background:${CORES_HEX['Excelente']}">disc. ${pct(resumo.discriminacaoMedia, 1)}</span>
          ${revisar ? `<span class="badge badge-alerta">${revisar} para revisar</span>` : ''}
        </div>
        <div class="rd-row-titulo">${esc(r.titulo || 'Avaliação sem título')}</div>
        <div class="rd-row-meta">${esc(meta)}</div>
      </div>
      <div class="rd-row-acoes">
        <button class="rd-icon-btn" data-acao="abrir" data-id="${esc(r.id)}" title="Abrir relatório">
          <svg class="rd-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="rd-icon-btn perigo action-execute" data-acao="excluir" data-id="${esc(r.id)}" title="Excluir relatório">
          <svg class="rd-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>`;
}

function podeVerAutoria() {
  return currentRole === 'adm_l1' || currentRole === 'coord_medicina';
}

function preencherFiltros() {
  const disciplinas = [...new Set(relatorios.map(r => r.disciplina).filter(Boolean))].sort();
  const semestres = [...new Set(relatorios.map(r => r.semestre).filter(Boolean))].sort().reverse();
  const turmas = [...new Set(relatorios.map(turmaDe).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));

  const encher = (id, valores, rotuloTodos) => {
    const sel = el(id);
    const atual = sel.value;
    sel.innerHTML = `<option value="">${rotuloTodos}</option>` +
      valores.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (valores.includes(atual)) sel.value = atual;
  };
  encher('rd-filtro-disciplina', disciplinas, 'Todas as disciplinas');
  encher('rd-filtro-semestre', semestres, 'Todos os semestres');
  encher('rd-filtro-turma', turmas, 'Todas as turmas');
}

async function carregarLista() {
  relatorios = await apiFetch(`/${MODULO}`);
  preencherFiltros();
  renderLista();
}

// ---------------- Modais ----------------

function fecharModal() { el('rd-modais').innerHTML = ''; }

function abrirModal(html) {
  el('rd-modais').innerHTML = `<div class="modal-overlay">${html}</div>`;
  el('rd-modais').querySelector('.modal-overlay').addEventListener('click', e => {
    if (e.target.classList.contains('modal-overlay')) fecharModal();
  });
}

function modalAjuda() {
  abrirModal(`
    <div class="modal-box">
      <h3>Onde pegar o arquivo no AVA</h3>
      <p class="modal-sub">O relatório é montado em cima do export oficial de estatísticas do questionário — nada é digitado à mão.</p>
      <ol style="font-size:0.85rem; line-height:1.85; padding-left:1.1rem; margin:0 0 1rem;">
        <li>Abra o questionário no AVA.</li>
        <li>Menu do questionário → <b>Resultados</b> → <b>Estatísticas</b>.</li>
        <li>Desça até <b>Baixar dados da tabela como</b> e escolha <b>.csv</b>.</li>
        <li>Suba esse arquivo aqui.</li>
      </ol>
      <p class="modal-sub" style="margin-bottom:0;">O <b>CSV é o formato mais confiável</b>. Excel também serve. O PDF funciona, mas
        depende de como o AVA quebrou as linhas na impressão — e o detalhamento por alternativa costuma vir incompleto.</p>
      <div class="modal-acoes">
        <button class="btn btn-primary" id="rd-ajuda-ok">Entendi</button>
      </div>
    </div>`);
  el('rd-ajuda-ok').onclick = fecharModal;
}

function modalNovo() {
  const anoAtual = new Date().getFullYear();
  const opcoesSemestre = [];
  for (let a = anoAtual + 1; a >= anoAtual - 3; a--) { opcoesSemestre.push(`${a}.2`); opcoesSemestre.push(`${a}.1`); }

  const opcoesDisciplina = categorias.length
    ? `<select id="rd-novo-disciplina">
         <option value="">— selecione —</option>
         ${categorias.map(c => `<option value="${esc(c.nome || c.disciplina || '')}" data-id="${esc(c.id)}" data-periodo="${esc(c.periodo || '')}">${esc(c.nome || c.disciplina || '')}${c.periodo ? ` (${esc(String(c.periodo))}º)` : ''}</option>`).join('')}
       </select>`
    : `<input type="text" id="rd-novo-disciplina" placeholder="Ex.: Sistemas Morfofisiológicos III">`;

  abrirModal(`
    <div class="modal-box">
      <h3>Novo relatório de desempenho</h3>
      <p class="modal-sub">Suba o export de <b>Estatísticas do questionário</b> do AVA. O que você preencher aqui vale mais que o que vier no arquivo.</p>

      <div id="rd-erro-box"></div>
      <div id="rd-previa-box"></div>

      <div class="rd-dropzone" id="rd-dropzone">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M6 10l6-6 6 6"/><path d="M4 20h16"/></svg>
        <p id="rd-dropzone-txt">Clique para escolher ou arraste o arquivo aqui</p>
        <small>.csv · .xlsx · .pdf</small>
      </div>
      <input type="file" id="rd-arquivo" accept=".csv,.tsv,.txt,.xlsx,.xls,.pdf" class="hidden">

      <div class="campo">
        <label for="rd-novo-titulo">Título da avaliação</label>
        <input type="text" id="rd-novo-titulo" placeholder="Deixe vazio para usar o nome que vem do AVA">
      </div>
      <div class="campo">
        <label for="rd-novo-disciplina">Disciplina</label>
        ${opcoesDisciplina}
      </div>
      <div class="campo campo-duplo">
        <div>
          <label for="rd-novo-turma">Turma</label>
          <input type="text" id="rd-novo-turma" placeholder="Ex.: T.2 - 3º PER">
        </div>
        <div>
          <label for="rd-novo-semestre">Semestre</label>
          <select id="rd-novo-semestre">
            <option value="">— nenhum —</option>
            ${opcoesSemestre.map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="campo">
        <label for="rd-novo-professor">Professor(a) responsável</label>
        <input type="text" id="rd-novo-professor" placeholder="Opcional">
      </div>

      <div class="modal-acoes">
        <button class="btn btn-secondary" id="rd-novo-cancelar">Cancelar</button>
        <button class="btn btn-primary" id="rd-novo-gerar">Gerar relatório</button>
      </div>
    </div>`);

  const inputArquivo = el('rd-arquivo');
  const zona = el('rd-dropzone');

  const mostrarArquivo = () => {
    const f = inputArquivo.files && inputArquivo.files[0];
    if (!f) return;
    zona.classList.add('tem-arquivo');
    el('rd-dropzone-txt').textContent = f.name;
    preencherPeloArquivo(f);
  };

  zona.onclick = () => inputArquivo.click();
  inputArquivo.onchange = mostrarArquivo;
  zona.addEventListener('dragover', e => { e.preventDefault(); zona.classList.add('ativo'); });
  zona.addEventListener('dragleave', () => zona.classList.remove('ativo'));
  zona.addEventListener('drop', e => {
    e.preventDefault();
    zona.classList.remove('ativo');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      inputArquivo.files = e.dataTransfer.files;
      mostrarArquivo();
    }
  });

  el('rd-novo-cancelar').onclick = fecharModal;
  el('rd-novo-gerar').onclick = gerarRelatorio;
}

// Normaliza nome de disciplina pra comparar "MEDICINA BASEADAS EM EVIDÊNCIAS
// II" com "Medicina Baseada em Evidências II": sem acento, sem caixa, sem
// palavrinha de ligação e sem plural simples.
function tokensDisciplina(nome) {
  const PARADAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o']);
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t && !PARADAS.has(t))
    .map(t => t.length > 3 ? t.replace(/s$/, '') : t);
}

function acharDisciplina(nome, periodo) {
  const alvo = tokensDisciplina(nome);
  if (!alvo.length) return null;
  let melhor = null, melhorNota = 0;
  categorias.forEach(c => {
    const t = tokensDisciplina(c.nome || c.disciplina);
    if (!t.length) return;
    const comuns = t.filter(x => alvo.includes(x)).length;
    let nota = comuns / Math.max(t.length, alvo.length);
    if (periodo && Number(c.periodo) === Number(periodo)) nota += 0.05; // desempate pelo período
    if (nota > melhorNota) { melhorNota = nota; melhor = c; }
  });
  return melhorNota >= 0.6 ? melhor : null;
}

// Lê o arquivo no servidor SEM gravar e preenche o formulário com o que vem
// no cabeçalho do export — o professor só confere e gera (25/09).
async function preencherPeloArquivo(arquivo) {
  const box = el('rd-previa-box');
  if (!box) return;
  el('rd-erro-box').innerHTML = '';
  box.innerHTML = '<div class="rd-previa">Lendo o arquivo...</div>';
  try {
    const p = await apiFetch(`/${MODULO}/previa`, {
      method: 'POST',
      body: JSON.stringify({ nomeArquivo: arquivo.name, arquivoBase64: await lerArquivoBase64(arquivo) })
    });
    const s = p.sugestao || {};
    const avisosCampos = [];

    if (s.titulo && !el('rd-novo-titulo').value.trim()) el('rd-novo-titulo').value = s.titulo;
    if (s.turma) el('rd-novo-turma').value = s.turma;
    if (s.semestre) {
      const sel = el('rd-novo-semestre');
      if (![...sel.options].some(o => o.value === s.semestre)) sel.add(new Option(s.semestre, s.semestre));
      sel.value = s.semestre;
    }
    const campoDisc = el('rd-novo-disciplina');
    if (s.disciplina) {
      if (campoDisc.tagName === 'SELECT') {
        const achada = acharDisciplina(s.disciplina, s.periodo);
        const opcao = achada && [...campoDisc.options].find(o => o.dataset.id === String(achada.id));
        if (opcao) campoDisc.value = opcao.value;
        else avisosCampos.push(`Não achei “${s.disciplina}” na lista de disciplinas — escolha manualmente.`);
      } else {
        campoDisc.value = s.disciplina;
      }
    }

    const aplicada = p.aplicacao ? ` · aplicada em ${dataCurta(p.aplicacao)}` : '';
    const alternativas = p.comAlternativas < p.totalQuestoes
      ? ` · <b>alternativas em ${p.comAlternativas} de ${p.totalQuestoes}</b>` : '';
    const avisos = [...(p.avisos || []), ...avisosCampos];
    box.innerHTML = `
      <div class="rd-previa">
        ✓ <b>${p.totalQuestoes} questões</b>${p.nAlunos != null ? ` · ${p.nAlunos} alunos` : ''}${aplicada}${alternativas}<br>
        Preenchi os campos abaixo com o que veio no arquivo${s.cursoTurma ? ` (<i>${esc(s.cursoTurma)}</i>)` : ''} — confira e clique em “Gerar relatório”.
      </div>
      ${avisos.length ? `<div class="rd-erro">⚠ ${avisos.map(esc).join('<br>')}</div>` : ''}`;
  } catch (err) {
    box.innerHTML = '';
    mostrarErro(err.message);
  }
}

function mostrarErro(msg) {
  const box = el('rd-erro-box');
  if (box) box.innerHTML = `<div class="rd-erro">${esc(msg)}</div>`;
}

function lerArquivoBase64(file) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(String(leitor.result).replace(/^data:[^;]*;base64,/, ''));
    leitor.onerror = () => reject(new Error('Não consegui ler o arquivo.'));
    leitor.readAsDataURL(file);
  });
}

async function gerarRelatorio() {
  const botao = el('rd-novo-gerar');
  const arquivo = el('rd-arquivo').files && el('rd-arquivo').files[0];
  if (!arquivo) return mostrarErro('Escolha o arquivo exportado do AVA.');

  const seletorDisc = el('rd-novo-disciplina');
  const opcaoDisc = seletorDisc.tagName === 'SELECT' ? seletorDisc.selectedOptions[0] : null;

  botao.disabled = true;
  botao.textContent = 'Processando...';
  try {
    const payload = {
      nomeArquivo: arquivo.name,
      arquivoBase64: await lerArquivoBase64(arquivo),
      titulo: el('rd-novo-titulo').value.trim(),
      disciplina: seletorDisc.value.trim(),
      disciplinaId: opcaoDisc ? (opcaoDisc.dataset.id || null) : null,
      periodo: opcaoDisc && opcaoDisc.dataset.periodo ? opcaoDisc.dataset.periodo : null,
      turma: el('rd-novo-turma').value.trim(),
      semestre: el('rd-novo-semestre').value,
      professor: el('rd-novo-professor').value.trim()
    };
    const doc = await apiFetch(`/${MODULO}`, { method: 'POST', body: JSON.stringify(payload) });
    fecharModal();
    await carregarLista();
    abrirRelatorio(doc);
  } catch (err) {
    mostrarErro(err.message);
    botao.disabled = false;
    botao.textContent = 'Gerar relatório';
  }
}

// Joga o documento montado na tela.
function aplicarRelatorio(r) {
  const { html, tituloToolbar, metaToolbar } = montarRelatorioHTML(r);
  el('rd-doc').innerHTML = html;
  el('rd-doc-toolbar-titulo').textContent = tituloToolbar;
  el('rd-doc-toolbar-meta').textContent = metaToolbar;
  // O navegador imprime o título da aba no topo da folha — vai com
  // disciplina e turma pra ninguém confundir as folhas de T.1/T.2/T.3.
  const id = identificacaoTurma(r);
  document.title = [id.disciplina, id.turma, r.titulo].filter(Boolean).join(' — ') || TITULO_PAGINA;
}

async function abrirRelatorio(rOuId) {
  try {
    relatorioAtual = typeof rOuId === 'string' ? await apiFetch(`/${MODULO}/${rOuId}`) : rOuId;
    aplicarRelatorio(relatorioAtual);
    el('rd-view-lista').classList.add('hidden');
    el('rd-view-relatorio').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (err) {
    alert(err.message);
  }
}

function voltarParaLista() {
  relatorioAtual = null;
  document.title = TITULO_PAGINA;
  el('rd-view-relatorio').classList.add('hidden');
  el('rd-view-lista').classList.remove('hidden');
}

async function salvarCabecalho() {
  if (!relatorioAtual) return;
  const botao = el('rd-btn-salvar-cabecalho');
  const dados = {};
  el('rd-doc').querySelectorAll('.editavel[data-campo]').forEach(n => {
    const valor = n.textContent.trim();
    dados[n.dataset.campo] = (valor === '—') ? '' : valor;
  });

  botao.disabled = true;
  try {
    const atualizado = await apiFetch(`/${MODULO}/${relatorioAtual.id}`, {
      method: 'PUT', body: JSON.stringify(dados)
    });
    relatorioAtual = { ...relatorioAtual, ...atualizado };
    await carregarLista();
    el('rd-doc-toolbar-titulo').textContent = relatorioAtual.titulo || 'Relatório';
  } catch (err) {
    alert(err.message);
  } finally {
    botao.disabled = false;
  }
}

async function excluirRelatorio(id) {
  const r = relatorios.find(x => x.id === id);
  if (!confirm(`Excluir o relatório "${r ? r.titulo : ''}"? Esta ação não pode ser desfeita.`)) return;
  try {
    await apiFetch(`/${MODULO}/${id}`, { method: 'DELETE' });
    await carregarLista();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------- Inicialização ----------------


// O anexo de alternativas é mais da metade das folhas (16 páginas contra 8
// numa prova de 45 questões). Quem só quer o panorama imprime sem ele. A
// classe sai logo depois pra não vazar pro que está na tela.
function imprimir(apenasResumo) {
  document.body.classList.toggle('rd-print-resumo', apenasResumo);
  window.print();
  setTimeout(() => document.body.classList.remove('rd-print-resumo'), 0);
}

function ligarEventos() {
  el('rd-btn-novo').onclick = modalNovo;
  el('rd-btn-ajuda').onclick = modalAjuda;
  el('rd-btn-voltar').onclick = voltarParaLista;
  el('rd-btn-imprimir').onclick = () => imprimir(false);
  el('rd-btn-imprimir-resumo').onclick = () => imprimir(true);
  el('rd-btn-salvar-cabecalho').onclick = salvarCabecalho;

  ['rd-filtro-disciplina', 'rd-filtro-semestre', 'rd-filtro-turma'].forEach(id => { el(id).onchange = renderLista; });
  el('rd-filtro-busca').oninput = renderLista;

  el('rd-lista').addEventListener('click', e => {
    const botao = e.target.closest('[data-acao]');
    if (botao) {
      e.stopPropagation();
      if (botao.dataset.acao === 'excluir') excluirRelatorio(botao.dataset.id);
      else abrirRelatorio(botao.dataset.id);
      return;
    }
    const linha = e.target.closest('.rd-row');
    if (linha) abrirRelatorio(linha.dataset.id);
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharModal(); });
}

async function initApp(user, role) {
  appInitialized = true;
  initializedRole = role;
  currentRole = role;

  setupLayout(user, role, MODULO, async () => {
    clearCachedAuth();
    const { signOut } = await import("https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js");
    await signOut(auth);
    window.location.href = '../../auth/login.html';
  });

  el('auth-guard').classList.add('hidden');
  el('app').classList.remove('hidden');

  ligarEventos();

  // As disciplinas vêm do BANCO MED-FATEC (currículo real da Medicina) pra
  // não virar campo livre que descola da estrutura acadêmica. Se o cargo não
  // tiver acesso àquele módulo, cai pro campo de texto — não trava a tela.
  try {
    categorias = await apiFetch('/banco-med-fatec/categorias');
  } catch (err) {
    categorias = [];
  }

  try {
    await carregarLista();
  } catch (err) {
    el('rd-lista').innerHTML = `<div class="rd-vazio"><h3>Não consegui carregar</h3><p>${esc(err.message)}</p></div>`;
  }
}

const cached = getCachedAuth();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    clearCachedAuth();
    window.location.href = '../../auth/login.html';
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
    userLevel = getEffectiveLevel(allPerms[role] || {}, meuOverrides, MODULO);
  } catch (err) {
    // Falha silenciosa por segurança — sem permissão confirmada, não libera.
  }

  const token = await user.getIdToken();
  setCachedAuth(user, role, token);

  if (role !== 'adm_l1' && userLevel < 2) {
    window.location.href = '../../meu-espaco/index.html';
    return;
  }
  if (role !== 'adm_l1' && userLevel < 3) {
    document.body.classList.add('hide-execute');
  }

  if (!appInitialized || initializedRole !== role) {
    initApp(user, role);
  }
});
