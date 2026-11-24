// Portfólio Reflexivo — Medicina / SCIC (23/11/2026)
// O professor sobe o ZIP de "Baixar todas as submissões" da Tarefa do AVA, corrige cada portfólio com a MESMA matriz
// (window.PortfolioMatriz, de /medicina/portfolio/matriz.js — a mesma que o servidor usa pra calcular) e devolve a
// nota ao AVA preenchendo a planilha de avaliação da Tarefa. O PDF é aberto só no navegador; ao servidor vai o texto.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";
import { tutorialHtml } from "./tutorial.js?v=1";

const M = window.PortfolioMatriz;
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';
const BASE = '/portfolio-med';

let currentUser = null;
let iniciado = false;
let dados = null;        // { semestre, editor, eu, turmas, atividades }
let ativ = null;         // { atividade, turma, entregas, editor }
let abaAtiv = 'entregas';
let simil = null;        // resultado da similaridade da atividade aberta
let corr = null;         // { entrega, av, texto, sujo }
const pdfs = new Map();  // `${atividadeId}__${participante}` → [{ nome, url }] (só desta sessão do navegador)

const el = (id) => document.getElementById(id);
const fmt = M.fmt;
const STATUS = { pendente: 'Pendente', rascunho: 'Em correção', finalizada: 'Finalizada' };
const GRAV = { ALTA: 'Alta', MEDIA: 'Média', BAIXA: 'Baixa' };

async function api(endpoint, options = {}) {
  let token = '';
  if (currentUser && typeof currentUser.getIdToken === 'function') token = await currentUser.getIdToken();
  else if (auth.currentUser) token = await auth.currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (!res.ok) {
    let msg = `Erro na API: ${res.status}`, corpo = null;
    try { corpo = await res.json(); if (corpo.error) msg = corpo.error; } catch (e) { /* sem corpo */ }
    throw Object.assign(new Error(msg), { corpo });
  }
  return res.json();
}
const post = (u, b, metodo = 'POST') => api(u, { method: metodo, body: JSON.stringify(b) });
function toast(msg, tipo = 'ok') {
  let t = el('pf-toast');
  if (!t) { t = document.createElement('div'); t.id = 'pf-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.className = `pf-toast pf-toast-${tipo}`; t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4500);
}
const turmaRotulo = (t) => `${t.turma} · ${t.periodo ? `${t.periodo}º período` : ''}`;
const paragrafos = (s) => esc(s || '').replace(/\n/g, '<br>');

// ============================================================ navegação
function trilha(itens) {
  el('pf-trilha').innerHTML = itens.map((it, i) => i < itens.length - 1
    ? `<button type="button" class="pf-trilha-link" data-ir="${esc(it.ir)}">${esc(it.t)}</button><span aria-hidden="true">›</span>`
    : `<span class="pf-trilha-atual">${esc(it.t)}</span>`).join('');
}
function sairDaCorrecao() {
  if (corr && corr.sujo) return confirm('Há alterações não salvas nesta correção. Sair mesmo assim?');
  return true;
}
async function irPara(destino) {
  if (!sairDaCorrecao()) return;
  corr = null;
  if (destino === 'turmas') { history.replaceState(null, '', location.pathname); ativ = null; renderTurmas(); }
  else if (destino === 'atividade') { await abrirAtividade(ativ.atividade.id); }
}

// ============================================================ turmas
async function carregar() {
  el('pf-conteudo').innerHTML = '<div class="pf-vazio">Carregando…</div>';
  try {
    dados = await api(`${BASE}?semestre=${encodeURIComponent(el('pf-semestre').value)}`);
  } catch (e) {
    el('pf-conteudo').innerHTML = `<div class="pf-vazio pf-erro">${esc(e.message)}</div>`;
    return;
  }
  if (location.hash === '#ajuda') return renderAjuda();
  const m = /[#&]a=([\w-]+)/.exec(location.hash);
  if (m) return abrirAtividade(m[1]);
  // primeira visita: abre o "Como usar" uma vez
  let viu = true;
  try { viu = localStorage.getItem('pf_tutorial_visto') === '1'; localStorage.setItem('pf_tutorial_visto', '1'); } catch (e) { /* sem storage */ }
  if (!viu) return renderAjuda();
  renderTurmas();
}

// ============================================================ como usar
let voltarDaAjuda = null;
function renderAjuda() {
  history.replaceState(null, '', '#ajuda');
  trilha([{ t: 'Turmas', ir: 'turmas' }, { t: 'Como usar' }]);
  el('pf-conteudo').innerHTML = tutorialHtml(!!(dados && dados.editor)) +
    `<div class="pf-barra pf-tut-fim"><span></span><button type="button" class="pf-btn pf-btn-pri" data-acao="sair-ajuda">Entendi, ir para as turmas</button></div>`;
  window.scrollTo({ top: 0 });
}
async function abrirAjuda() {
  if (!sairDaCorrecao()) return;
  voltarDaAjuda = ativ ? ativ.atividade.id : null;
  corr = null;
  renderAjuda();
}
function sairAjuda() {
  if (voltarDaAjuda) { const id = voltarDaAjuda; voltarDaAjuda = null; return abrirAtividade(id); }
  history.replaceState(null, '', location.pathname);
  renderTurmas();
}

function renderTurmas() {
  trilha([{ t: 'Turmas' }]);
  const { turmas, atividades, editor } = dados;
  if (!turmas.length) {
    el('pf-conteudo').innerHTML = `<div class="pf-vazio">
      ${editor ? `Nenhuma turma configurada em ${esc(dados.semestre)}.<br><br>
        <button type="button" class="pf-btn pf-btn-pri" data-acao="copiar-semestre">Copiar turmas de outro semestre</button>
        <button type="button" class="pf-btn" data-acao="nova-turma">Configurar turma</button>`
      : `Você ainda não está como professor corretor de nenhuma turma em ${esc(dados.semestre)}. Peça à coordenação de Medicina para incluir você.<br><br>
        <button type="button" class="pf-btn" data-acao="ajuda">Como usar</button>`}
    </div>`;
    return;
  }
  el('pf-conteudo').innerHTML = `
    ${editor ? `<div class="pf-barra"><span class="pf-dica">Você vê todas as turmas (coordenação). Professores veem só as turmas em que estão como corretores.</span>
      <button type="button" class="pf-btn" data-acao="nova-turma">+ Turma</button></div>` : ''}
    <div class="pf-turmas">${turmas.map(t => {
      const ats = atividades.filter(a => a.turmaId === t.id);
      return `<article class="pf-turma">
        <header>
          <span class="pf-tag pf-tag-${esc(t.turma.toLowerCase())}">${esc(t.turma)}</span>
          <div><h2>${esc(t.periodo ? `${t.periodo}º período` : t.turma)}</h2><p>${esc(t.tema || '')}</p></div>
          ${editor ? `<button type="button" class="pf-btn pf-btn-peq" data-acao="config-turma" data-turma="${esc(t.id)}">Configurar</button>` : ''}
        </header>
        ${t.padrao && editor ? '<p class="pf-aviso">Configuração inicial vinda do documento da coordenação. Revise e salve — e escolha os professores corretores.</p>' : ''}
        <blockquote class="pf-questao">${esc(t.questaoNorteadora || '')}</blockquote>
        <p class="pf-meta">${(t.objetivos || []).length} objetivos específicos · Corretores: ${(t.professores || []).length ? esc(t.professores.map(p => p.nome).join(', ')) : '<em>nenhum definido</em>'}</p>
        <div class="pf-ativs">
          ${ats.length ? ats.map(a => `<button type="button" class="pf-ativ" data-acao="abrir-ativ" data-id="${esc(a.id)}">
              <b>${esc(a.titulo)}</b>${a.prazo ? `<span>prazo ${esc(a.prazo.split('-').reverse().join('/'))}</span>` : ''}<span class="pf-seta">›</span></button>`).join('')
            : '<p class="pf-meta">Nenhuma atividade ainda.</p>'}
        </div>
        <button type="button" class="pf-btn pf-btn-pri" data-acao="nova-ativ" data-turma="${esc(t.id)}">+ Atividade (ex.: Portfólio 1)</button>
      </article>`;
    }).join('')}</div>`;
}

function dialogo(html, aoAbrir) {
  const d = el('pf-dialogo');
  d.innerHTML = html;
  d.showModal();
  d.querySelectorAll('[data-fechar]').forEach(b => b.addEventListener('click', () => d.close()));
  if (aoAbrir) aoAbrir(d);
  return d;
}

function dlgNovaAtividade(turmaId) {
  const t = dados.turmas.find(x => x.id === turmaId);
  const n = dados.atividades.filter(a => a.turmaId === turmaId).length + 1;
  dialogo(`<form method="dialog" class="pf-form">
    <h2>Nova atividade — ${esc(turmaRotulo(t))}</h2>
    <label>Nome<input name="titulo" required maxlength="120" value="Portfólio ${n}"></label>
    <label>Prazo de entrega no AVA (opcional)<input name="prazo" type="date"></label>
    <div class="pf-dlg-acoes"><button type="button" class="pf-btn" data-fechar>Cancelar</button><button class="pf-btn pf-btn-pri">Criar</button></div>
  </form>`, (d) => {
    d.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const a = await post(`${BASE}/atividades`, { turmaId, titulo: f.get('titulo'), prazo: f.get('prazo') });
        d.close();
        dados.atividades.push(a);
        abrirAtividade(a.id);
      } catch (err) { toast(err.message, 'erro'); }
    });
  });
}

async function dlgConfigTurma(turmaId) {
  const t = turmaId ? dados.turmas.find(x => x.id === turmaId) : { turma: '', periodo: '', objetivos: [], instrucoes: [], professores: [] };
  let profs = [];
  try { profs = await api(`${BASE}/professores`); } catch (e) { toast(e.message, 'erro'); }
  const marcados = new Set((t.professores || []).map(p => p.uid));
  (t.professores || []).forEach(p => { if (!profs.some(x => x.uid === p.uid)) profs.push(p); });
  dialogo(`<form method="dialog" class="pf-form pf-form-larga">
    <h2>${turmaId ? `Configurar ${esc(turmaRotulo(t))}` : 'Nova turma'} — ${esc(dados.semestre)}</h2>
    <p class="pf-dica">A matriz (4 critérios, níveis e pontos) é fixa e igual para todas as turmas. Aqui fica só o que muda por turma: o "bloco específico".</p>
    <div class="pf-lin">
      <label>Turma<input name="turma" required pattern="T[0-9]{1,2}" placeholder="T1" value="${esc(t.turma)}" ${turmaId ? 'readonly' : ''}></label>
      <label>Período<input name="periodo" type="number" min="1" max="12" value="${esc(t.periodo || '')}"></label>
    </div>
    <label>Componente curricular<input name="componente" maxlength="200" value="${esc(t.componente || 'Saúde, Comunidade e Integralidade do Cuidado (SCIC)')}"></label>
    <label>Tema central<input name="tema" maxlength="300" value="${esc(t.tema || '')}"></label>
    <label>Cenários de prática<input name="cenarios" maxlength="600" value="${esc(t.cenarios || '')}"></label>
    <label>Questão norteadora<textarea name="questaoNorteadora" rows="2" maxlength="500">${esc(t.questaoNorteadora || '')}</textarea></label>
    <label>Objetivo geral<textarea name="objetivoGeral" rows="3" maxlength="1500">${esc(t.objetivoGeral || '')}</textarea></label>
    <label>Objetivos específicos — <b>um por linha</b> (são contados no Critério 3)<textarea name="objetivos" rows="10" required>${esc((t.objetivos || []).join('\n'))}</textarea></label>
    <label>Instruções específicas para a correção — separe cada uma com uma linha em branco<textarea name="instrucoes" rows="8">${esc((t.instrucoes || []).join('\n\n'))}</textarea></label>
    <fieldset class="pf-profs"><legend>Professores corretores desta turma</legend>
      ${profs.length ? profs.map(p => `<label class="pf-chk"><input type="checkbox" name="prof" value="${esc(p.uid)}" data-nome="${esc(p.nome)}" ${marcados.has(p.uid) ? 'checked' : ''}> ${esc(p.nome)}</label>`).join('')
        : '<p class="pf-dica">Nenhum usuário com cargo de Medicina encontrado.</p>'}
    </fieldset>
    <div class="pf-dlg-acoes"><button type="button" class="pf-btn" data-fechar>Cancelar</button><button class="pf-btn pf-btn-pri">Salvar turma</button></div>
  </form>`, (d) => {
    d.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const corpo = {
        periodo: f.periodo.value, componente: f.componente.value, tema: f.tema.value, cenarios: f.cenarios.value,
        questaoNorteadora: f.questaoNorteadora.value, objetivoGeral: f.objetivoGeral.value,
        objetivos: f.objetivos.value.split('\n').map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean),
        instrucoes: f.instrucoes.value.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean),
        professores: [...f.querySelectorAll('input[name=prof]:checked')].map(c => ({ uid: c.value, nome: c.dataset.nome }))
      };
      const turma = f.turma.value.trim().toUpperCase();
      try {
        await post(`${BASE}/turmas/${encodeURIComponent(dados.semestre)}/${encodeURIComponent(turma)}`, corpo, 'PUT');
        d.close(); toast('Turma salva.'); carregar();
      } catch (err) { toast(err.message, 'erro'); }
    });
  });
}

function dlgCopiarSemestre() {
  const opcoes = [...el('pf-semestre').options].map(o => o.value).filter(s => s !== dados.semestre);
  dialogo(`<form method="dialog" class="pf-form">
    <h2>Copiar turmas para ${esc(dados.semestre)}</h2>
    <p class="pf-dica">Copia objetivos, questão norteadora e instruções. Os professores corretores ficam em branco.</p>
    <label>Copiar de<select name="de">${opcoes.map(s => `<option>${esc(s)}</option>`).join('')}</select></label>
    <div class="pf-dlg-acoes"><button type="button" class="pf-btn" data-fechar>Cancelar</button><button class="pf-btn pf-btn-pri">Copiar</button></div>
  </form>`, (d) => {
    d.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await post(`${BASE}/turmas/${encodeURIComponent(dados.semestre)}/copiar`, { de: e.target.de.value }); d.close(); toast(`${r.copiadas} turma(s) copiada(s).`); carregar(); }
      catch (err) { toast(err.message, 'erro'); }
    });
  });
}

// ============================================================ atividade
async function abrirAtividade(id) {
  el('pf-conteudo').innerHTML = '<div class="pf-vazio">Carregando a atividade…</div>';
  try { ativ = await api(`${BASE}/atividades/${encodeURIComponent(id)}`); }
  catch (e) { history.replaceState(null, '', location.pathname); toast(e.message, 'erro'); return renderTurmas(); }
  history.replaceState(null, '', `#a=${id}`);
  simil = null;
  renderAtividade();
}

const chavePdf = (e) => `${e.atividadeId}__${e.participante}`;
function contagem() {
  const c = { total: ativ.entregas.length, pendente: 0, rascunho: 0, finalizada: 0 };
  ativ.entregas.forEach(e => { c[e.status] = (c[e.status] || 0) + 1; });
  return c;
}
const comAlerta = (id) => !!(simil && simil.pares.some(p => p.a === id || p.b === id));

function renderAtividade() {
  const { atividade, turma, entregas } = ativ;
  trilha([{ t: 'Turmas', ir: 'turmas' }, { t: `${turma.turma} · ${atividade.titulo}` }]);
  const c = contagem();
  const pct = c.total ? Math.round(c.finalizada / c.total * 100) : 0;
  el('pf-conteudo').innerHTML = `
    <section class="pf-ativ-cab">
      <div>
        <h2>${esc(atividade.titulo)} <small>${esc(turmaRotulo(turma))}</small></h2>
        <p class="pf-meta">${c.total} entregas · ${c.finalizada} finalizadas · ${c.rascunho} em correção · ${c.pendente} pendentes</p>
        ${atividade.ava ? `<p class="pf-meta">AVA: Tarefa <b>${esc(atividade.ava.tarefaNome)}</b> · ${esc(atividade.ava.cursoNome)}${ativ.editor ? ' · <button type="button" class="pf-link" data-acao="ava-ligar">trocar</button>' : ''}</p>` : ''}
        <div class="pf-progresso" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      </div>
      <div class="pf-acoes">
        ${ativ.editor && atividade.ava ? '<button type="button" class="pf-btn pf-btn-pri" data-acao="ava-buscar">Buscar entregas do AVA</button>' : ''}
        ${ativ.editor && !atividade.ava ? '<button type="button" class="pf-btn pf-btn-pri" data-acao="ava-ligar">Ligar à Tarefa do AVA</button>' : ''}
        <button type="button" class="pf-btn" data-acao="importar">Importar ZIP do AVA</button>
        ${ativ.editor ? '<button type="button" class="pf-btn pf-btn-perigo" data-acao="excluir-ativ">Excluir atividade</button>' : ''}
      </div>
    </section>
    <div id="pf-import" class="pf-import" hidden></div>
    <nav class="pf-abas" role="tablist">
      ${[['entregas', 'Entregas'], ['similaridade', 'Similaridade'], ['resumo', 'Quadro-resumo e AVA']].map(([k, t]) =>
        `<button type="button" role="tab" class="pf-aba ${abaAtiv === k ? 'ativa' : ''}" aria-selected="${abaAtiv === k}" data-aba="${k}">${t}</button>`).join('')}
    </nav>
    <section id="pf-aba"></section>`;
  if (!entregas.length) {
    el('pf-aba').innerHTML = `<div class="pf-vazio pf-passos">
      <h3>Como trazer as entregas do AVA</h3>
      ${atividade.ava ? '<p><b>Esta atividade já está ligada à Tarefa do AVA:</b> clique em <b>Buscar entregas do AVA</b>. O jeito abaixo (ZIP) continua valendo.</p>' : (ativ.editor ? '<p><b>Mais fácil:</b> clique em <b>Ligar à Tarefa do AVA</b> e depois em <b>Buscar entregas do AVA</b>. Ou use o ZIP:</p>' : '')}
      <ol>
        <li>No AVA, abra a <b>Tarefa</b> do portfólio → <b>Ver todos os envios</b>.</li>
        <li>Em <b>Ação de avaliação</b>, escolha <b>Baixar todas as tarefas enviadas</b>. Vem um arquivo .zip.</li>
        <li>Aqui, clique em <b>Importar ZIP do AVA</b> e escolha esse arquivo. Os PDFs são lidos no seu computador.</li>
      </ol>
      <button type="button" class="pf-btn pf-btn-peq" data-acao="ajuda">Ver o passo a passo completo</button></div>`;
    return;
  }
  renderAba();
}

function renderAba() {
  if (abaAtiv === 'similaridade') return renderSimilaridade();
  if (abaAtiv === 'resumo') return renderResumo();
  const { entregas } = ativ;
  el('pf-aba').innerHTML = `<div class="pf-tab-wrap"><table class="pf-tab">
    <thead><tr><th>Estudante</th><th>Arquivo</th><th>Situação</th><th class="num">Nota</th><th>Avisos</th></tr></thead>
    <tbody>${entregas.map(e => {
      const avisos = [];
      if (e.semTexto) avisos.push('<span class="pf-av pf-av-crit">PDF sem texto (escaneado?)</span>');
      if ((e.naoPdf || []).length) avisos.push('<span class="pf-av pf-av-alerta">arquivo não PDF</span>');
      if (e.alteradoAposCorrecao) avisos.push('<span class="pf-av pf-av-alerta">reenviado após a correção</span>');
      if (comAlerta(e.id)) avisos.push('<span class="pf-av pf-av-crit">similaridade</span>');
      if (e.resultado && e.resultado.penalidade !== 'nenhuma') avisos.push(`<span class="pf-av">${esc(M.PENALIDADES[e.resultado.penalidade].rotulo)}</span>`);
      return `<tr tabindex="0" data-acao="corrigir" data-id="${esc(e.id)}">
        <td><b>${esc(e.nome)}</b>${e.corrigidoPor ? `<small>corrigido por ${esc(e.corrigidoPor)}</small>` : ''}</td>
        <td><small>${esc((e.arquivos || []).join(', ') || '—')}</small>${pdfs.has(chavePdf(e)) ? '' : ''}</td>
        <td><span class="pf-st pf-st-${esc(e.status)}">${STATUS[e.status] || e.status}</span></td>
        <td class="num">${e.resultado ? fmt(e.resultado.nota) : '—'}</td>
        <td>${avisos.join(' ')}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

// ---------- importação do ZIP (tudo no navegador) ----------
// Nomes do "Baixar todas as tarefas enviadas" do Moodle/Open LMS:
//   "Fulano de Tal_123456_assignsubmission_file_/portfolio.pdf"   (em pastas)
//   "Fulano de Tal_123456_assignsubmission_file_portfolio.pdf"    (sem pastas)
const RE_MOODLE = /(?:^|\/)([^/]+?)_(\d+)_assignsubmission_([a-z]+)_?(?:\/|$)?(.*)$/;
function participanteDe(caminho) {
  const m = RE_MOODLE.exec(caminho);
  if (!m) return null;
  return { nome: m[1].trim(), participante: m[2], plugin: m[3], arquivo: (m[4] || '').split('/').pop() || caminho.split('/').pop() };
}

async function textoDoPdf(bytes) {
  const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  const partes = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const tc = await pg.getTextContent();
    let s = '';
    tc.items.forEach(it => { s += it.str; s += it.hasEOL ? '\n' : ' '; });
    partes.push(`[[p.${p}]]\n${s.replace(/[ \t]+/g, ' ').trim()}`);
  }
  return { texto: partes.join('\n\n'), paginas: doc.numPages };
}

async function importarZip(arquivo) {
  if (!window.JSZip || !window.pdfjsLib) { toast('As bibliotecas de leitura ainda estão carregando. Tente de novo em alguns segundos.', 'erro'); return; }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const caixa = el('pf-import');
  caixa.hidden = false;
  const msg = (h) => { caixa.innerHTML = h; };
  msg('Abrindo o ZIP…');
  let zip;
  try { zip = await window.JSZip.loadAsync(arquivo); }
  catch (e) { msg(`<b>Não consegui abrir esse arquivo como ZIP.</b> ${esc(e.message)}`); return; }

  const grupos = new Map();
  const ignorados = [];
  zip.forEach((caminho, ent) => {
    if (ent.dir || /(^|\/)(__MACOSX|\.DS_Store)/.test(caminho)) return;
    const info = participanteDe(caminho);
    if (!info) { ignorados.push(caminho); return; }
    if (!grupos.has(info.participante)) grupos.set(info.participante, { nome: info.nome, participante: info.participante, itens: [] });
    grupos.get(info.participante).itens.push({ ...info, ent });
  });
  if (!grupos.size) {
    msg(`<b>Nenhuma entrega reconhecida.</b> Use o ZIP de <b>Baixar todas as tarefas enviadas</b> da Tarefa do AVA (os arquivos vêm com o nome do aluno e o número do participante).${ignorados.length ? `<br><small>Arquivos ignorados: ${esc(ignorados.slice(0, 5).join(', '))}</small>` : ''}`);
    return;
  }
  let feitos = 0, erros = [];
  const total = grupos.size;
  for (const g of grupos.values()) {
    msg(`Lendo e enviando <b>${feitos + 1}</b> de <b>${total}</b>: ${esc(g.nome)}…<div class="pf-progresso"><span style="width:${Math.round(feitos / total * 100)}%"></span></div>`);
    const textos = [], arquivos = [], naoPdf = [], urls = [];
    let paginas = 0;
    for (const it of g.itens) {
      arquivos.push(it.arquivo);
      if (/\.pdf$/i.test(it.arquivo)) {
        try {
          const bytes = await it.ent.async('uint8array');
          urls.push({ nome: it.arquivo, url: URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })) });
          const r = await textoDoPdf(bytes.slice());
          textos.push(r.texto); paginas += r.paginas;
        } catch (e) { erros.push(`${g.nome}: ${it.arquivo} — PDF ilegível ou corrompido`); }
      } else if (it.plugin === 'onlinetext' || /\.html?$/i.test(it.arquivo)) {
        const h = await it.ent.async('string');
        const d = new DOMParser().parseFromString(h, 'text/html');
        textos.push(d.body ? d.body.innerText || d.body.textContent : '');
      } else {
        naoPdf.push(it.arquivo);
        const blob = await it.ent.async('blob');
        urls.push({ nome: it.arquivo, url: URL.createObjectURL(blob), naoPdf: true });
      }
    }
    const texto = textos.join('\n\n');
    try {
      await post(`${BASE}/atividades/${encodeURIComponent(ativ.atividade.id)}/entregas`, {
        participante: g.participante, nome: g.nome, arquivos, naoPdf, paginas,
        palavras: texto.replace(/\[\[p\.\d+\]\]/g, ' ').split(/\s+/).filter(Boolean).length, texto
      });
      pdfs.set(`${ativ.atividade.id}__${g.participante}`, urls);
    } catch (e) { erros.push(`${g.nome}: ${e.message}`); }
    feitos++;
  }
  await abrirAtividade(ativ.atividade.id);
  const c2 = el('pf-import');
  c2.hidden = false;
  c2.innerHTML = `<b>${total - erros.length} de ${total} entregas importadas.</b> Os PDFs ficam abertos só neste navegador enquanto a página estiver aberta — se recarregar, importe o ZIP de novo para vê-los (as correções não se perdem).
    ${erros.length ? `<ul class="pf-erros">${erros.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${ignorados.length ? `<small>${ignorados.length} arquivo(s) fora do padrão do AVA foram ignorados.</small>` : ''}`;
}

// ============================================================ integração com o AVA (24/11/2026)
// A atividade é ligada à Tarefa do AVA; "Buscar entregas do AVA" substitui o ZIP e "Lançar notas no AVA" substitui a
// planilha offline. O token do AVA fica no servidor: os PDFs vêm pelo Órbita (/ava/arquivo).
// Cursos de SCIC de 2026.2 no AVA (o "id=" do link da disciplina) — só para já vir preenchido; dá para trocar.
const AVA_CURSO_PADRAO = { '2026.2__T1': 3645, '2026.2__T2': 3640, '2026.2__T3': 3632 };

async function arquivoDoAva(caminho) {
  let token = '';
  if (currentUser && typeof currentUser.getIdToken === 'function') token = await currentUser.getIdToken();
  else if (auth.currentUser) token = await auth.currentUser.getIdToken();
  const r = await fetch(`${API_BASE}${BASE}/atividades/${encodeURIComponent(ativ.atividade.id)}/ava/arquivo?c=${encodeURIComponent(caminho)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) { let m = `Erro ${r.status}`; try { m = (await r.json()).error || m; } catch (e) { /* sem corpo */ } throw new Error(m); }
  return r.blob();
}

function dlgLigarAva() {
  const { atividade, turma } = ativ;
  const atual = atividade.ava || {};
  const cursoIni = atual.cursoId || AVA_CURSO_PADRAO[turma.id] || '';
  dialogo(`<form method="dialog" class="pf-form" id="pf-f-ava">
    <h2>Ligar à Tarefa do AVA — ${esc(turmaRotulo(turma))}</h2>
    <p class="pf-meta">Número do curso no AVA: abra a disciplina de SCIC no AVA e copie o número que vem depois de <b>id=</b> no endereço.</p>
    <label>Número do curso no AVA<input name="curso" inputmode="numeric" required value="${esc(String(cursoIni))}"></label>
    <div class="pf-dlg-acoes" style="justify-content:flex-start"><button type="button" class="pf-btn" data-ava-procurar>Procurar as Tarefas desse curso</button></div>
    <div id="pf-ava-tarefas"></div>
    <div class="pf-dlg-acoes"><button type="button" class="pf-btn" data-fechar>Cancelar</button><button class="pf-btn pf-btn-pri" id="pf-ava-ligar" disabled>Ligar</button></div>
  </form>`, (d) => {
    const caixa = d.querySelector('#pf-ava-tarefas');
    const procurar = async () => {
      caixa.innerHTML = '<p class="pf-meta">Procurando no AVA…</p>';
      try {
        const r = await api(`${BASE}/ava/tarefas?curso=${encodeURIComponent(d.querySelector('[name=curso]').value.trim())}`);
        if (!r.tarefas.length) { caixa.innerHTML = '<p class="pf-aviso">Esse curso não tem Tarefas no AVA.</p>'; return; }
        const pre = (atual.tarefaId && r.tarefas.find(t => t.id === atual.tarefaId)) || r.tarefas.find(t => /portf/i.test(t.nome)) || r.tarefas[0];
        caixa.innerHTML = `<p class="pf-meta"><b>${esc(r.curso.nome)}</b></p>
          <fieldset class="pf-ava-lista"><legend>Tarefa</legend>${r.tarefas.map(t => `<label class="pf-ava-op"><input type="radio" name="tarefa" value="${t.id}" ${t.id === pre.id ? 'checked' : ''}>
            ${esc(t.nome)} <small>${t.prazo ? `entrega até ${new Date(t.prazo * 1000).toLocaleDateString('pt-BR')}` : 'sem prazo'} · vale ${t.notaMax}${t.anonimo ? ' · envio anônimo' : ''}</small></label>`).join('')}</fieldset>`;
        d.querySelector('#pf-ava-ligar').disabled = false;
      } catch (err) { caixa.innerHTML = `<p class="pf-aviso">${esc(err.message)}</p>`; }
    };
    d.querySelector('[data-ava-procurar]').addEventListener('click', procurar);
    if (cursoIni) procurar();
    d.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const tarefa = (d.querySelector('[name=tarefa]:checked') || {}).value;
      if (!tarefa) return;
      try {
        const r = await post(`${BASE}/atividades/${encodeURIComponent(atividade.id)}/ava`, { cursoId: d.querySelector('[name=curso]').value.trim(), tarefaId: tarefa }, 'PUT');
        ativ.atividade.ava = r.ava;
        d.close();
        toast(`Ligada à Tarefa "${r.ava.tarefaNome}" do AVA.`);
        renderAtividade();
      } catch (err) { toast(err.message, 'erro'); }
    });
  });
}

// mesma leitura do ZIP, mas os arquivos vêm do AVA pelo Órbita
async function buscarEntregasAva() {
  if (!window.pdfjsLib) { toast('A biblioteca de leitura de PDF ainda está carregando. Tente de novo em alguns segundos.', 'erro'); return; }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const caixa = el('pf-import');
  caixa.hidden = false;
  const msg = (h) => { caixa.innerHTML = h; };
  msg('Consultando os envios no AVA…');
  let r;
  try { r = await api(`${BASE}/atividades/${encodeURIComponent(ativ.atividade.id)}/ava/entregas`); }
  catch (e) { msg(`<b>Não consegui consultar o AVA.</b> ${esc(e.message)}`); return; }
  if (!r.itens.length) { msg(`<b>Nenhum envio na Tarefa "${esc(r.tarefa.tarefaNome)}" até agora</b> (${r.participantes} participantes).`); return; }
  let feitos = 0;
  const erros = [];
  for (const it of r.itens) {
    msg(`Lendo e enviando <b>${feitos + 1}</b> de <b>${r.itens.length}</b>: ${esc(it.nome)}…<div class="pf-progresso"><span style="width:${Math.round(feitos / r.itens.length * 100)}%"></span></div>`);
    const textos = it.textoOnline ? [new DOMParser().parseFromString(it.textoOnline, 'text/html').body.innerText || ''] : [];
    const arquivos = [], naoPdf = [], urls = [];
    let paginas = 0;
    for (const a of it.arquivos) {
      arquivos.push(a.nome);
      try {
        const blob = await arquivoDoAva(a.caminho);
        const ehPdf = /\.pdf$/i.test(a.nome) || /pdf/.test(a.tipo);
        urls.push({ nome: a.nome, url: URL.createObjectURL(blob), naoPdf: !ehPdf });
        if (ehPdf) { const t = await textoDoPdf(new Uint8Array(await blob.arrayBuffer())); textos.push(t.texto); paginas += t.paginas; }
        else naoPdf.push(a.nome);
      } catch (e) {
        // pdf.js: "Invalid PDF structure" = arquivo cortado/corrompido já no AVA (ex.: envio interrompido)
        const m = /invalid pdf|missing pdf|unexpected end/i.test(e.message) ? 'o PDF está incompleto ou corrompido no próprio AVA (o envio pode ter sido interrompido). Peça ao aluno para enviar de novo.' : e.message;
        erros.push(`${it.nome}: ${a.nome} — ${m}`);
      }
    }
    const texto = textos.join('\n\n');
    try {
      await post(`${BASE}/atividades/${encodeURIComponent(ativ.atividade.id)}/entregas`, {
        participante: `u${it.userid}`, nome: it.nome, arquivos, naoPdf, paginas,
        palavras: texto.replace(/\[\[p\.\d+\]\]/g, ' ').split(/\s+/).filter(Boolean).length, texto,
        avaArquivos: it.arquivos.map(a => ({ nome: a.nome, caminho: a.caminho }))
      });
      pdfs.set(`${ativ.atividade.id}__u${it.userid}`, urls);
    } catch (e) { erros.push(`${it.nome}: ${e.message}`); }
    feitos++;
  }
  await abrirAtividade(ativ.atividade.id);
  const c2 = el('pf-import');
  c2.hidden = false;
  c2.innerHTML = `<b>${r.itens.length - erros.length} de ${r.itens.length} envios trazidos do AVA</b> (${r.participantes} participantes na Tarefa). Pode buscar de novo quando chegarem outros envios: quem já foi corrigido não perde a correção.
    ${erros.length ? `<ul class="pf-erros">${erros.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
}

// abre o PDF da entrega vinda do AVA (quando não está nesta sessão do navegador)
async function carregarPdfsAva(entrega) {
  const urls = [];
  for (const a of entrega.avaArquivos || []) {
    const blob = await arquivoDoAva(a.caminho);
    urls.push({ nome: a.nome, url: URL.createObjectURL(blob), naoPdf: !/\.pdf$/i.test(a.nome) });
  }
  pdfs.set(chavePdf(entrega), urls);
}

async function dlgLancarNotasAva() {
  let r;
  try { r = await api(`${BASE}/atividades/${encodeURIComponent(ativ.atividade.id)}/ava/notas`); }
  catch (e) { toast(e.message, 'erro'); return; }
  if (!r.itens.length) { toast(r.semAluno ? `Nenhuma nota pronta: ${r.semAluno} correção(ões) finalizada(s) vieram do ZIP — use a planilha ou busque as entregas pelo AVA.` : 'Nenhuma correção finalizada para lançar.', 'erro'); return; }
  dialogo(`<form method="dialog" class="pf-form">
    <h2>Lançar notas no AVA</h2>
    <p class="pf-meta">Tarefa <b>${esc(r.tarefa.tarefaNome)}</b> (${esc(r.tarefa.cursoNome)}), que vale <b>${r.tarefa.notaMax}</b>: a nota da matriz (0 a 10) vai × ${String(r.tarefa.notaMax / 10).replace('.', ',')}. Vai também o feedback de cada aluno. Confira antes de lançar.</p>
    <div class="pf-tab-wrap" style="max-height:50vh;overflow:auto"><table class="pf-tab"><thead><tr><th></th><th>Estudante</th><th class="num">Nota</th><th class="num">No AVA</th><th>Situação</th></tr></thead>
    <tbody>${r.itens.map(i => `<tr><td><input type="checkbox" data-lancar="${esc(i.id)}" ${i.jaLancada ? '' : 'checked'} aria-label="Lançar ${esc(i.nome)}"></td><td>${esc(i.nome)}</td><td class="num">${fmt(i.nota)}</td><td class="num"><b>${String(i.notaAva).replace('.', ',')}</b></td>
      <td>${i.jaLancada ? `<small>já lançada em ${new Date(i.lancadaEm).toLocaleDateString('pt-BR')}</small>` : '<small>nova</small>'}</td></tr>`).join('')}</tbody></table></div>
    ${r.semAluno ? `<p class="pf-aviso">${r.semAluno} correção(ões) finalizada(s) vieram do ZIP e não vão por aqui (use a planilha).</p>` : ''}
    <div class="pf-dlg-acoes"><button type="button" class="pf-btn" data-fechar>Cancelar</button><button class="pf-btn pf-btn-pri">Lançar as marcadas no AVA</button></div>
  </form>`, (d) => {
    d.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ids = [...d.querySelectorAll('[data-lancar]:checked')].map(x => x.dataset.lancar);
      if (!ids.length) { toast('Marque pelo menos um aluno.', 'erro'); return; }
      const b = d.querySelector('.pf-btn-pri'); b.disabled = true; b.textContent = 'Lançando…';
      try {
        const res = await post(`${BASE}/atividades/${encodeURIComponent(ativ.atividade.id)}/ava/notas`, { ids, confirmar: true });
        d.close();
        toast(res.message, res.erros.length ? 'alerta' : 'ok');
        if (res.erros.length) alert(`Não lançadas:\n${res.erros.join('\n')}`);
        abrirAtividade(ativ.atividade.id);
      } catch (err) { toast(err.message, 'erro'); b.disabled = false; b.textContent = 'Lançar as marcadas no AVA'; }
    });
  });
}

// ============================================================ correção
async function abrirCorrecao(id) {
  if (!sairDaCorrecao()) return;
  const entrega = ativ.entregas.find(e => e.id === id);
  if (!entrega) return;
  const totalObj = (ativ.turma.objetivos || []).length;
  const base = entrega.avaliacao || {};
  const av = {
    c1: { nivel: null, justificativa: '', ...(base.c1 || {}) },
    c2: { analise: null, necessidades: false, acoes: false, nivelManual: null, justificativa: '', ...(base.c2 || {}) },
    c3: { justificativa: '', ...(base.c3 || {}), objetivos: Array.from({ length: totalObj }, (_, i) => !!(base.c3 && base.c3.objetivos && base.c3.objetivos[i])) },
    c4: { nivel: null, justificativa: '', ...(base.c4 || {}) },
    feedback: { fortes: '', desenvolver: '', recomendacao: '', ...(base.feedback || {}) },
    conformidade: { capa: '', capaFaltando: [], formatacao: '', foraAva: false, obs: '', ...(base.conformidade || {}) },
    penalidade: base.penalidade || 'nenhuma'
  };
  corr = { entrega, av, texto: null, sujo: false };
  renderCorrecao();
  try { corr.texto = (await api(`${BASE}/entregas/${encodeURIComponent(id)}/texto`)).texto; } catch (e) { corr.texto = ''; }
  if (corr && corr.entrega.id === id) renderLeitor();
}

function nivelRadios(c, valor, nome) {
  return `<div class="pf-niveis">${M.NIVEIS.map(n => {
    const nv = c.niveis[n];
    return `<label class="pf-nivel pf-nivel-${n.toLowerCase()}"><input type="radio" name="${nome}" value="${n}" ${valor === n ? 'checked' : ''}>
      <span class="pf-nivel-cab"><b>${M.NOME_NIVEL[n]}</b><em>${fmt(nv.pts)} pt</em></span>
      <span class="pf-nivel-desc">"${esc(nv.descritor)}"</span>
      <span class="pf-nivel-apl">${esc(nv.aplicar)}</span></label>`;
  }).join('')}</div>`;
}
const just = (id, v, ph) => `<label class="pf-just">Evidência no texto / justificativa <span class="pf-obrig">obrigatória</span>
  <textarea data-campo="${id}.justificativa" rows="3" placeholder="${esc(ph)}">${esc(v || '')}</textarea></label>`;

function renderCorrecao() {
  const { entrega, av } = corr;
  const { turma, entregas } = ativ;
  const i = entregas.findIndex(e => e.id === entrega.id);
  trilha([{ t: 'Turmas', ir: 'turmas' }, { t: `${turma.turma} · ${ativ.atividade.titulo}`, ir: 'atividade' }, { t: entrega.nome }]);
  const [c1, c2, c3, c4] = M.CRITERIOS;
  el('pf-conteudo').innerHTML = `
  <div class="pf-corr-cab">
    <div><h2>${esc(entrega.nome)}</h2><p class="pf-meta">${esc((entrega.arquivos || []).join(', '))} · ${entrega.paginas || 0} pág. · ${entrega.palavras || 0} palavras
      ${entrega.corrigidoPor ? ` · última correção: ${esc(entrega.corrigidoPor)}` : ''}</p></div>
    <div class="pf-acoes">
      <button type="button" class="pf-btn" data-acao="anterior" ${i <= 0 ? 'disabled' : ''}>‹ Anterior</button>
      <span class="pf-meta">${i + 1} de ${entregas.length}</span>
      <button type="button" class="pf-btn" data-acao="proximo" ${i >= entregas.length - 1 ? 'disabled' : ''}>Próximo ›</button>
    </div>
  </div>
  ${entrega.alteradoAposCorrecao ? '<p class="pf-aviso">O aluno reenviou o arquivo depois que esta correção foi finalizada. Confira se a correção ainda vale.</p>' : ''}
  <div class="pf-corr">
    <section class="pf-leitor" id="pf-leitor" aria-label="Portfólio do estudante"><div class="pf-vazio">Carregando o texto…</div></section>
    <form class="pf-matriz" id="pf-matriz" autocomplete="off">
      <details class="pf-turma-info">
        <summary>Questão norteadora e instruções da ${esc(turma.turma)}</summary>
        <blockquote class="pf-questao">${esc(turma.questaoNorteadora || '')}</blockquote>
        <ol>${(turma.instrucoes || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol>
        <p class="pf-dica">Regra geral: nunca presuma — se o critério não puder ser verificado no texto, é Insuficiente, com "não evidenciado no texto".</p>
      </details>

      <fieldset class="pf-crit"><legend><span>1</span>${esc(c1.nome)} <em>máx. ${fmt(c1.max)}</em></legend>
        <p class="pf-avalia">${esc(c1.avalia)}</p>
        ${nivelRadios(c1, av.c1.nivel, 'c1.nivel')}
        ${just('c1', av.c1.justificativa, 'Cite o trecho entre aspas ou indique a página (ex.: p. 3, "…").')}
      </fieldset>

      <fieldset class="pf-crit"><legend><span>2</span>${esc(c2.nome)} <em>máx. ${fmt(c2.max)}</em></legend>
        <p class="pf-avalia">${esc(c2.avalia)}</p>
        <div class="pf-elem">
          <p><b>(a) Análise crítica</b></p>
          ${[['consistente', 'Consistente'], ['superficial', 'Superficial'], ['ausente', 'Ausente ou com incoerências graves']].map(([v, t]) =>
            `<label class="pf-chk"><input type="radio" name="c2.analise" value="${v}" ${av.c2.analise === v ? 'checked' : ''}> ${t}</label>`).join('')}
          <p><b>Os outros dois elementos</b></p>
          <label class="pf-chk"><input type="checkbox" name="c2.necessidades" ${av.c2.necessidades ? 'checked' : ''}> (b) Identifica necessidades</label>
          <label class="pf-chk"><input type="checkbox" name="c2.acoes" ${av.c2.acoes ? 'checked' : ''}> (c) Propõe ações</label>
        </div>
        <div id="pf-c2-res" class="pf-res-crit"></div>
        ${just('c2', av.c2.justificativa, 'Evidência dos 3 elementos: análise crítica + necessidades + propostas de ação.')}
      </fieldset>

      <fieldset class="pf-crit"><legend><span>3</span>${esc(c3.nome)} <em>máx. ${fmt(c3.max)}</em></legend>
        <p class="pf-avalia">Marque os objetivos da ${esc(turma.turma)} que o portfólio <b>menciona, discute e atinge</b>. O nível sai da proporção.</p>
        <div class="pf-objs">${(turma.objetivos || []).map((o, k) =>
          `<label class="pf-chk pf-obj"><input type="checkbox" name="c3.obj" data-k="${k}" ${av.c3.objetivos[k] ? 'checked' : ''}><span><b>${k + 1}.</b> ${esc(o)}</span></label>`).join('')}</div>
        <div id="pf-c3-res" class="pf-res-crit"></div>
        ${just('c3', av.c3.justificativa, 'Onde cada objetivo atingido aparece no texto (página/trecho).')}
      </fieldset>

      <fieldset class="pf-crit"><legend><span>4</span>${esc(c4.nome)} <em>máx. ${fmt(c4.max)}</em></legend>
        <p class="pf-avalia">${esc(c4.avalia)} <br><small>Verifique: ${esc(c4.verificar)}</small></p>
        ${nivelRadios(c4, av.c4.nivel, 'c4.nivel')}
        ${just('c4', av.c4.justificativa, 'Coesão, coerência, estrutura e desvios gramaticais encontrados (com exemplos).')}
      </fieldset>

      <fieldset class="pf-crit"><legend>Feedback ao estudante <em>3 a 6 linhas, direto, acolhedor e formativo</em></legend>
        <label>Pontos fortes<textarea data-campo="feedback.fortes" rows="2">${esc(av.feedback.fortes)}</textarea></label>
        <label>Pontos a desenvolver<textarea data-campo="feedback.desenvolver" rows="2">${esc(av.feedback.desenvolver)}</textarea></label>
        <label>Recomendação prática<textarea data-campo="feedback.recomendacao" rows="2">${esc(av.feedback.recomendacao)}</textarea></label>
        <p class="pf-dica">Não reescreva o portfólio pelo aluno: aponte o que está bom, o que falta e como melhorar.</p>
      </fieldset>

      <fieldset class="pf-crit"><legend>Observações de conformidade <em>não alteram a nota</em></legend>
        <p><b>Capa</b> (6 itens obrigatórios)</p>
        ${[['completa', 'Completa'], ['incompleta', 'Incompleta'], ['ausente', 'Ausente']].map(([v, t]) =>
          `<label class="pf-chk pf-inline"><input type="radio" name="conf.capa" value="${v}" ${av.conformidade.capa === v ? 'checked' : ''}> ${t}</label>`).join('')}
        <div class="pf-capa" ${av.conformidade.capa === 'incompleta' ? '' : 'hidden'}>Faltando:
          ${M.ITENS_CAPA.map(x => `<label class="pf-chk pf-inline"><input type="checkbox" name="conf.capaFaltando" value="${esc(x)}" ${av.conformidade.capaFaltando.includes(x) ? 'checked' : ''}> ${esc(x)}</label>`).join('')}</div>
        <label>Formatação / ABNT / padronização visual<input data-campo="conformidade.formatacao" value="${esc(av.conformidade.formatacao)}"></label>
        <label class="pf-chk"><input type="checkbox" name="conf.foraAva" ${av.conformidade.foraAva ? 'checked' : ''}> Houve entrega por outro canal (e-mail, WhatsApp)</label>
        <label>Outras observações<textarea data-campo="conformidade.obs" rows="2">${esc(av.conformidade.obs)}</textarea></label>
      </fieldset>

      <fieldset class="pf-crit"><legend>Condições especiais <em>decisão do professor — o sistema só aplica o que você marcar</em></legend>
        ${Object.entries(M.PENALIDADES).map(([k, p]) => `<label class="pf-chk"><input type="radio" name="penalidade" value="${k}" ${av.penalidade === k ? 'checked' : ''}> ${esc(p.rotulo)}</label>`).join('')}
        <div id="pf-simil-aviso"></div>
      </fieldset>

      <div class="pf-total" id="pf-total"></div>
    </form>
  </div>`;
  renderLeitor();
  atualizarResultado();
  avisoSimilaridade();
}

// Modo leitura (24/11/2026): o PDF na tela inteira, uma página por vez, como apresentação.
// Setas / PageUp / PageDown / espaço / clique na página mudam a página; "Ampliar" encaixa na largura (rola); Esc sai.
async function modoLeitura(url) {
  if (!window.pdfjsLib) { toast('A biblioteca de leitura de PDF ainda está carregando. Tente de novo em alguns segundos.', 'erro'); return; }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  let doc;
  try { doc = await window.pdfjsLib.getDocument(url).promise; } catch (e) { toast(`Não consegui abrir o PDF: ${e.message}`, 'erro'); return; }
  const ov = document.createElement('div');
  ov.className = 'pf-slide';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-label', 'Leitura do portfólio em tela cheia');
  ov.tabIndex = -1;
  ov.innerHTML = `<div class="pf-slide-palco"><canvas title="Clique para a próxima página"></canvas></div>
    <div class="pf-slide-barra">
      <button type="button" data-s="ant" aria-label="Página anterior">‹ Anterior</button>
      <span data-s="num"></span>
      <button type="button" data-s="prox" aria-label="Próxima página">Próxima ›</button>
      <button type="button" data-s="zoom">Ampliar</button>
      <button type="button" data-s="sair">Sair (Esc)</button>
    </div>`;
  document.body.appendChild(ov);
  const palco = ov.querySelector('.pf-slide-palco'), canvas = ov.querySelector('canvas'), ctx = canvas.getContext('2d');
  let n = 1, largura = false, tarefa = null, fechado = false;
  const desenha = async () => {
    const pag = await doc.getPage(n);
    const v1 = pag.getViewport({ scale: 1 });
    const w = palco.clientWidth - 24, h = palco.clientHeight - 24;
    const escala = largura ? w / v1.width : Math.min(w / v1.width, h / v1.height);
    const dpr = window.devicePixelRatio || 1;
    const vp = pag.getViewport({ scale: escala * dpr });
    if (tarefa) tarefa.cancel();
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = `${Math.floor(vp.width / dpr)}px`; canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
    tarefa = pag.render({ canvasContext: ctx, viewport: vp });
    try { await tarefa.promise; } catch (e) { /* trocou de página no meio */ }
    ov.querySelector('[data-s=num]').textContent = `Página ${n} de ${doc.numPages}`;
    ov.querySelector('[data-s=ant]').disabled = n <= 1;
    ov.querySelector('[data-s=prox]').disabled = n >= doc.numPages;
    ov.querySelector('[data-s=zoom]').textContent = largura ? 'Página inteira' : 'Ampliar';
    palco.scrollTop = 0;
  };
  const vai = (d) => { const m = Math.min(doc.numPages, Math.max(1, n + d)); if (m !== n) { n = m; desenha(); } };
  const fecha = () => {
    if (fechado) return;
    fechado = true;
    document.removeEventListener('keydown', tecla, true);
    document.removeEventListener('fullscreenchange', saiuTela);
    window.removeEventListener('resize', desenha);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    ov.remove();
    doc.destroy();
  };
  const tecla = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); fecha(); }
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key) && !(largura && e.key === 'ArrowDown')) { e.preventDefault(); vai(1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key) && !(largura && e.key === 'ArrowUp')) { e.preventDefault(); vai(-1); }
    else return;
    e.stopPropagation();
  };
  const saiuTela = () => { if (!document.fullscreenElement) fecha(); };
  document.addEventListener('keydown', tecla, true);
  window.addEventListener('resize', desenha);
  canvas.addEventListener('click', () => vai(1));
  ov.querySelector('.pf-slide-barra').addEventListener('click', (e) => {
    const s = (e.target.closest('[data-s]') || {}).dataset;
    if (!s) return;
    if (s.s === 'ant') vai(-1);
    else if (s.s === 'prox') vai(1);
    else if (s.s === 'zoom') { largura = !largura; desenha(); }
    else if (s.s === 'sair') fecha();
  });
  ov.focus();
  desenha();
  // tela cheia do navegador quando der; se não der, fica a sobreposição do tamanho da janela
  if (ov.requestFullscreen) ov.requestFullscreen().then(() => { if (!fechado) document.addEventListener('fullscreenchange', saiuTela); }).catch(() => {});
}

function renderLeitor() {
  const box = el('pf-leitor');
  if (!box || !corr) return;
  const arqs = pdfs.get(chavePdf(corr.entrega)) || [];
  const modo = box.dataset.modo || (arqs.length ? 'pdf' : 'texto');
  box.dataset.modo = modo;
  const alterna = `<div class="pf-leitor-barra">
    <div class="pf-abas pf-abas-peq">
      <button type="button" class="pf-aba ${modo === 'pdf' ? 'ativa' : ''}" data-leitor="pdf" ${arqs.length ? '' : 'disabled title="Abra o PDF do AVA ou importe o ZIP para ver o PDF"'}>PDF</button>
      <button type="button" class="pf-aba ${modo === 'texto' ? 'ativa' : ''}" data-leitor="texto">Texto extraído</button>
    </div>
    ${modo === 'pdf' && arqs.some(a => !a.naoPdf) ? '<button type="button" class="pf-btn pf-btn-pri pf-btn-peq" data-acao="leitura" title="Uma página por vez na tela inteira. Setas mudam a página, Esc sai.">Ler em tela cheia</button>' : ''}
    ${!arqs.length ? ((corr.entrega.avaArquivos || []).length ? '<button type="button" class="pf-btn pf-btn-peq" data-acao="ava-pdf">Abrir o PDF do AVA</button>' : '<button type="button" class="pf-btn pf-btn-peq" data-acao="importar">Carregar ZIP para ver o PDF</button>') : ''}
  </div>`;
  if (modo === 'pdf' && arqs.length) {
    box.innerHTML = alterna + arqs.map(a => a.naoPdf
      ? `<p class="pf-aviso">Arquivo não PDF: <a href="${a.url}" download="${esc(a.nome)}">${esc(a.nome)}</a> (baixe para abrir).</p>`
      // sem a barra de miniaturas do leitor do navegador e com a página na largura do quadro (24/11/2026)
      : `<iframe class="pf-pdf" src="${a.url}#pagemode=none&navpanes=0&view=FitH" title="${esc(a.nome)}"></iframe>`).join('');
    return;
  }
  if (corr.texto == null) { box.innerHTML = alterna + '<div class="pf-vazio">Carregando o texto…</div>'; return; }
  const t = corr.texto.trim();
  box.innerHTML = alterna + (t
    ? `<article class="pf-texto">${esc(t).split(/\[\[p\.(\d+)\]\]/).map((parte, k) => (k % 2 ? `<div class="pf-pag">página ${parte}</div>` : parte.replace(/\n/g, '<br>'))).join('')}</article>`
    : '<p class="pf-aviso">Sem texto extraído (PDF escaneado como imagem, ou arquivo não PDF). Avalie pelo PDF original.</p>');
}

function lerForm() {
  const f = el('pf-matriz');
  if (!f) return;
  const av = corr.av;
  const v = (n) => { const x = f.querySelector(`input[name="${n}"]:checked`); return x ? x.value : null; };
  av.c1.nivel = v('c1.nivel');
  av.c4.nivel = v('c4.nivel');
  av.c2.analise = v('c2.analise');
  av.c2.necessidades = f.querySelector('input[name="c2.necessidades"]').checked;
  av.c2.acoes = f.querySelector('input[name="c2.acoes"]').checked;
  const man = f.querySelector('select[name="c2.nivelManual"]');
  av.c2.nivelManual = man ? (man.value || null) : av.c2.nivelManual;
  f.querySelectorAll('input[name="c3.obj"]').forEach(c => { av.c3.objetivos[+c.dataset.k] = c.checked; });
  av.conformidade.capa = v('conf.capa') || '';
  av.conformidade.capaFaltando = [...f.querySelectorAll('input[name="conf.capaFaltando"]:checked')].map(c => c.value);
  av.conformidade.foraAva = f.querySelector('input[name="conf.foraAva"]').checked;
  av.penalidade = v('penalidade') || 'nenhuma';
  f.querySelectorAll('[data-campo]').forEach(x => {
    const [a, b] = x.dataset.campo.split('.');
    av[a][b] = x.value;
  });
  f.querySelector('.pf-capa').hidden = av.conformidade.capa !== 'incompleta';
}

function atualizarResultado() {
  const total = (ativ.turma.objetivos || []).length;
  const r = M.calcular(corr.av, total);
  const c2 = r.criterios.c2, c3 = r.criterios.c3;
  const tag = (crit) => crit.nivel ? `<span class="pf-tag-nivel pf-n-${crit.nivel.toLowerCase()}">${M.NOME_NIVEL[crit.nivel]} · ${fmt(crit.pts)} pt</span>` : '<span class="pf-tag-nivel">nível ainda não definido</span>';
  const r2 = el('pf-c2-res');
  if (r2) {
    r2.innerHTML = c2.manual
      ? `<p class="pf-aviso">${esc(M.NOTA_C2)} Escolha:
          <select name="c2.nivelManual"><option value="">—</option>${M.NIVEIS.map(n => `<option value="${n}" ${corr.av.c2.nivelManual === n ? 'selected' : ''}>${M.NOME_NIVEL[n]} (${fmt(M.CRITERIOS[1].niveis[n].pts)} pt)</option>`).join('')}</select></p>`
      : `Nível pela matriz: ${tag(c2)}`;
  }
  const r3 = el('pf-c3-res');
  if (r3) r3.innerHTML = `${c3.n} de ${c3.total} objetivos (${Math.round((c3.pct || 0) * 1000) / 10}%) → ${tag(c3)}${c3.nota ? `<p class="pf-aviso">${esc(c3.nota)}</p>` : ''}`;
  const pen = r.penalidade !== 'nenhuma';
  el('pf-total').innerHTML = `
    <div class="pf-total-crits">${M.CRITERIOS.map(c => `<span title="${esc(c.nome)}">C${c.num} <b>${r.criterios[c.id].nivel ? fmt(r.criterios[c.id].pts) : '—'}</b>/${fmt(c.max)}</span>`).join('')}
      <span>Soma <b>${fmt(r.soma)}</b></span>${pen ? `<span>× ${String(r.fator).replace('.', ',')}</span>` : ''}</div>
    <div class="pf-total-nota"><small>Nota</small><b>${fmt(r.nota)}</b><small>/ 10,0</small></div>
    <div class="pf-total-acoes">
      ${r.completo ? '' : `<small class="pf-falta">${r.faltando.length} item(ns) pendente(s) para finalizar</small>`}
      <button type="button" class="pf-btn" data-acao="salvar">Salvar rascunho</button>
      <button type="button" class="pf-btn pf-btn-ok" data-acao="finalizar">Finalizar</button>
    </div>`;
}

function avisoSimilaridade() {
  const box = el('pf-simil-aviso');
  if (!box || !simil || !corr) return;
  const meus = simil.pares.filter(p => p.a === corr.entrega.id || p.b === corr.entrega.id);
  box.innerHTML = meus.length ? `<p class="pf-aviso pf-aviso-crit">Similaridade apontada com: ${meus.map(p => `${esc(p.a === corr.entrega.id ? p.nomeB : p.nomeA)} (${GRAV[p.gravidade]})`).join(', ')}. Veja a aba Similaridade. A decisão é sua.</p>` : '';
}

async function salvarCorrecao(finalizar) {
  lerForm();
  try {
    const r = await post(`${BASE}/entregas/${encodeURIComponent(corr.entrega.id)}/avaliacao`, { avaliacao: corr.av, finalizar }, 'PUT');
    Object.assign(corr.entrega, { avaliacao: JSON.parse(JSON.stringify(corr.av)), resultado: r.resultado, status: r.status, corrigidoPor: dados.eu.nome, alteradoAposCorrecao: false });
    corr.sujo = false;
    toast(finalizar ? `Finalizada: nota ${fmt(r.resultado.nota)}.` : 'Rascunho salvo.');
    return true;
  } catch (e) {
    if (e.corpo && e.corpo.faltando) {
      dialogo(`<div class="pf-form"><h2>Faltam itens para finalizar</h2><ul>${e.corpo.faltando.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        <p class="pf-dica">Toda nota precisa de evidência ancorada no texto. O rascunho pode ser salvo incompleto.</p>
        <div class="pf-dlg-acoes"><button type="button" class="pf-btn pf-btn-pri" data-fechar>Entendi</button></div></div>`);
    } else toast(e.message, 'erro');
    return false;
  }
}

// ============================================================ similaridade
async function carregarSimilaridade() {
  simil = await api(`${BASE}/atividades/${encodeURIComponent(ativ.atividade.id)}/similaridade`);
  return simil;
}
async function renderSimilaridade() {
  const box = el('pf-aba');
  if (!simil) {
    box.innerHTML = '<div class="pf-vazio">Comparando os portfólios da turma…</div>';
    try { await carregarSimilaridade(); } catch (e) { box.innerHTML = `<div class="pf-vazio pf-erro">${esc(e.message)}</div>`; return; }
  }
  const s = simil;
  box.innerHTML = `
    <p class="pf-dica">Comparação entre todas as entregas desta atividade, por trechos contínuos iguais (sem IA). Não contam: referências bibliográficas e trechos que aparecem em ${s.limiteComum} ou mais portfólios (objetivos copiados do plano, nomes de programas do SUS, rotina protocolar da UBS, modelo de capa).
      Gravidade <b>indicativa</b>: Baixa (frases isoladas), Média (parágrafos compartilhados), Alta (texto amplamente idêntico). <b>A decisão final cabe ao professor supervisor.</b></p>
    <p class="pf-meta">${s.analisados} portfólios comparados${s.semTexto ? ` · ${s.semTexto} sem texto legível (não comparados)` : ''}</p>
    ${!s.pares.length ? '<div class="pf-vazio pf-ok">Nenhuma similaridade indevida detectada entre as produções da turma.</div>'
      : s.pares.map(p => `<article class="pf-par pf-par-${p.gravidade.toLowerCase()}">
        <header><span class="pf-grav">${GRAV[p.gravidade]}</span><b>${esc(p.nomeA)}</b> × <b>${esc(p.nomeB)}</b>
          <span class="pf-meta">${p.palavrasComuns} palavras em comum · ${String(p.propA).replace('.', ',')}% de um / ${String(p.propB).replace('.', ',')}% do outro · maior trecho contínuo: ${p.maiorTrecho} palavras</span></header>
        ${p.trechos.map(t => `<blockquote>"${esc(t.texto)}" <small>(${t.palavras} palavras)</small></blockquote>`).join('')}
      </article>`).join('')}`;
}

// ============================================================ quadro-resumo e AVA
function linhasResumo() {
  return ativ.entregas.map(e => {
    const r = e.resultado;
    const c = (id) => (r && r.criterios[id].nivel ? r.criterios[id].pts : null);
    return { e, r, c1: c('c1'), c2: c('c2'), c3: c('c3'), c4: c('c4'), alerta: comAlerta(e.id) };
  });
}
async function renderResumo() {
  const box = el('pf-aba');
  if (!simil) { try { await carregarSimilaridade(); } catch (e) { /* segue sem o alerta */ } }
  const linhas = linhasResumo();
  const fin = linhas.filter(l => l.e.status === 'finalizada').length;
  box.innerHTML = `
    <div class="pf-barra">
      <span class="pf-meta">${fin} de ${linhas.length} finalizadas. Só as finalizadas vão para o AVA.</span>
      <div class="pf-acoes">
        <button type="button" class="pf-btn" data-acao="imprimir">Imprimir relatório da turma</button>
        <button type="button" class="pf-btn" data-acao="csv">Baixar planilha (Excel)</button>
        ${ativ.editor && ativ.atividade.ava ? '<button type="button" class="pf-btn pf-btn-pri" data-acao="ava-notas">Lançar notas no AVA</button>' : ''}
        <button type="button" class="pf-btn ${ativ.atividade.ava ? '' : 'pf-btn-pri'}" data-acao="planilha-ava">Preencher planilha de avaliação do AVA</button>
      </div>
    </div>
    <details class="pf-passos-ava"><summary>Como devolver as notas ao AVA</summary><ol>
      <li>Na Tarefa do AVA → <b>Ver todos os envios</b> → <b>Ação de avaliação</b> → <b>Baixar planilha de avaliação</b> (.csv). Se a opção não aparecer, nas configurações da Tarefa ative "Planilha de avaliação offline" em Tipos de feedback.</li>
      <li>Aqui, clique em <b>Preencher planilha de avaliação do AVA</b> e escolha esse .csv. Volta o mesmo arquivo com a nota e o feedback das correções finalizadas.</li>
      <li>No AVA → <b>Ação de avaliação</b> → <b>Enviar planilha de avaliação</b>, envie o arquivo preenchido e confira a prévia antes de confirmar.</li>
    </ol></details>
    <div class="pf-tab-wrap"><table class="pf-tab">
      <thead><tr><th>Estudante</th><th class="num">C1 (3,0)</th><th class="num">C2 (3,0)</th><th class="num">C3 (2,0)</th><th class="num">C4 (2,0)</th><th class="num">Nota</th><th>Similaridade</th><th>Situação</th></tr></thead>
      <tbody>${linhas.map(l => `<tr data-acao="corrigir" data-id="${esc(l.e.id)}" tabindex="0"><td>${esc(l.e.nome)}</td>
        <td class="num">${fmt(l.c1)}</td><td class="num">${fmt(l.c2)}</td><td class="num">${fmt(l.c3)}</td><td class="num">${fmt(l.c4)}</td>
        <td class="num"><b>${l.r ? fmt(l.r.nota) : '—'}</b>${l.r && l.r.penalidade !== 'nenhuma' ? ` <small>(× ${String(l.r.fator).replace('.', ',')})</small>` : ''}</td>
        <td>${l.alerta ? '<span class="pf-av pf-av-crit">Sim</span>' : 'Não'}</td>
        <td><span class="pf-st pf-st-${esc(l.e.status)}">${STATUS[l.e.status]}</span></td></tr>`).join('')}</tbody>
    </table></div>`;
}

const nomeArquivo = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_');
function baixar(conteudo, nome, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = document.createElement('a'); a.href = url; a.download = nome; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}
function baixarCsvResumo() {
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const cab = ['Estudante', 'Participante', 'C1', 'C2', 'C3', 'C4', 'Soma', 'Condição especial', 'Nota', 'Similaridade', 'Situação', 'Corrigido por'];
  const linhas = linhasResumo().map(l => [l.e.nome, l.e.participante, fmt(l.c1), fmt(l.c2), fmt(l.c3), fmt(l.c4), l.r ? fmt(l.r.soma) : '', l.r ? M.PENALIDADES[l.r.penalidade].rotulo : '',
    l.r ? fmt(l.r.nota) : '', l.alerta ? 'Sim' : 'Não', STATUS[l.e.status], l.e.corrigidoPor || '']);
  baixar('﻿' + [cab, ...linhas].map(r => r.map(q).join(';')).join('\r\n'), nomeArquivo(`portfolio_${ativ.turma.turma}_${ativ.atividade.titulo}.csv`), 'text/csv;charset=utf-8');
}

// CSV do Moodle (vírgula, aspas duplas)
function lerCsv(texto) {
  const linhas = []; let linha = [], campo = '', aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (aspas) {
      if (ch === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === ',') { linha.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && texto[i + 1] === '\n') i++; linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else campo += ch;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter(l => l.some(c => c !== ''));
}
function feedbackHtml(e) {
  const r = e.resultado, av = e.avaliacao;
  const nl = M.CRITERIOS.map(c => `${c.nome}: ${M.NOME_NIVEL[r.criterios[c.id].nivel]} (${fmt(r.criterios[c.id].pts)}/${fmt(c.max)})`);
  const partes = [`<b>Portfólio — ${fmt(r.nota)} / 10,0</b>`, ...nl];
  if (r.penalidade !== 'nenhuma') partes.push(`${M.PENALIDADES[r.penalidade].rotulo} (soma ${fmt(r.soma)})`);
  partes.push(`<b>Pontos fortes:</b> ${esc(av.feedback.fortes)}`, `<b>Pontos a desenvolver:</b> ${esc(av.feedback.desenvolver)}`, `<b>Recomendação:</b> ${esc(av.feedback.recomendacao)}`);
  return `<p>${partes.join('<br>')}</p>`;
}
async function preencherPlanilha(arquivo) {
  let texto = await arquivo.text();
  const bom = texto.charCodeAt(0) === 0xfeff;
  if (bom) texto = texto.slice(1);
  const linhas = lerCsv(texto);
  if (linhas.length < 2) { toast('Planilha vazia.', 'erro'); return; }
  const cab = linhas[0].map(c => c.trim());
  const iId = cab.findIndex(c => /^(identificador|identifier)$/i.test(c));
  const iNota = cab.findIndex(c => /^(nota|grade)$/i.test(c));
  const iMax = cab.findIndex(c => /^(nota m[aá]xima|maximum grade)$/i.test(c));
  const iFb = cab.findIndex(c => /coment[aá]rios? de feedback|feedback comments/i.test(c));
  if (iId < 0 || iNota < 0) { toast('Não reconheci a planilha. Use "Baixar planilha de avaliação" da Tarefa do AVA.', 'erro'); return; }
  const virgula = iMax >= 0 && linhas.slice(1).some(l => /,/.test(l[iMax] || ''));
  const porPart = new Map(ativ.entregas.filter(e => e.status === 'finalizada').map(e => [e.participante, e]));
  let n = 0, semFb = iFb < 0;
  const novas = linhas.map((l, k) => {
    if (k === 0) return l;
    const m = /(\d+)\s*$/.exec(l[iId] || '');
    const e = m && porPart.get(m[1]);
    if (!e) return l;
    const out = [...l];
    const nota = e.resultado.nota.toFixed(2);
    out[iNota] = virgula ? nota.replace('.', ',') : nota;
    if (iFb >= 0) out[iFb] = feedbackHtml(e);
    n++;
    return out;
  });
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  baixar((bom ? '﻿' : '') + novas.map(l => l.map(q).join(',')).join('\n'), arquivo.name.replace(/\.csv$/i, '') + '_preenchida.csv', 'text/csv;charset=utf-8');
  const fora = [...porPart.keys()].filter(p => !linhas.some(l => new RegExp(`\\b${p}\\s*$`).test(l[iId] || '')));
  toast(`${n} nota(s) preenchida(s).${fora.length ? ` ${fora.length} finalizada(s) não estão nesta planilha.` : ''}${semFb ? ' A planilha não tem a coluna de comentários de feedback: só a nota foi preenchida.' : ''}`, fora.length || semFb ? 'alerta' : 'ok');
}

async function imprimirRelatorio() {
  const { turma, atividade } = ativ;
  if (!simil) { try { await carregarSimilaridade(); } catch (e) { /* sem similaridade */ } }
  const linhas = linhasResumo();
  const ind = ativ.entregas.filter(e => e.resultado).map(e => {
    const r = e.resultado, av = e.avaliacao;
    const c3 = r.criterios.c3;
    return `<section class="pi-aluno">
      <h3>${esc(e.nome)} <small>Arquivo: ${esc((e.arquivos || []).join(', '))} · Turma: ${esc(turma.turma)} · ${STATUS[e.status]}</small></h3>
      <table><thead><tr><th>Critério</th><th>Máx.</th><th>Nível</th><th>Nota</th><th>Evidência / justificativa</th></tr></thead><tbody>
      ${M.CRITERIOS.map(c => { const x = r.criterios[c.id]; return `<tr><td>${c.num}. ${esc(c.nome)}</td><td>${fmt(c.max)}</td><td>${x.nivel ? M.NOME_NIVEL[x.nivel] : '—'}</td><td>${x.nivel ? fmt(x.pts) : '—'}</td>
        <td>${c.id === 'c3' ? `${c3.n}/${c3.total} objetivos (${Math.round(c3.pct * 1000) / 10}%): ${av.c3.objetivos.map((v, k) => (v ? k + 1 : null)).filter(Boolean).join(', ') || 'nenhum'}.<br>` : ''}${x.nota ? `<i>${esc(x.nota)}</i><br>` : ''}${paragrafos(x.justificativa)}</td></tr>`; }).join('')}
      <tr><td colspan="3"><b>Nota final</b>${r.penalidade !== 'nenhuma' ? ` — ${esc(M.PENALIDADES[r.penalidade].rotulo)}: ${fmt(r.soma)} × ${String(r.fator).replace('.', ',')}` : ''}</td><td><b>${fmt(r.nota)}</b></td><td>Soma estrita dos 4 critérios.</td></tr>
      </tbody></table>
      <p><b>Pontos fortes:</b> ${paragrafos(av.feedback.fortes)}<br><b>Pontos a desenvolver:</b> ${paragrafos(av.feedback.desenvolver)}<br><b>Recomendação prática:</b> ${paragrafos(av.feedback.recomendacao)}</p>
      <p class="pi-conf"><b>Conformidade</b> (não altera a nota): capa ${esc(av.conformidade.capa || 'não registrada')}${av.conformidade.capaFaltando.length ? ` — faltando: ${esc(av.conformidade.capaFaltando.join(', '))}` : ''}${av.conformidade.formatacao ? ` · formatação: ${esc(av.conformidade.formatacao)}` : ''}${av.conformidade.foraAva ? ' · houve entrega por outro canal' : ''}${av.conformidade.obs ? ` · ${esc(av.conformidade.obs)}` : ''}</p>
      <p class="pi-conf">Corrigido por ${esc(e.corrigidoPor || '')} em ${esc((e.corrigidoEm || '').slice(0, 10).split('-').reverse().join('/'))} · matriz ${esc(e.matrizVersao || M.VERSAO)}</p>
    </section>`;
  }).join('');
  el('pf-impressao').innerHTML = `
    <h1>Portfólio Reflexivo — ${esc(atividade.titulo)}</h1>
    <p>${esc(turma.componente || 'SCIC')} · ${esc(turma.turma)} — ${esc(turma.periodo ? `${turma.periodo}º período` : '')} — ${esc(turma.semestre)} · Tema: ${esc(turma.tema || '')}</p>
    <h2>Quadro-resumo da turma</h2>
    <table><thead><tr><th>Estudante</th><th>C1 (3,0)</th><th>C2 (3,0)</th><th>C3 (2,0)</th><th>C4 (2,0)</th><th>Nota</th><th>Alerta de similaridade</th><th>Situação</th></tr></thead><tbody>
    ${linhas.map(l => `<tr><td>${esc(l.e.nome)}</td><td>${fmt(l.c1)}</td><td>${fmt(l.c2)}</td><td>${fmt(l.c3)}</td><td>${fmt(l.c4)}</td><td><b>${l.r ? fmt(l.r.nota) : '—'}</b></td><td>${l.alerta ? 'Sim' : 'Não'}</td><td>${STATUS[l.e.status]}</td></tr>`).join('')}
    </tbody></table>
    <h2>Relatório de similaridade</h2>
    ${!simil ? '<p>Não calculado.</p>' : !simil.pares.length ? '<p>Nenhuma similaridade indevida detectada entre as produções da turma.</p>'
      : `<table><thead><tr><th>Par de estudantes</th><th>Trecho coincidente</th><th>Extensão</th><th>Gravidade</th></tr></thead><tbody>
        ${simil.pares.map(p => `<tr><td>${esc(p.nomeA)} × ${esc(p.nomeB)}</td><td>${p.trechos.slice(0, 2).map(t => `"${esc(t.texto)}"`).join('<br>')}</td><td>${p.palavrasComuns} palavras (${String(p.propA).replace('.', ',')}% / ${String(p.propB).replace('.', ',')}%)</td><td>${GRAV[p.gravidade]}</td></tr>`).join('')}
        </tbody></table><p><i>Gravidade indicativa. A decisão final cabe ao professor supervisor.</i></p>`}
    <h2>Avaliações individuais</h2>${ind || '<p>Nenhuma correção salva.</p>'}`;
  document.body.classList.add('pf-imprimindo');
  window.print();
  setTimeout(() => document.body.classList.remove('pf-imprimindo'), 300);
}

// ============================================================ eventos
function ligarEventos() {
  el('pf-semestre').addEventListener('change', () => { if (!sairDaCorrecao()) return; corr = null; history.replaceState(null, '', location.pathname); carregar(); });
  el('pf-trilha').addEventListener('click', (e) => { const b = e.target.closest('[data-ir]'); if (b) irPara(b.dataset.ir); });
  el('pf-ajuda').addEventListener('click', abrirAjuda);
  el('pf-zip').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const voltarPara = corr ? corr.entrega.id : null;
    if (corr && corr.sujo && !(await salvarCorrecao(false))) return;
    corr = null;
    if (!el('pf-import')) renderAtividade();
    await importarZip(f);
    if (voltarPara) abrirCorrecao(voltarPara);
  });
  el('pf-planilha').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) preencherPlanilha(f); });

  const conteudo = el('pf-conteudo');
  conteudo.addEventListener('click', async (e) => {
    const aba = e.target.closest('[data-aba]');
    if (aba) { abaAtiv = aba.dataset.aba; renderAtividade(); return; }
    const tut = e.target.closest('[data-tut]');
    if (tut) { const alvo = el(tut.dataset.tut); if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const lt = e.target.closest('[data-leitor]');
    if (lt && !lt.disabled) { el('pf-leitor').dataset.modo = lt.dataset.leitor; renderLeitor(); return; }
    const b = e.target.closest('[data-acao]');
    if (!b || b.disabled) return;
    const a = b.dataset.acao;
    if (a === 'nova-ativ') dlgNovaAtividade(b.dataset.turma);
    else if (a === 'config-turma') dlgConfigTurma(b.dataset.turma);
    else if (a === 'nova-turma') dlgConfigTurma(null);
    else if (a === 'copiar-semestre') dlgCopiarSemestre();
    else if (a === 'abrir-ativ') { abaAtiv = 'entregas'; abrirAtividade(b.dataset.id); }
    else if (a === 'importar') el('pf-zip').click();
    else if (a === 'ava-ligar') dlgLigarAva();
    else if (a === 'ava-buscar') { b.disabled = true; try { await buscarEntregasAva(); } finally { b.disabled = false; } }
    else if (a === 'ava-notas') dlgLancarNotasAva();
    else if (a === 'leitura') { const pdf = (pdfs.get(chavePdf(corr.entrega)) || []).find(x => !x.naoPdf); if (pdf) modoLeitura(pdf.url); }
    else if (a === 'ava-pdf') {
      b.disabled = true; b.textContent = 'Abrindo…';
      try { await carregarPdfsAva(corr.entrega); el('pf-leitor').dataset.modo = 'pdf'; renderLeitor(); }
      catch (err) { toast(err.message, 'erro'); b.disabled = false; b.textContent = 'Abrir o PDF do AVA'; }
    }
    else if (a === 'excluir-ativ') {
      if (!confirm(`Excluir "${ativ.atividade.titulo}" e TODAS as ${ativ.entregas.length} correções dela? Não dá para desfazer.`)) return;
      try { await api(`${BASE}/atividades/${encodeURIComponent(ativ.atividade.id)}`, { method: 'DELETE' }); toast('Atividade excluída.'); history.replaceState(null, '', location.pathname); carregar(); }
      catch (err) { toast(err.message, 'erro'); }
    }
    else if (a === 'corrigir') abrirCorrecao(b.dataset.id);
    else if (a === 'salvar') { if (await salvarCorrecao(false)) atualizarResultado(); }
    else if (a === 'finalizar') {
      if (await salvarCorrecao(true)) {
        const i = ativ.entregas.findIndex(x => x.id === corr.entrega.id);
        // próxima ainda não finalizada (depois desta; se acabou a lista, volta do começo)
        const prox = [...ativ.entregas.slice(i + 1), ...ativ.entregas.slice(0, i)].find(x => x.status !== 'finalizada');
        if (prox) abrirCorrecao(prox.id); else { corr = null; abaAtiv = 'resumo'; renderAtividade(); }
      }
    }
    else if (a === 'anterior' || a === 'proximo') {
      const i = ativ.entregas.findIndex(x => x.id === corr.entrega.id);
      const alvo = ativ.entregas[i + (a === 'proximo' ? 1 : -1)];
      if (alvo) abrirCorrecao(alvo.id);
    }
    else if (a === 'ajuda') abrirAjuda();
    else if (a === 'sair-ajuda') sairAjuda();
    else if (a === 'csv') baixarCsvResumo();
    else if (a === 'planilha-ava') el('pf-planilha').click();
    else if (a === 'imprimir') imprimirRelatorio();
  });
  conteudo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('tr[data-acao="corrigir"]')) abrirCorrecao(e.target.dataset.id);
  });
  const mudou = (e) => {
    if (!corr || !e.target.closest('#pf-matriz')) return;
    corr.sujo = true;
    lerForm();
    if (e.type === 'change') atualizarResultado();
  };
  conteudo.addEventListener('input', mudou);
  conteudo.addEventListener('change', mudou);
  window.addEventListener('beforeunload', (e) => { if (corr && corr.sujo) { e.preventDefault(); e.returnValue = ''; } });
}

async function initApp(user, role) {
  if (iniciado) return;
  iniciado = true;
  setupLayout(user, role, 'portfolio-med', () => { clearCachedAuth(); auth.signOut().then(() => { window.location.href = '../../auth/login.html'; }); });
  el('auth-guard').classList.add('hidden');
  el('app').classList.remove('hidden');
  ligarEventos();
  let semestres = [];
  try { semestres = await api(`${BASE}/semestres`); } catch (e) { semestres = []; }
  const padrao = semestres.includes('2026.2') ? '2026.2' : (semestres[0] || '2026.2');
  el('pf-semestre').innerHTML = (semestres.length ? semestres : [padrao]).map(s => `<option ${s === padrao ? 'selected' : ''}>${esc(s)}</option>`).join('');
  await carregar();
}

const cached = getCachedAuth();
onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); window.location.href = '../../auth/login.html'; return; }
  currentUser = user;
  let role = 'visitante';
  try { const u = await api('/usuarios/me'); role = u.role || 'visitante'; }
  catch (e) { role = cached ? cached.role : 'visitante'; }
  setCachedAuth(user, role, await user.getIdToken());
  initApp(user, role);
});
