// ================================================================
//  ÓRBITA — TRILHA EAD (Docência)
//  O EAD importa o livro de notas do AVA (Open LMS) de cada disciplina/turma;
//  a tela mostra a participação em cada unidade de aprendizagem (SAGAH), os
//  rankings por curso e gera o arquivo Nome;Nota que o EAD lança no Edubox.
//
//  Regra da nota (19/10/2026): cada unidade com 100% de participação vale
//  0,5; abaixo de 100% ou "-" vale 0. UA 01–06 = 1º bimestre, UA 07–12 = 2º.
//  Nota do bimestre = soma (0 a 3.0). Mesma regra em src/utils/livroNotasAva.js.
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";
import { getEffectiveLevel } from "../../core/permissions.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.'))
  ? `http://${location.hostname}:3000/api`
  : '/api';

const MODULO = 'trilha-ead';
// Sem configuração no banco pro módulo: EAD/ADM N2 importam, coordenador só vê.
const NIVEL_PADRAO = { adm_l2: 3, ead: 3, coordenador: 2 };

const NOTA_UNIDADE = 0.5;
const UNIDADES_POR_BIMESTRE = 6;

const $ = id => document.getElementById(id);

let currentUser = null;
let appInitialized = false;
let initializedRole = null;
let podeImportar = false;

let cursos = [];
let turmas = [];          // turmas importadas no semestre escolhido (já no escopo do usuário)
let aba = 'turmas';
let turmaAberta = null;   // id da turma no detalhe
let cursoRankingAlunos = '';
let arquivoEscolhido = null;

// ---------------- regra da nota ----------------

const feita = v => v !== null && v !== undefined && v >= 99.995;
const bimestreDa = n => Math.ceil(n / UNIDADES_POR_BIMESTRE);
const notaBimestre = qtd => Math.round(qtd * NOTA_UNIDADE * 10) / 10;
const fmtNota = v => v.toFixed(1).replace('.', ',');
// Situação em Matrículas que significa que o aluno saiu — não tem diário pra lançar.
const SAIU = /tranc|cancel|desist|transfer|evas/i;

// "Direito · 3º período (DIREITO 3 - 2025/2) — tem a disciplina como DP"
// ou, sem turma ativa: "Trancou em Matrículas (ARQUITETURA URB., 6º) — não precisa lançar"
function ondeEstaTexto(onde, matricula) {
  if (!onde || !onde.length) {
    if (matricula && matricula.situacao) {
      return `sem turma ativa no Edubox; em Matrículas consta ${matricula.situacao} (${matricula.curso}${matricula.periodo ? `, ${matricula.periodo}` : ''})${SAIU.test(matricula.situacao) ? ' — não precisa lançar' : ''}`;
    }
    return 'não está em nenhuma turma ativa do Edubox nem em Matrículas neste semestre';
  }
  return onde.map(o => `${o.curso} · ${o.periodo}º período (${o.turma})${o.disciplina ? ` — tem a disciplina${o.dp ? ' como DP' : ''} nesse diário` : ''}`).join('; ');
}
// mesma normalização de nome do servidor (src/utils/trilhaDiarios.js)
const normNome = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const fmtPct = v => v === null || v === undefined ? '—' : `${v.toFixed(1).replace('.', ',')}%`;

// Só os alunos ativos da turma (no diário regular do Edubox) contam na
// participação; DP/adaptação, quem saiu e conta de professor ficam de fora.
// Sem diário encontrado, contam todos (não dá pra saber quem é da turma).
function alunosAtivos(t) {
  return (t.diarios || []).length ? t.alunos.filter(a => a.diario) : t.alunos;
}

// Unidade aberta = alguém já tem valor nela (o AVA libera as unidades aos poucos).
function unidadesAbertas(t) {
  return t.unidades.map((_, j) => t.alunos.some(a => a.notas[j] !== null));
}

function bimestresDa(t) {
  return [...new Set(t.unidades.map(u => bimestreDa(u.n)))].sort((a, b) => a - b);
}

// Notas do aluno por bimestre: { 1: { feitas, nota }, 2: {...} }
function notasDoAluno(t, aluno) {
  const r = {};
  t.unidades.forEach((u, j) => {
    const b = bimestreDa(u.n);
    r[b] = r[b] || { feitas: 0, nota: 0 };
    if (feita(aluno.notas[j])) r[b].feitas++;
  });
  Object.values(r).forEach(x => { x.nota = notaBimestre(x.feitas); });
  return r;
}

// Filtro de bimestre do topo (sempre um bimestre — sem "semestre todo",
// pedido 19/10): vale pros indicadores, pra lista de turmas e pro ranking.
// "1" = UA 01–06; "2" = UA 07–12.
const bimestreEscolhido = () => Number($('te-bimestre').value) || 1;
const rotuloBimestre = () => `${bimestreEscolhido()}º bimestre`;

// Bimestre que está correndo pela data: 2º semestre = ago–set 1º, out–dez 2º;
// 1º semestre = fev–abr 1º, mai–jul 2º. Semestre que não é o atual abre no 1º.
function bimestreAtual(semestre) {
  const d = new Date(), mes = d.getMonth() + 1;
  if (semestre !== semestreAtual()) return 1;
  return semestre.endsWith('.2') ? (mes >= 10 ? 2 : 1) : (mes >= 5 ? 2 : 1);
}

// unidades abertas que entram no filtro de bimestre
function abertasNoFiltro(t) {
  const b = bimestreEscolhido();
  return unidadesAbertas(t).map((aberta, j) => aberta && (!b || bimestreDa(t.unidades[j].n) === b));
}

// participação da turma no bimestre escolhido (ou no semestre todo)
function participacaoTurma(t) {
  const abertas = abertasNoFiltro(t);
  const b = bimestreEscolhido();
  const ativos = alunosAtivos(t);
  let feitas = 0;
  ativos.forEach(a => a.notas.forEach((v, j) => { if (abertas[j] && feita(v)) feitas++; }));
  const nAbertas = abertas.filter(Boolean).length;
  const possiveis = ativos.length * nAbertas;
  return {
    feitas, possiveis, abertas: nAbertas,
    unidades: b ? t.unidades.filter(u => bimestreDa(u.n) === b).length : t.unidades.length,
    pct: possiveis ? feitas / possiveis * 100 : null
  };
}

function participacaoDe(lista) {
  let feitas = 0, possiveis = 0;
  lista.forEach(t => { const p = participacaoTurma(t); feitas += p.feitas; possiveis += p.possiveis; });
  return { feitas, possiveis, pct: possiveis ? feitas / possiveis * 100 : null };
}

// ---------------- API ----------------

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}

let toastTimer;
function toast(msg, tipo = '') {
  const t = $('te-toast');
  t.textContent = msg;
  t.className = `te-toast ${tipo}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ---------------- semestre ----------------

function semestreAtual() {
  const d = new Date();
  return `${d.getFullYear()}.${d.getMonth() < 6 ? 1 : 2}`;
}

function opcoesSemestre() {
  const ano = new Date().getFullYear();
  const lista = [];
  for (let a = ano + 1; a >= ano - 2; a--) lista.push(`${a}.2`, `${a}.1`);
  return lista;
}

function encherSemestres(sel, valor) {
  sel.innerHTML = opcoesSemestre().map(s => `<option value="${s}">${s}</option>`).join('');
  sel.value = valor;
}

// ---------------- carregamento ----------------

async function carregarTurmas() {
  $('te-tela').innerHTML = '<div class="te-vazio">Carregando...</div>';
  try {
    turmas = await apiFetch(`/${MODULO}?semestre=${encodeURIComponent($('te-semestre').value)}`);
  } catch (err) {
    turmas = [];
    $('te-tela').innerHTML = `<div class="te-vazio"><b>Não consegui carregar as turmas.</b><p>${esc(err.message)}</p></div>`;
    return;
  }
  render();
}

function turmasFiltradas() {
  const c = $('te-curso').value;
  return c ? turmas.filter(t => t.cursoId === c) : turmas;
}

// ---------------- telas ----------------

function render() {
  if (turmaAberta) {
    const t = turmas.find(x => x.id === turmaAberta);
    if (t) return renderDetalhe(t);
    turmaAberta = null;
  }
  const lista = turmasFiltradas();
  if (!lista.length) {
    $('te-tela').innerHTML = `
      <div class="te-vazio">
        <b>Nenhuma turma importada${$('te-curso').value ? ' deste curso' : ''} em ${esc($('te-semestre').value)}.</b>
        <p>${podeImportar
          ? 'Exporte o livro de notas da disciplina no AVA e clique em “Importar livro de notas”.'
          : 'Assim que o EAD importar o livro de notas das turmas, elas aparecem aqui.'}</p>
      </div>`;
    return;
  }
  $('te-tela').innerHTML = indicadoresHtml(lista) + (aba === 'ranking' ? rankingHtml(lista) : turmasHtml(lista));
}

function indicadoresHtml(lista) {
  const p = participacaoDe(lista);
  const mediaGeral = mediaGeralDos(rankCursos(lista).cursosRank);
  const alunos = lista.reduce((s, t) => s + alunosAtivos(t).length, 0);
  // aluno em dia = fez com 100% todas as unidades já abertas da turma (no bimestre do filtro)
  let emDia = 0;
  lista.forEach(t => {
    const abertas = abertasNoFiltro(t);
    alunosAtivos(t).forEach(a => { if (abertas.some(Boolean) && a.notas.every((v, j) => !abertas[j] || feita(v))) emDia++; });
  });
  return `
    <div class="te-kpis">
      <div class="te-kpi" style="--orb-kpi: var(--orb-marca)">
        <span class="te-kpi-rot">Turmas importadas</span>
        <b class="te-kpi-num">${lista.length}</b>
        <small>${new Set(lista.map(t => t.cursoId)).size} curso(s)</small>
      </div>
      <div class="te-kpi" style="--orb-kpi: var(--orb-azul)">
        <span class="te-kpi-rot">Alunos das turmas</span>
        <b class="te-kpi-num">${alunos}</b>
        <small>só quem está no diário (sem DP, adaptação e quem saiu)</small>
      </div>
      <div class="te-kpi" style="--orb-kpi: var(--orb-azul)">
        <span class="te-kpi-rot">Média geral dos cursos · ${rotuloBimestre()}</span>
        <b class="te-kpi-num">${fmtPct(mediaGeral)}</b>
        <small>média das disciplinas de cada curso · ${p.feitas} de ${p.possiveis} unidades feitas com 100%</small>
      </div>
      <div class="te-kpi" style="--orb-kpi: var(--orb-bom)">
        <span class="te-kpi-rot">Alunos em dia</span>
        <b class="te-kpi-num">${emDia}</b>
        <small>fizeram todas as unidades abertas com 100%</small>
      </div>
    </div>`;
}

function barra(pct) {
  const v = pct === null || pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
  return `<span class="te-barra" aria-hidden="true"><span style="width:${v.toFixed(1)}%"></span></span>`;
}

function dataCurta(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}` : '';
}

function turmasHtml(lista) {
  // coluna Tutor só faz sentido pra quem vê turmas de mais de um tutor
  // (coordenador do EAD, coordenador de curso, ADM)
  const comTutor = new Set(lista.map(t => t.donoUid || t.importadoPor)).size > 1 ||
    lista.some(t => (t.donoUid || t.importadoPor) !== currentUser.uid);
  return `
    <section class="te-card">
      <h2 class="te-card-titulo">Turmas</h2>
      <div class="te-tabela-wrap">
        <table class="te-tabela">
          <thead><tr>
            <th>Disciplina</th><th>Curso</th><th>Turma</th>${comTutor ? '<th>Tutor</th>' : ''}
            <th class="num">Alunos</th><th class="num">Unidades abertas</th>
            <th>Participação</th><th>Atualizada</th><th><span class="sr-only">Ações</span></th>
          </tr></thead>
          <tbody>
            ${lista.map(t => `
              <tr>
                <td><button type="button" class="te-link" data-abrir="${esc(t.id)}">${esc(t.disciplina)}</button>
                  ${t.codigoAva ? `<small class="te-mudo">AVA ${esc(t.codigoAva)}</small>` : ''}</td>
                <td>${esc(t.curso)}</td>
                <td>${esc(t.turma || '—')}</td>
                ${comTutor ? `<td>${esc(t.donoNome || t.importadoPorNome || '—')}</td>` : ''}
                <td class="num">${alunosAtivos(t).length}</td>
                ${(() => { const p = participacaoTurma(t); return `
                <td class="num">${p.abertas} de ${p.unidades}</td>
                <td><span class="te-part">${barra(p.pct)}<span class="num">${fmtPct(p.pct)}</span></span></td>`; })()}
                <td class="te-mudo">${dataCurta(t.importadoEm)}</td>
                <td class="te-acoes">
                  <button type="button" class="btn-secondary te-btn-p" data-abrir="${esc(t.id)}">Abrir</button>
                  ${podeImportar ? `<button type="button" class="btn-secondary te-btn-p te-btn-perigo" data-excluir="${esc(t.id)}" aria-label="Excluir ${esc(t.disciplina)}">Excluir</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

// ---------------- ranking ----------------

// Contas do ranking — usadas pela tela e pela impressão (mesmo número nas duas).
function rankCursos(lista) {
  const porCurso = new Map();
  lista.forEach(t => {
    if (!porCurso.has(t.cursoId)) porCurso.set(t.cursoId, { id: t.cursoId, nome: t.curso, turmas: [] });
    porCurso.get(t.cursoId).turmas.push(t);
  });
  // média do curso = média das disciplinas (cada disciplina pesa igual) — mesmo
  // critério do relatório de desempenho que o EAD já usava (20/10/2026)
  const cursosRank = [...porCurso.values()].map(c => {
    const pcts = c.turmas.map(t => participacaoTurma(t).pct).filter(v => v !== null);
    return {
      ...c,
      pct: pcts.length ? pcts.reduce((s, v) => s + v, 0) / pcts.length : null,
      alunos: c.turmas.reduce((s, t) => s + alunosAtivos(t).length, 0)
    };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.nome.localeCompare(b.nome, 'pt-BR'));
  return { porCurso, cursosRank };
}

// Subiu/caiu do 1º pro 2º bimestre, em pontos percentuais. Verde = subiu,
// vermelho = caiu (regra de cor do Órbita: verde ganho, vermelho perda).
function variacaoHtml(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return '<span class="te-var">—</span>';
  const d = b - a;
  const pp = Math.abs(d).toFixed(1).replace('.', ',');
  if (Math.abs(d) < 0.05) return '<span class="te-var te-var-igual">= manteve</span>';
  return d > 0
    ? `<span class="te-var te-var-sobe">▲ subiu ${pp} p.p.</span>`
    : `<span class="te-var te-var-cai">▼ caiu ${pp} p.p.</span>`;
}

// Cursos nos dois bimestres (troca o filtro só pra calcular e devolve como estava).
function comparativoCursos(lista) {
  const sel = $('te-bimestre');
  const original = sel.value;
  const porBim = [1, 2].map(b => { sel.value = String(b); return rankCursos(lista).cursosRank; });
  sel.value = original;
  const doB2 = new Map(porBim[1].map(c => [c.id, c]));
  const geral = porBim.map(mediaGeralDos);
  const linhas = porBim[0].map(c => ({ id: c.id, nome: c.nome, p1: c.pct, p2: doB2.has(c.id) ? doB2.get(c.id).pct : null }))
    .sort((x, y) => (y.p2 ?? -1) - (x.p2 ?? -1) || x.nome.localeCompare(y.nome, 'pt-BR'));
  return { linhas, geral };
}

// média geral = média dos cursos
function mediaGeralDos(cursosRank) {
  const v = cursosRank.map(c => c.pct).filter(x => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function rankDisciplinas(curso) {
  return curso.turmas.map(t => ({ t, p: participacaoTurma(t) }))
    .sort((a, b) => (b.p.pct ?? -1) - (a.p.pct ?? -1) || a.t.disciplina.localeCompare(b.t.disciplina, 'pt-BR'));
}

// alunos ativos do curso; o mesmo aluno em várias disciplinas soma tudo
function rankAlunos(curso) {
  const alunosMap = new Map();
  curso.turmas.forEach(t => {
    const abertas = abertasNoFiltro(t);
    alunosAtivos(t).forEach(a => {
      const k = a.email || a.nome;
      if (!alunosMap.has(k)) alunosMap.set(k, { nome: a.nome, disciplinas: 0, feitas: 0, possiveis: 0 });
      const r = alunosMap.get(k);
      r.disciplinas++;
      a.notas.forEach((v, j) => { if (abertas[j]) { r.possiveis++; if (feita(v)) r.feitas++; } });
    });
  });
  return [...alunosMap.values()]
    .map(a => ({ ...a, pct: a.possiveis ? a.feitas / a.possiveis * 100 : null }))
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.feitas - a.feitas || a.nome.localeCompare(b.nome, 'pt-BR'));
}

function rankingHtml(lista) {
  const { porCurso, cursosRank } = rankCursos(lista);
  if (!cursoRankingAlunos || !porCurso.has(cursoRankingAlunos)) cursoRankingAlunos = cursosRank[0].id;

  const blocoCursos = `
    <section class="te-card">
      <div class="te-card-topo">
        <h2 class="te-card-titulo">Cursos por participação · ${rotuloBimestre()}</h2>
        <div class="te-botoes">
          <button type="button" class="btn-secondary te-btn-p" data-imprimir="ranking">Imprimir ${rotuloBimestre()}</button>
          <button type="button" class="btn-secondary te-btn-p" data-imprimir="ranking" data-juntos="1">Imprimir 1º e 2º bimestres</button>
        </div>
      </div>
      <p class="te-conta">Em cada disciplina: unidades feitas com 100% ÷ (alunos ativos × unidades já abertas). O curso é a média das suas disciplinas. Conta só quem está no diário da turma — DP, adaptação e quem trancou/desistiu ficam de fora.</p>
      <div class="te-tabela-wrap"><table class="te-tabela">
        <thead><tr><th class="num">#</th><th>Curso</th><th class="num">Turmas</th><th class="num">Alunos</th><th>Participação</th></tr></thead>
        <tbody>${cursosRank.map((c, i) => `
          <tr><td class="num">${i + 1}º</td><td>${esc(c.nome)}</td><td class="num">${c.turmas.length}</td><td class="num">${c.alunos}</td>
          <td><span class="te-part">${barra(c.pct)}<span class="num">${fmtPct(c.pct)}</span></span></td></tr>`).join('')}
        </tbody></table></div>
    </section>`;

  const blocoDisciplinas = `
    <section class="te-card">
      <h2 class="te-card-titulo">Disciplinas dentro de cada curso · ${rotuloBimestre()}</h2>
      ${cursosRank.map(c => `
        <h3 class="te-sub">${esc(c.nome)}</h3>
        <div class="te-tabela-wrap"><table class="te-tabela">
          <thead><tr><th class="num">#</th><th>Disciplina</th><th>Turma</th><th class="num">Alunos</th><th>Participação</th></tr></thead>
          <tbody>${rankDisciplinas(c).map(({ t, p }, i) => `
            <tr><td class="num">${i + 1}º</td><td><button type="button" class="te-link" data-abrir="${esc(t.id)}">${esc(t.disciplina)}</button></td>
            <td>${esc(t.turma || '—')}</td><td class="num">${alunosAtivos(t).length}</td>
            <td><span class="te-part">${barra(p.pct)}<span class="num">${fmtPct(p.pct)}</span></span></td></tr>`).join('')}
          </tbody></table></div>`).join('')}
    </section>`;

  const alunosRank = rankAlunos(porCurso.get(cursoRankingAlunos));
  const blocoAlunos = `
    <section class="te-card">
      <div class="te-card-topo">
        <h2 class="te-card-titulo">Alunos dentro do curso · ${rotuloBimestre()}</h2>
        <div class="te-botoes">
          <label class="te-inline">Curso
            <select id="te-curso-alunos" class="select-filter">
              ${cursosRank.map(c => `<option value="${esc(c.id)}"${c.id === cursoRankingAlunos ? ' selected' : ''}>${esc(c.nome)}</option>`).join('')}
            </select>
          </label>
          <button type="button" class="btn-secondary te-btn-p" data-imprimir="alunos">Imprimir alunos · ${rotuloBimestre()}</button>
          <button type="button" class="btn-secondary te-btn-p" data-imprimir="alunos" data-juntos="1">Alunos · 1º e 2º bimestres</button>
        </div>
      </div>
      <p class="te-conta">Soma todas as disciplinas EAD do aluno no curso. Ordenado do que mais completou para o que menos completou.</p>
      <div class="te-tabela-wrap"><table class="te-tabela">
        <thead><tr><th class="num">#</th><th>Aluno</th><th class="num">Disciplinas</th><th class="num">Unidades feitas</th><th>Participação</th></tr></thead>
        <tbody>${alunosRank.map((a, i) => `
          <tr><td class="num">${i + 1}º</td><td>${esc(a.nome)}</td><td class="num">${a.disciplinas}</td>
          <td class="num">${a.feitas} de ${a.possiveis}</td>
          <td><span class="te-part">${barra(a.pct)}<span class="num">${fmtPct(a.pct)}</span></span></td></tr>`).join('')}
        </tbody></table></div>
    </section>`;

  const comp = comparativoCursos(lista);
  const blocoComparativo = `
    <section class="te-card">
      <h2 class="te-card-titulo">Comparativo entre bimestres</h2>
      <p class="te-conta">Média de cada curso no 1º bimestre (UAs 01 a 06) e no 2º (UAs 07 a 12), e se subiu ou caiu. Média geral: ${fmtPct(comp.geral[0])} no 1º e ${fmtPct(comp.geral[1])} no 2º — ${variacaoHtml(comp.geral[0], comp.geral[1])}.</p>
      <div class="te-tabela-wrap"><table class="te-tabela">
        <thead><tr><th>Curso</th><th class="num">1º bimestre</th><th class="num">2º bimestre</th><th>Variação</th></tr></thead>
        <tbody>${comp.linhas.map(l => `
          <tr><td>${esc(l.nome)}</td><td class="num">${fmtPct(l.p1)}</td><td class="num">${fmtPct(l.p2)}</td><td>${variacaoHtml(l.p1, l.p2)}</td></tr>`).join('')}
        </tbody></table></div>
    </section>`;

  return blocoCursos + blocoComparativo + blocoDisciplinas + blocoAlunos;
}

// ---------------- impressão (padrão FATEC: logo, A4, mesma estrutura do CADD) ----------------
// "ranking" = cursos + disciplinas (só números, pode circular); "alunos" = ranking
// de alunos do curso escolhido, com nome — uso interno (LGPD).
// juntos = os dois bimestres num documento só: comparativo na primeira página e
// depois o relatório completo de cada bimestre (pedido 20/10/2026).
function imprimirRanking(tipo, juntos = false) {
  const lista = turmasFiltradas();
  if (!lista.length) return;
  const janela = window.open('', '_blank');
  if (!janela) { toast('O navegador bloqueou a janela de impressão. Libere pop-ups para o Órbita.', 'erro'); return; }

  const barraP = pct => `<span class="barra"><span style="width:${Math.max(0, Math.min(100, pct || 0)).toFixed(1)}%"></span></span>`;
  const filtroCurso = $('te-curso').value ? $('te-curso').selectedOptions[0].textContent : 'Todos os cursos';
  const emitido = new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
  const quem = (currentUser && (currentUser.displayName || currentUser.email)) || '';
  const semestre = $('te-semestre').value;

  // monta o relatório de UM bimestre — o que estiver no filtro na hora
  const montar = () => {
  const { cursosRank } = rankCursos(lista);
  let titulo, corpo;
  if (tipo === 'alunos') {
    // o curso vem do ranking (é lá que está a média calculada), não do agrupamento cru
    const curso = cursosRank.find(c => c.id === cursoRankingAlunos) || cursosRank[0];
    const alunos = rankAlunos(curso);
    titulo = `Participação dos alunos — ${curso.nome}`;
    corpo = `
      <div class="resumo">
        <div><small>Alunos ativos</small><b>${alunos.length}</b></div>
        <div><small>Participação do curso</small><b>${fmtPct(curso.pct)}</b></div>
        <div><small>Disciplinas EAD importadas</small><b>${curso.turmas.length}</b></div>
      </div>
      <h2>Alunos por participação</h2>
      <table><thead><tr><th class="n">#</th><th>Aluno</th><th class="n">Disciplinas</th><th class="n">Unidades feitas</th><th>Participação</th></tr></thead>
      <tbody>${alunos.map((a, i) => `<tr><td class="n">${i + 1}º</td><td>${esc(a.nome)}</td><td class="n">${a.disciplinas}</td><td class="n">${a.feitas} de ${a.possiveis}</td><td class="pc">${barraP(a.pct)}<b>${fmtPct(a.pct)}</b></td></tr>`).join('')}</tbody></table>
      <p class="nota">Contém dados pessoais protegidos pela LGPD: uso interno da coordenação e do EAD. Conta só os alunos ativos da turma no Edubox (DP, adaptação e quem trancou/desistiu ficam de fora).</p>`;
  } else {
    const media = mediaGeralDos(cursosRank);
    const b = bimestreEscolhido();
    const uas = b === 1 ? '01 a 06' : '07 a 12';
    const validos = cursosRank.filter(c => c.pct !== null);
    const [c1, c2, c3] = validos;
    const ultimo = validos[validos.length - 1];
    const acima = validos.filter(c => c.pct >= media).length;
    // destaque de consistência: entre os que ficaram na média ou acima, o que tem mais disciplinas
    const consistente = validos.filter(c => c.pct >= media && c.turmas.length >= 2)
      .sort((x, y) => y.turmas.length - x.turmas.length || y.pct - x.pct)[0];
    const poucas = validos.filter(c => c.turmas.length === 1).map(c => c.nome);
    const qualif = media >= 90 ? 'elevado' : media >= 75 ? 'bom' : media >= 60 ? 'regular' : 'baixo';
    const fmt = v => fmtPct(v);
    const listaNomes = l => l.length > 1 ? `${l.slice(0, -1).join(', ')} e ${l[l.length - 1]}` : l[0];

    // gráfico de barras horizontais com a linha da média (azul = na média ou acima, laranja = abaixo)
    const minPct = Math.min(...validos.map(c => c.pct));
    const passo = (100 - minPct) <= 10 ? 2 : (100 - minPct) <= 30 ? 5 : 10;
    const x0 = Math.max(0, Math.floor((minPct - passo) / passo) * passo);
    const L = 170, W = 680, R = 64, linha = 24, T = 8;
    const H = T + validos.length * linha + 34;
    const X = v => L + (W - L - R) * (v - x0) / (100 - x0);
    const ticks = [];
    for (let v = x0; v <= 100.001; v += passo) ticks.push(v);
    const grafico = `<svg viewBox="0 0 ${W} ${H}" class="graf" role="img" aria-label="Ranking geral por curso">
      ${ticks.map(v => `<line x1="${X(v).toFixed(1)}" y1="${T}" x2="${X(v).toFixed(1)}" y2="${H - 30}" stroke="#eceff4"/><text x="${X(v).toFixed(1)}" y="${H - 16}" text-anchor="middle" class="eixo">${v}</text>`).join('')}
      ${validos.map((c, i) => {
        const y = T + i * linha;
        const cor = c.pct >= media ? '#1f6fb2' : '#e8791e';
        return `<text x="${L - 8}" y="${y + 15}" text-anchor="end" class="rot">${esc(c.nome)}</text>
          <rect x="${L}" y="${y + 4}" width="${Math.max(1, X(c.pct) - L).toFixed(1)}" height="15" rx="2" fill="${cor}"/>
          <text x="${(X(c.pct) + 5).toFixed(1)}" y="${y + 15}" class="val">${fmt(c.pct)}</text>`;
      }).join('')}
      <line x1="${X(media).toFixed(1)}" y1="${T - 2}" x2="${X(media).toFixed(1)}" y2="${H - 30}" stroke="#0d1b33" stroke-width="1.2" stroke-dasharray="4 3"/>
      <text x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle" class="eixo">Participação média do curso (%)</text>
    </svg>`;

    titulo = 'Relatório de desempenho';
    corpo = `
      <section class="pagina">
        <div class="titulo-rel">
          <h2 class="sem-faixa">RELATÓRIO DE DESEMPENHO</h2>
          <p class="sub">Unidades de Aprendizagem — ${b}º bimestre · ${esc(semestre)}${$('te-curso').value ? ` · ${esc(filtroCurso)}` : ''}</p>
        </div>
        <div class="resumo">
          <div><b>${fmt(media)}</b><small>Média geral dos cursos</small></div>
          <div><b>${validos.length}</b><small>Cursos analisados</small></div>
          <div><b>${fmt(c1 ? c1.pct : null)}</b><small>Maior média registrada</small></div>
        </div>

        <h2>Síntese dos resultados</h2>
        <p>O desempenho geral foi ${qualif}: a média dos ${validos.length} cursos alcançou ${fmt(media)}.${c1 ? ` ${esc(c1.nome)} liderou o ranking com ${fmt(c1.pct)}${c2 ? `, seguida por ${esc(c2.nome)} (${fmt(c2.pct)})${c3 ? ` e ${esc(c3.nome)} (${fmt(c3.pct)})` : ''}` : ''}.` : ''}</p>
        <ul>
          <li>${acima} ${acima === 1 ? 'curso registrou' : 'cursos registraram'} média igual ou superior a ${fmt(media)}.</li>
          ${consistente ? `<li>${esc(consistente.nome)} destacou-se pela consistência: ${fmt(consistente.pct)} em ${consistente.turmas.length} disciplinas.</li>` : ''}
          ${ultimo && ultimo !== c1 ? `<li>${esc(ultimo.nome)} apresentou a menor média, ${fmt(ultimo.pct)}, demandando acompanhamento prioritário.</li>` : ''}
          ${ultimo && c1 && ultimo !== c1 ? `<li>A diferença entre o primeiro e o último colocado foi de ${(c1.pct - ultimo.pct).toFixed(2).replace('.', ',')} pontos percentuais.</li>` : ''}
        </ul>

        <h2>Finalidade</h2>
        <p>Este documento apresenta, de forma objetiva, os resultados de realização das UAs ${uas} no ${b}º bimestre de ${esc(semestre)}, favorecendo o acompanhamento acadêmico e a identificação de pontos de atenção por curso.</p>

        <h2>Critério de cálculo e leitura</h2>
        <p>Em cada disciplina, a participação é a porcentagem de unidades de aprendizagem feitas com 100% pelos alunos ativos da turma, considerando só as unidades já abertas no AVA; unidade com menos de 100% ou não feita conta como não realizada. Em seguida, foi calculada a média das disciplinas de cada curso, e a média geral é a média dos cursos. Alunos de DP, adaptação e quem trancou ou desistiu não entram na conta.</p>
        ${poucas.length ? `<p>Como os cursos possuem quantidades diferentes de disciplinas no relatório, a leitura do ranking deve considerar também o número de componentes avaliados. ${poucas.length === 1 ? 'O curso' : 'Os cursos'} com apenas uma disciplina — ${esc(listaNomes(poucas))} — ${poucas.length === 1 ? 'tem' : 'têm'} menor diversidade de observações.</p>` : ''}
      </section>

      <section class="pagina quebra">
        <h2>Ranking geral por curso</h2>
        <p class="sub">Cursos ordenados pela média das disciplinas. A linha tracejada representa a média geral de ${fmt(media)}.</p>
        ${grafico}
      </section>

      <section class="quebra">
        <h2>Disciplinas dentro de cada curso</h2>
        ${cursosRank.map(c => `
          <div class="bloco">
            <h3>${esc(c.nome)} <span>${fmt(c.pct)}</span></h3>
            <table><thead><tr><th class="n">#</th><th>Disciplina</th><th>Turma</th><th class="n">Alunos</th><th>Participação</th></tr></thead>
            <tbody>${rankDisciplinas(c).map(({ t, p }, i) => `<tr><td class="n">${i + 1}º</td><td>${esc(t.disciplina)}</td><td>${esc(t.turma || '—')}</td><td class="n">${alunosAtivos(t).length}</td><td class="pc">${barraP(p.pct)}<b>${fmt(p.pct)}</b></td></tr>`).join('')}</tbody></table>
          </div>`).join('')}
      </section>`;
  }

    return { titulo, corpo };
  };

  const original = $('te-bimestre').value;
  let titulo, corpo, rotuloImp;
  if (!juntos) {
    ({ titulo, corpo } = montar());
    rotuloImp = rotuloBimestre();
  } else {
    const partes = [], porBim = [];
    for (const b of [1, 2]) {
      $('te-bimestre').value = String(b);
      const m = montar();
      titulo = m.titulo;
      partes.push(`<div class="quebra"><p class="selo-bim">${b}º bimestre</p>${m.corpo}</div>`);
      const cr = rankCursos(lista).cursosRank;
      porBim.push(tipo === 'alunos'
        ? { media: (cr.find(c => c.id === cursoRankingAlunos) || cr[0]).pct, alunos: rankAlunos(cr.find(c => c.id === cursoRankingAlunos) || cr[0]), curso: (cr.find(c => c.id === cursoRankingAlunos) || cr[0]).nome }
        : { media: mediaGeralDos(cr), cursos: cr });
    }
    $('te-bimestre').value = original;
    rotuloImp = '1º e 2º bimestres';
    const variacao = variacaoHtml;
    let comparativo;
    if (tipo === 'alunos') {
      const [b1, b2] = porBim;
      const doB2 = new Map(b2.alunos.map(a => [a.nome, a]));
      const nomes = [...new Set([...b1.alunos.map(a => a.nome), ...b2.alunos.map(a => a.nome)])];
      const linhas = nomes.map(n => ({ nome: n, a1: b1.alunos.find(a => a.nome === n), a2: doB2.get(n) }))
        .sort((x, y) => ((y.a2 && y.a2.pct) ?? -1) - ((x.a2 && x.a2.pct) ?? -1) || x.nome.localeCompare(y.nome, 'pt-BR'));
      const cel = a => a ? `${a.feitas} de ${a.possiveis} · <b>${fmtPct(a.pct)}</b>` : '—';
      comparativo = `
        <section>
          <h2>Comparativo entre bimestres — ${esc(b1.curso)}</h2>
          <div class="resumo">
            <div><b>${fmtPct(b1.media)}</b><small>Participação do curso · 1º bimestre</small></div>
            <div><b>${fmtPct(b2.media)}</b><small>Participação do curso · 2º bimestre</small></div>
            <div><b>${variacao(b1.media, b2.media)}</b><small>Variação do 1º para o 2º</small></div>
          </div>
          <table><thead><tr><th>Aluno</th><th class="n">1º bimestre</th><th class="n">2º bimestre</th><th class="n">Variação</th></tr></thead>
          <tbody>${linhas.map(l => `<tr><td>${esc(l.nome)}</td><td class="n">${cel(l.a1)}</td><td class="n">${cel(l.a2)}</td><td class="n">${variacao(l.a1 && l.a1.pct, l.a2 && l.a2.pct)}</td></tr>`).join('')}</tbody></table>
          <p class="nota">Contém dados pessoais protegidos pela LGPD: uso interno da coordenação e do EAD.</p>
        </section>`;
    } else {
      const [b1, b2] = porBim;
      const doB2 = new Map(b2.cursos.map(c => [c.id, c]));
      const linhas = b1.cursos.map(c => ({ nome: c.nome, p1: c.pct, p2: doB2.has(c.id) ? doB2.get(c.id).pct : null }))
        .sort((x, y) => (y.p2 ?? -1) - (x.p2 ?? -1) || x.nome.localeCompare(y.nome, 'pt-BR'));
      comparativo = `
        <section>
          <div class="titulo-rel">
            <h2 class="sem-faixa">RELATÓRIO DE DESEMPENHO</h2>
            <p class="sub">Unidades de Aprendizagem — 1º e 2º bimestres · ${esc(semestre)}${$('te-curso').value ? ` · ${esc(filtroCurso)}` : ''}</p>
          </div>
          <div class="resumo">
            <div><b>${fmtPct(b1.media)}</b><small>Média geral · 1º bimestre</small></div>
            <div><b>${fmtPct(b2.media)}</b><small>Média geral · 2º bimestre</small></div>
            <div><b>${variacao(b1.media, b2.media)}</b><small>Variação do 1º para o 2º</small></div>
          </div>
          <h2>Comparativo entre bimestres</h2>
          <table><thead><tr><th>Curso</th><th class="n">1º bimestre</th><th class="n">2º bimestre</th><th class="n">Variação</th></tr></thead>
          <tbody>${linhas.map(l => `<tr><td>${esc(l.nome)}</td><td class="n"><b>${fmtPct(l.p1)}</b></td><td class="n"><b>${fmtPct(l.p2)}</b></td><td class="n">${variacao(l.p1, l.p2)}</td></tr>`).join('')}</tbody></table>
          <p class="nota">Média de cada curso = média das suas disciplinas no bimestre (UAs 01 a 06 no 1º, 07 a 12 no 2º). Nas páginas seguintes, o relatório completo de cada bimestre.</p>
        </section>`;
    }
    corpo = comparativo + partes.join('');
  }

  const html = `<!DOCTYPE html><html lang="pt-br"><head><meta charset="utf-8"><title>${esc(titulo)} — ${esc(semestre)} · ${esc(rotuloImp)}</title>
<style>
  @page {
    size: A4; margin: 16mm 13mm;
    @top-right { content: "RELATÓRIO ACADÊMICO | UAs – ${esc(rotuloImp.toUpperCase())}"; font-size: 7.5pt; color: #5b6a80; font-family: "Segoe UI", Arial, sans-serif; }
    @bottom-left { content: "Relatório de desempenho acadêmico · FATEC Ivaiporã"; font-size: 7.5pt; color: #5b6a80; font-family: "Segoe UI", Arial, sans-serif; }
    @bottom-right { content: "Página " counter(page); font-size: 7.5pt; color: #5b6a80; font-family: "Segoe UI", Arial, sans-serif; }
  }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0d1b33; font-size: 10pt; margin: 0; line-height: 1.45; }
  .quebra { break-before: page; }
  .te-var { font-weight: 700; white-space: nowrap; } .te-var-sobe { color: #0f7a4b; } .te-var-cai { color: #c8392f; } .te-var-igual { color: #5b6a80; }
  .selo-bim { display: inline-block; background: #12294d; color: #fff; border-radius: 999px; padding: 2px 12px; font-size: 9pt; font-weight: 700; margin: 0 0 6px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .quebra .quebra:first-of-type { break-before: auto; }
  .titulo-rel { margin: 4px 0 10px; }
  h2.sem-faixa { border: 0; padding: 0; font-size: 15pt; margin: 0; letter-spacing: .01em; }
  .sub { color: #44536b; font-size: 9pt; margin: 2px 0 8px; }
  ul { margin: 4px 0 0; padding-left: 18px; } li { margin: 2px 0; }
  p { margin: 4px 0; text-align: justify; }
  .graf { width: 100%; height: auto; display: block; margin-top: 6px; }
  .graf .rot { font-size: 10px; fill: #0d1b33; } .graf .val { font-size: 9.5px; font-weight: 700; fill: #0d1b33; } .graf .eixo { font-size: 9px; fill: #5b6a80; }
  .graf rect { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #12294d; padding-bottom: 8px; margin-bottom: 12px; }
  header img { height: 46px; }
  header h1 { font-size: 15pt; margin: 0; color: #12294d; }
  header p { margin: 2px 0 0; color: #44536b; font-size: 9pt; }
  h2 { font-size: 11pt; color: #12294d; margin: 16px 0 6px; border-left: 4px solid #1f6fb2; padding-left: 8px; break-after: avoid; }
  h3 { font-size: 10pt; color: #12294d; margin: 12px 0 4px; break-after: avoid; }
  h3 span { color: #5b6a80; font-weight: 400; }
  .resumo { display: flex; gap: 10px; margin-bottom: 4px; }
  .resumo div { flex: 1; border: 1px solid #e3e8f0; border-left: 4px solid #12294d; border-radius: 6px; padding: 7px 10px; text-align: center; }
  .resumo small { display: block; color: #5b6a80; font-size: 8pt; }
  .resumo b { display: block; font-size: 15pt; color: #12294d; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th { background: #12294d; color: #fff; text-align: left; padding: 5px 6px; font-weight: 600; }
  td { padding: 4px 6px; border-bottom: 1px solid #e3e8f0; vertical-align: middle; }
  tr, .bloco { break-inside: avoid; }
  .n { text-align: right; white-space: nowrap; }
  .pc { white-space: nowrap; width: 34%; }
  .pc b { display: inline-block; min-width: 46px; text-align: right; margin-left: 6px; }
  .barra { display: inline-block; vertical-align: middle; width: 62%; height: 7px; background: #eceff4; border-radius: 4px; overflow: hidden; }
  .barra span { display: block; height: 100%; background: #1f6fb2; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  th, .resumo div { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .nota { color: #5b6a80; font-size: 8.5pt; margin-top: 12px; line-height: 1.4; }
  @media screen { body { max-width: 190mm; margin: 12px auto; padding: 0 10px; } }
</style></head><body>
<header><img src="${location.origin}/img/fateclogoazul.png" alt="FATEC Ivaiporã"><div><h1>${tipo === 'alunos' ? esc(titulo) : 'Trilha EAD — FATEC Ivaiporã'}</h1>
<p>${tipo === 'alunos' ? 'FATEC Ivaiporã · Trilha EAD · ' : ''}${esc(semestre)} · ${esc(rotuloImp)} · ${esc(filtroCurso)} · emitido em ${esc(emitido)}${quem ? ' por ' + esc(quem) : ''}</p></div></header>
${corpo}
</body></html>`;
  janela.document.open(); janela.document.write(html); janela.document.close();
  const logo = janela.document.querySelector('header img');
  const imprimirAgora = () => { janela.focus(); janela.print(); };
  if (logo && !logo.complete) { logo.onload = logo.onerror = () => setTimeout(imprimirAgora, 150); } else setTimeout(imprimirAgora, 250);
}

// ---------------- detalhe da turma ----------------

function renderDetalhe(t) {
  const diarios = t.diarios || [];
  const diarioPorId = Object.fromEntries(diarios.map(d => [d.id, d]));
  const abertas = unidadesAbertas(t);
  const bims = bimestresDa(t);
  const notas = t.alunos.map(a => notasDoAluno(t, a));
  const media = b => {
    const v = notas.map(n => (n[b] ? n[b].nota : 0));
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
  };

  // Separação visual dos bimestres na tabela: divisória antes da 1ª UA de cada
  // bimestre novo (UA 07 = começo do 2º) e fundo leve nos bimestres pares.
  const colBim = j => {
    const b = bimestreDa(t.unidades[j].n);
    const comeca = j > 0 && bimestreDa(t.unidades[j - 1].n) !== b;
    return `${b % 2 === 0 ? ' te-bim-par' : ''}${comeca ? ' te-sep' : ''}`;
  };
  const faixaUas = b => {
    const ns = t.unidades.filter(u => bimestreDa(u.n) === b).map(u => String(u.n).padStart(2, '0'));
    return ns.length ? `UA ${ns[0]} a ${ns[ns.length - 1]}` : '';
  };

  // Quem pode marcar à mão vê a célula clicável (marca/desmarca "concluída").
  const marca = (t.manuais || {});
  // mesma chave do servidor (src/rotas/trilha-ead.js chaveAluno)
  const chaveAlunoTela = a => (a.email || '').toLowerCase() || String(a.nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  const celula = (v, aberta, a, i, j) => {
    const n = t.unidades[j].n;
    const manual = (a.manuais || []).includes(n);
    const info = manual ? ((marca[chaveAlunoTela(a)] || {})[n] || {}) : null;
    const clicavel = podeImportar ? ` data-marcar="${i}|${n}" tabindex="0" role="button"` : '';
    const ok = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-label="Feita"><polyline points="20 6 9 17 4 12"/></svg>';
    if (manual) {
      const quando = info && info.em ? new Date(info.em).toLocaleDateString('pt-BR') : '';
      return `<td class="te-ua te-ua-manual${podeImportar ? ' te-ua-clicavel' : ''}"${clicavel} title="Concluída à mão${info && info.por ? ` por ${esc(info.por)}` : ''}${quando ? ` em ${quando}` : ''}${podeImportar ? ' — clique para desmarcar' : ''}">${ok}</td>`;
    }
    if (v === null || v === undefined) return `<td class="te-ua te-ua-nao${podeImportar ? ' te-ua-clicavel' : ''}"${clicavel} title="${aberta ? 'Não fez' : 'Unidade ainda não aberta'}${podeImportar ? ' — clique para marcar como concluída' : ''}">–</td>`;
    if (feita(v)) return `<td class="te-ua te-ua-ok" title="100% no AVA — vale 0,5">${ok}</td>`;
    return `<td class="te-ua te-ua-parcial${podeImportar ? ' te-ua-clicavel' : ''}"${clicavel} title="${v}% — abaixo de 100% não conta${podeImportar ? ' — clique para marcar como concluída' : ''}">${Math.round(v)}%</td>`;
  };

  $('te-tela').innerHTML = `
    <div class="te-detalhe-topo">
      <button type="button" class="btn-secondary" id="te-voltar">Voltar</button>
      <div>
        <h2 class="te-detalhe-titulo">${esc(t.disciplina)}</h2>
        <p class="te-mudo">${esc(t.curso)}${t.turma ? ` · Turma ${esc(t.turma)}` : ''} · ${esc(t.semestre)}${t.codigoAva ? ` · AVA ${esc(t.codigoAva)}` : ''} · atualizada em ${esc(new Date(t.importadoEm).toLocaleString('pt-BR'))}</p>
      </div>
    </div>

    <div class="te-kpis">
      <div class="te-kpi" style="--orb-kpi: var(--orb-azul)">
        <span class="te-kpi-rot">Alunos da turma</span><b class="te-kpi-num">${alunosAtivos(t).length}</b>
        <small>${t.alunos.length - alunosAtivos(t).length ? `+ ${t.alunos.length - alunosAtivos(t).length} no AVA que não contam (DP, adaptação, saíram) · ` : ''}${t.resumo.unidadesAbertas} de ${t.resumo.unidades} unidades abertas</small>
      </div>
      <div class="te-kpi" style="--orb-kpi: var(--orb-azul)">
        ${(() => {
          let f = 0;
          const ab = unidadesAbertas(t), at = alunosAtivos(t);
          at.forEach(a => a.notas.forEach((v, j) => { if (ab[j] && feita(v)) f++; }));
          const pos = at.length * ab.filter(Boolean).length;
          return `<span class="te-kpi-rot">Participação da turma</span><b class="te-kpi-num">${fmtPct(pos ? f / pos * 100 : null)}</b>
            <small>${f} de ${pos} feitas com 100% (semestre)</small>`;
        })()}
      </div>
      ${bims.map(b => `
        <div class="te-kpi" style="--orb-kpi: var(--orb-marca)">
          <span class="te-kpi-rot">Nota média · ${b}º bimestre</span><b class="te-kpi-num">${fmtNota(media(b))}</b>
          <small>de 0 a ${fmtNota(UNIDADES_POR_BIMESTRE * NOTA_UNIDADE)}</small>
        </div>`).join('')}
    </div>

    ${podeImportar ? secaoEduboxHtml(t, bims) : ''}

    <section class="te-card">
      <h2 class="te-card-titulo">Alunos</h2>
      <div class="te-tabela-wrap">
        <table class="te-tabela te-tabela-notas">
          <thead>
            <tr>
              <th rowspan="2">Aluno</th>
              ${diarios.length ? '<th rowspan="2">Diário no Edubox</th>' : ''}
              ${bims.map((b, k) => `<th colspan="${t.unidades.filter(u => bimestreDa(u.n) === b).length}" class="te-th-bim${b % 2 === 0 ? ' te-bim-par' : ''}${k > 0 ? ' te-sep' : ''}">${b}º bimestre <span class="te-th-faixa">${faixaUas(b)}</span></th>`).join('')}
              ${bims.map((b, k) => `<th rowspan="2" class="num te-th-nota${k === 0 ? ' te-sep' : ' te-sep-leve'}">Nota ${b}º</th>`).join('')}
            </tr>
            <tr>${t.unidades.map((u, j) => `<th class="te-ua-cab${colBim(j)}${abertas[j] ? '' : ' te-ua-fechada'}" title="UA ${String(u.n).padStart(2, '0')} — ${esc(u.titulo)}">${String(u.n).padStart(2, '0')}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${t.alunos.map((a, i) => `
              <tr class="${diarios.length && !a.diario ? 'te-linha-fora' : ''}">
                <td class="te-aluno">${esc(a.nome)}${a.nomeEdubox ? `<small class="te-social">No Edubox: ${esc(a.nomeEdubox)} (nome social, achado pelo sobrenome)</small>` : ''}${a.email ? `<small class="te-mudo">${esc(a.email)}</small>` : ''}</td>
                ${diarios.length ? `<td class="te-diario">${a.diario && diarioPorId[a.diario]
                  ? `${esc(diarioPorId[a.diario].periodo)}º período<small class="te-mudo">${esc(diarioPorId[a.diario].turma)}</small>`
                  : `<span class="te-etiqueta te-etiqueta-alerta">Fora dos diários</span><small class="te-mudo te-onde">${esc(a.ondeEsta ? ondeEstaTexto(a.ondeEsta, a.matricula) : 'importe de novo pra ver onde está')}</small>`}</td>` : ''}
                ${a.notas.map((v, j) => celula(v, abertas[j], a, i, j).replace('class="te-ua', `class="te-ua${colBim(j)}`)).join('')}
                ${bims.map((b, k) => `<td class="num te-nota${k === 0 ? ' te-sep' : ' te-sep-leve'}">${fmtNota(notas[i][b] ? notas[i][b].nota : 0)}</td>`).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="te-legenda">
        <span class="te-ua-ok te-leg">✓</span> 100% (vale 0,5) ·
        <span class="te-ua-parcial te-leg">71%</span> abaixo de 100% (não conta) ·
        <span class="te-ua-nao te-leg">–</span> não fez ou unidade ainda não aberta ·
        <span class="te-ua-manual te-leg">✓</span> concluída à mão${podeImportar ? ' (clique numa unidade para marcar ou desmarcar — a marcação continua valendo quando importar de novo)' : ''}
      </p>
    </section>`;
}

// Arquivo do Edubox: um por diário (turmas que estudam juntas no AVA têm um
// diário por período no Edubox). Com os diários do CADD, a lista é a do diário
// — com o nome igual ao do Edubox — e quem não fez nada no AVA (ou nem está lá)
// sai com 0. Sem diário encontrado, sai a lista do AVA.
function secaoEduboxHtml(t, bims) {
  const diarios = t.diarios || [];
  const regra = 'Uma linha por aluno: <b>Nome;Nota</b>, com ponto (ex.: 2.5). Nota = 0,5 por unidade do bimestre feita com 100% — abaixo disso ou sem fazer conta 0.';
  if (!diarios.length) {
    return `
      <section class="te-card">
        <div class="te-card-topo">
          <h2 class="te-card-titulo">Arquivo para o Edubox</h2>
          <div class="te-botoes">${bims.map(b => `<button type="button" class="btn-primary" data-arquivo="${b}">Baixar ${b}º bimestre</button>`).join('')}</div>
        </div>
        <p class="te-conta">${regra}</p>
        <div class="te-aviso">Não encontrei esta disciplina nos diários do Edubox (dados do CADD) — o arquivo sai com os alunos do AVA. Confira os nomes ao lançar.</div>
      </section>`;
  }
  const doAva = new Map();
  t.alunos.forEach(a => { doAva.set(normNome(a.nome), a); if (a.nomeEdubox) doAva.set(normNome(a.nomeEdubox), a); });
  const foraDosDiarios = t.alunos.filter(a => !a.diario);
  return `
    <section class="te-card">
      <h2 class="te-card-titulo">Arquivo para o Edubox</h2>
      <p class="te-conta">${regra} Um arquivo por diário do Edubox, com os alunos do diário.</p>
      <div class="te-diarios">
        ${diarios.map(d => {
          const semAva = d.alunos.filter(a => !doAva.has(normNome(a.nome))).length;
          return `
            <div class="te-diario-linha">
              <div>
                <b>${esc(d.periodo)}º período</b> · ${esc(d.turma)}
                <small class="te-mudo">${esc(d.disciplina)} · ${d.alunos.length} alunos no diário${semAva ? ` · ${semAva} sem nada no AVA (saem com 0)` : ''}</small>
              </div>
              <div class="te-botoes">${bims.map(b => `<button type="button" class="btn-primary te-btn-p" data-arquivo="${b}" data-diario="${esc(d.id)}">${b}º bimestre</button>`).join('')}</div>
            </div>`;
        }).join('')}
      </div>
      ${foraDosDiarios.length ? avisoForaDosDiarios(t, bims, foraDosDiarios) : ''}
    </section>`;
}

// Quem está no AVA mas não no diário regular, separado pelo que o tutor faz:
// DP/adaptação (lançar no diário da turma do aluno), saiu (não lança) e não
// encontrado (conferir — ex.: conta de professor no AVA). Nenhum conta na
// participação da turma.
function grupoFora(a) {
  const onde = a.ondeEsta || [];
  if (onde.some(o => o.disciplina)) return 'lancar';
  if (onde.length) return 'outra';
  if (a.matricula && SAIU.test(a.matricula.situacao || '')) return 'saiu';
  return 'conferir';
}

function avisoForaDosDiarios(t, bims, fora) {
  const GRUPOS = [
    ['lancar', 'DP ou adaptação — lançar à mão no diário da turma do aluno'],
    ['outra', 'Estão em outra turma, sem esta disciplina no diário — conferir'],
    ['saiu', 'Saíram (trancou, cancelou, desistiu) — não precisa lançar'],
    ['conferir', 'Não encontrados no Edubox nem em Matrículas — conferir (pode ser conta de professor ou de teste no AVA)']
  ];
  const item = a => {
    const n = notasDoAluno(t, a);
    const notasTxt = bims.map(b => `${b}º bim. ${fmtNota(n[b] ? n[b].nota : 0)}`).join(' · ');
    return `<li><b>${esc(a.nome)}</b>${a.nomeEdubox ? ` <span class="te-social">(no Edubox: ${esc(a.nomeEdubox)} — nome social)</span>` : ''} — ${esc(a.ondeEsta ? ondeEstaTexto(a.ondeEsta, a.matricula) : 'importe de novo pra ver onde está')} <span class="te-mudo">(${notasTxt})</span></li>`;
  };
  return `
    <div class="te-aviso">
      <b>${fora.length} aluno(s) do AVA não estão no diário desta disciplina:</b> não entram nos arquivos nem na participação da turma.
      ${GRUPOS.map(([g, titulo]) => {
        const lista = fora.filter(a => grupoFora(a) === g);
        return lista.length ? `<p class="te-onde-grupo">${esc(titulo)} (${lista.length})</p><ul class="te-onde-lista">${lista.map(item).join('')}</ul>` : '';
      }).join('')}
    </div>`;
}

function baixarArquivoEdubox(t, bimestre, diarioId) {
  const linhas = ['Nome;Nota'];
  const diario = diarioId ? (t.diarios || []).find(d => d.id === diarioId) : null;
  const notaDe = a => { const n = notasDoAluno(t, a)[bimestre]; return n ? n.nota : 0; };
  let qtd = 0;
  if (diario) {
    const doAva = new Map();
    t.alunos.forEach(a => { doAva.set(normNome(a.nome), a); if (a.nomeEdubox) doAva.set(normNome(a.nomeEdubox), a); });
    diario.alunos.slice().sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR')).forEach(al => {
      const a = doAva.get(normNome(al.nome));
      linhas.push(`${al.nome.replace(/;/g, ' ')};${(a ? notaDe(a) : 0).toFixed(1)}`);
      qtd++;
    });
  } else {
    t.alunos.forEach(a => { linhas.push(`${a.nome.replace(/;/g, ' ')};${notaDe(a).toFixed(1)}`); qtd++; });
  }
  const blob = new Blob(['﻿' + linhas.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const nome = ['Trilha EAD', t.disciplina, diario ? `${diario.periodo}º período` : t.turma, `${bimestre}º bimestre`, t.semestre]
    .filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]+/g, ' ');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${nome}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast(`Arquivo do ${bimestre}º bimestre${diario ? ` · ${diario.periodo}º período` : ''} baixado (${qtd} alunos).`, 'ok');
}

// ---------------- importação ----------------

function lerBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^;]*;base64,/, ''));
    r.onerror = () => reject(new Error('Não consegui ler o arquivo.'));
    r.readAsDataURL(file);
  });
}

function abrirImportacao() {
  arquivoEscolhido = null;
  $('te-arquivo').value = '';
  $('te-arquivo-txt').textContent = 'Escolha o arquivo do livro de notas';
  $('te-arquivo-zona').classList.remove('tem-arquivo');
  $('te-previa').innerHTML = '';
  $('te-modal-erro').innerHTML = '';
  $('te-disciplina').value = '';
  $('te-turma').value = '';
  $('te-curso-import').value = $('te-curso').value || '';
  encherSemestres($('te-semestre-import'), $('te-semestre').value);
  $('te-confirmar').disabled = true;
  $('te-modal').classList.remove('hidden');
  $('te-arquivo').focus();
}

function fecharImportacao() { $('te-modal').classList.add('hidden'); }

function erroModal(msg) {
  $('te-modal-erro').innerHTML = msg ? `<div class="te-erro">${esc(msg)}</div>` : '';
}

async function arquivoMudou() {
  const f = $('te-arquivo').files && $('te-arquivo').files[0];
  if (!f) return;
  erroModal('');
  $('te-arquivo-zona').classList.add('tem-arquivo');
  $('te-arquivo-txt').textContent = f.name;
  $('te-previa').innerHTML = '<div class="te-previa">Lendo o arquivo...</div>';
  $('te-confirmar').disabled = true;
  try {
    arquivoEscolhido = { nome: f.name, base64: await lerBase64(f) };
    const p = await apiFetch(`/${MODULO}/previa`, {
      method: 'POST', body: JSON.stringify({ nomeArquivo: f.name, arquivoBase64: arquivoEscolhido.base64, semestre: $('te-semestre-import').value })
    });
    if (!$('te-curso-import').value && p.cursoSugerido) $('te-curso-import').value = p.cursoSugerido;
    if (!$('te-disciplina').value.trim()) $('te-disciplina').value = p.disciplina || '';
    // mesma turma do AVA já importada antes: sugere o mesmo curso e turma
    const anterior = p.codigoAva && turmas.find(t => t.codigoAva === p.codigoAva);
    if (anterior) {
      $('te-curso-import').value = anterior.cursoId;
      $('te-turma').value = anterior.turma || '';
    }
    const r = p.resumo;
    $('te-previa').innerHTML = `
      <div class="te-previa">
        <b>${r.alunos} alunos</b> · ${r.unidades} unidades (${r.unidadesAbertas} já abertas) · participação ${fmtPct(r.participacao)}
        ${p.diarios.length
          ? `<br>Diário(s) no Edubox: ${p.diarios.map(d => `<b>${esc(d.periodo)}º período</b> (${esc(d.turma)}, ${d.alunos} alunos)`).join(' e ')}${(p.foraDosDiarios || []).length ? `<br>Fora do diário: ${p.foraDosDiarios.map(f => `<b>${esc(f.nome)}</b>${f.nomeEdubox ? ` (no Edubox: ${esc(f.nomeEdubox)})` : ''} — ${esc(ondeEstaTexto(f.ondeEsta, f.matricula))}`).join('; ')}` : ''}`
          : '<br>Não encontrei esta disciplina nos diários do Edubox deste semestre — confira o semestre.'}
        ${anterior ? '<br>Essa turma já foi importada antes — as notas vão ser atualizadas.' : ''}
      </div>`;
    $('te-confirmar').disabled = false;
  } catch (err) {
    arquivoEscolhido = null;
    $('te-previa').innerHTML = '';
    erroModal(err.message);
  }
}

async function confirmarImportacao() {
  if (!arquivoEscolhido) return erroModal('Escolha o arquivo do livro de notas.');
  if (!$('te-curso-import').value) return erroModal('Escolha o curso da disciplina.');
  const btn = $('te-confirmar');
  btn.disabled = true;
  btn.textContent = 'Importando...';
  try {
    const salvo = await apiFetch(`/${MODULO}`, {
      method: 'POST',
      body: JSON.stringify({
        nomeArquivo: arquivoEscolhido.nome,
        arquivoBase64: arquivoEscolhido.base64,
        disciplina: $('te-disciplina').value.trim(),
        cursoId: $('te-curso-import').value,
        turma: $('te-turma').value.trim(),
        semestre: $('te-semestre-import').value
      })
    });
    fecharImportacao();
    toast(salvo.reimportado ? `${salvo.disciplina}: notas atualizadas.` : `${salvo.disciplina}: turma importada.`, 'ok');
    if ($('te-semestre').value !== salvo.semestre) $('te-semestre').value = salvo.semestre;
    turmaAberta = salvo.id;
    await carregarTurmas();
  } catch (err) {
    erroModal(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Importar';
  }
}

// Marca (ou desmarca) a unidade como concluída à mão — sem reimportar.
async function marcarManual(td) {
  const t = turmas.find(x => x.id === turmaAberta);
  if (!t || td.dataset.ocupado) return;
  const [i, n] = td.dataset.marcar.split('|').map(Number);
  const aluno = t.alunos[i];
  const desmarcar = (aluno.manuais || []).includes(n);
  td.dataset.ocupado = '1';
  td.classList.add('te-ua-salvando');
  try {
    const atualizado = await apiFetch(`/${MODULO}/${encodeURIComponent(t.id)}/manual`, {
      method: 'PATCH', body: JSON.stringify({ indice: i, nome: aluno.nome, ua: n, concluida: !desmarcar })
    });
    turmas = turmas.map(x => (x.id === t.id ? atualizado : x));
    toast(`${aluno.nome}: UA ${String(n).padStart(2, '0')} ${desmarcar ? 'voltou ao valor do AVA' : 'marcada como concluída'}.`, 'ok');
    render();
  } catch (err) {
    toast(err.message, 'erro');
    delete td.dataset.ocupado;
    td.classList.remove('te-ua-salvando');
  }
}

async function excluirTurma(id) {
  const t = turmas.find(x => x.id === id);
  if (!t || !confirm(`Excluir a turma "${t.disciplina}${t.turma ? ' ' + t.turma : ''}" da Trilha EAD? Dá pra importar de novo depois.`)) return;
  try {
    await apiFetch(`/${MODULO}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Turma excluída.', 'ok');
    await carregarTurmas();
  } catch (err) {
    toast(err.message, 'erro');
  }
}

// ---------------- eventos ----------------

function ligarEventos() {
  $('te-btn-importar').addEventListener('click', abrirImportacao);
  $('te-cancelar').addEventListener('click', fecharImportacao);
  $('te-confirmar').addEventListener('click', confirmarImportacao);
  $('te-arquivo').addEventListener('change', arquivoMudou);
  $('te-semestre-import').addEventListener('change', () => { if ($('te-arquivo').files && $('te-arquivo').files[0]) arquivoMudou(); });
  $('te-modal').addEventListener('click', e => { if (e.target.id === 'te-modal') fecharImportacao(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') fecharImportacao();
    // teclado: Enter/espaço na célula marca ou desmarca
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.marcar) { e.preventDefault(); marcarManual(e.target); }
  });

  $('te-semestre').addEventListener('change', () => {
    turmaAberta = null;
    $('te-bimestre').value = String(bimestreAtual($('te-semestre').value));
    carregarTurmas();
  });
  $('te-curso').addEventListener('change', () => { turmaAberta = null; render(); });
  $('te-bimestre').addEventListener('change', () => render());

  document.querySelectorAll('.abas .aba').forEach(b => b.addEventListener('click', () => {
    aba = b.dataset.aba;
    turmaAberta = null;
    document.querySelectorAll('.abas .aba').forEach(x => {
      x.classList.toggle('ativa', x === b);
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
    render();
  }));

  $('te-tela').addEventListener('click', e => {
    const abrir = e.target.closest('[data-abrir]');
    if (abrir) { turmaAberta = abrir.dataset.abrir; render(); window.scrollTo(0, 0); return; }
    const excluir = e.target.closest('[data-excluir]');
    if (excluir) { excluirTurma(excluir.dataset.excluir); return; }
    const celulaMarcar = e.target.closest('[data-marcar]');
    if (celulaMarcar) { marcarManual(celulaMarcar); return; }
    const imprimir = e.target.closest('[data-imprimir]');
    if (imprimir) { imprimirRanking(imprimir.dataset.imprimir, imprimir.dataset.juntos === '1'); return; }
    const arquivo = e.target.closest('[data-arquivo]');
    if (arquivo) { baixarArquivoEdubox(turmas.find(x => x.id === turmaAberta), Number(arquivo.dataset.arquivo), arquivo.dataset.diario || null); return; }
    if (e.target.id === 'te-voltar') { turmaAberta = null; render(); }
  });
  $('te-tela').addEventListener('change', e => {
    if (e.target.id === 'te-curso-alunos') { cursoRankingAlunos = e.target.value; render(); }
  });
}

// ---------------- auth ----------------

async function initApp(user, role) {
  appInitialized = true;
  initializedRole = role;
  setupLayout(user, role, MODULO, async () => {
    clearCachedAuth();
    await signOut(auth);
    location.href = '../../auth/login.html';
  });
  $('auth-guard').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('te-btn-importar').classList.toggle('hidden', !podeImportar);
  encherSemestres($('te-semestre'), semestreAtual());
  $('te-bimestre').value = String(bimestreAtual(semestreAtual()));
  ligarEventos();

  try {
    cursos = await apiFetch(`/${MODULO}/cursos`);
  } catch (e) { cursos = []; }
  const opcoes = cursos.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $('te-curso').innerHTML = (cursos.length > 1 ? '<option value="">Todos os cursos</option>' : '') + opcoes;
  $('te-curso-import').innerHTML = '<option value="">Escolha...</option>' + opcoes;

  await carregarTurmas();
}

const cached = getCachedAuth();

onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); location.href = '../../auth/login.html'; return; }
  currentUser = user;
  let role = 'visitante', meuOverrides = null;
  try {
    const u = await apiFetch('/usuarios/me');
    role = u.role || 'visitante';
    meuOverrides = u.permissoes || null;
  } catch (e) { role = cached ? cached.role : 'visitante'; }
  setCachedAuth(user, role, await user.getIdToken());

  let nivel = 1;
  if (role === 'adm_l1') nivel = 3;
  else {
    try {
      const perms = await apiFetch('/usuarios/config/permissions');
      const doCargo = perms[role] || {};
      const semConfig = doCargo[MODULO] === undefined && !(meuOverrides && meuOverrides[MODULO] !== undefined);
      nivel = semConfig ? (NIVEL_PADRAO[role] || 1) : getEffectiveLevel(doCargo, meuOverrides, MODULO);
    } catch (e) { nivel = NIVEL_PADRAO[role] || 1; }
  }
  if (nivel < 2) { location.href = '../../meu-espaco/index.html'; return; }
  podeImportar = nivel >= 3;

  if (!appInitialized || initializedRole !== role) initApp(user, role);
});
