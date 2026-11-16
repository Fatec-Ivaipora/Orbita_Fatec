// Aplicação de Provas — Medicina (16/11/2026)
// Calendário das turmas (T1/T2/T3) + professores aplicadores, laboratórios, apoio e NAPA. Uma fonte só: o calendário
// dos alunos e a lista dos aplicadores saem daqui (tela, impressão/PDF e imagem para WhatsApp).
// Edita: coordenação de Medicina (inclui secretaria acadêmica), responsável pelas avaliações (CADAM) e ADM.
// Professor de Medicina: só lê, com as aplicações dele destacadas (e sem os nomes dos alunos do NAPA).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';
const BASE = '/aplicacao-provas-med';

let currentUser = null;
let iniciado = false;
let dados = null;          // { semestre, editor, meuNome, config, provas }
let edubox = null;         // { disciplinas, professores } — só para quem edita
let aba = 'turmas';

const $ = (s, r = document) => r.querySelector(s);
const el = (id) => document.getElementById(id);

async function api(endpoint, options = {}) {
  let token = '';
  if (currentUser && typeof currentUser.getIdToken === 'function') token = await currentUser.getIdToken();
  else if (auth.currentUser) token = await auth.currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (!res.ok) {
    let msg = `Erro na API: ${res.status}`;
    try { const b = await res.json(); if (b.error) msg = b.error; } catch (e) { /* sem corpo */ }
    throw new Error(msg);
  }
  return res.json();
}
function toast(msg, tipo = 'ok') {
  let t = el('ap-toast');
  if (!t) { t = document.createElement('div'); t.id = 'ap-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.className = `ap-toast ap-toast-${tipo}`; t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4200);
}

// ---------- formatos ----------
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const TURNO = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite', '': 'A definir' };
const ETAPA = { b1: '1º bimestre', b2: '2º bimestre', sub: '2ª chamada', exame: 'Exame' };
// título de cada bloco na arte da turma (16/11/2026)
const ETAPA_BLOCO = { b1: '1ª chamada · 1º bimestre', b2: '1ª chamada · 2º bimestre', sub: '2ª chamada', exame: 'Exames' };
// o que sai na arte da turma: quem gera escolhe (só 1ª chamada, só 2ª, só exames, ou juntos)
const SAI = { c1: true, sub: true, exame: true };
const grupoDe = (et) => (et === 'b1' || et === 'b2' ? 'c1' : et);
const SAI_ROTULO = { c1: '1ª chamada', sub: '2ª chamada', exame: 'Exames' };
const TIPO = { prova: 'Prova', pratica: 'Prática', osce: 'OSCE', outra: 'Outra' };
const dataObj = (iso) => { const [a, m, d] = iso.split('-').map(Number); return new Date(a, m - 1, d); };
const ddmm = (iso) => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '';
const diaSemana = (iso) => DIAS[dataObj(iso).getDay()];
const hora = (h) => h ? h.replace(':', 'h') : '';
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const corTurma = (id) => ({ T1: 't1', T2: 't2', T3: 't3', T4: 't4' }[id] || 't0');
// nome curto para tabela e arte: primeiro + último ('Paulo Roberto Nunes de Goes' → 'Paulo Goes')
const curto = (n) => { const w = String(n || '').trim().split(/\s+/).filter(x => !/^(de|da|do|dos|das|e)$/i.test(x)); return w.length > 2 ? `${w[0]} ${w[w.length - 1]}` : w.join(' '); };
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
// "Laboratórios 12 e 20" → ["12","20"]; "Lab. Morfo Pétalas / Lab. Parasito" → ["morfo petalas","parasito"]
function labsDe(txt) {
  const t = norm(txt);
  if (!t || /conforme|organiza/.test(t)) return [];
  const nums = t.match(/\b\d{1,3}\b/g);
  if (nums) return [...new Set(nums)];
  return t.split(/[\/,;]| e /).map(x => x.replace(/\blab(oratorio)?s?\.?\b/g, '').trim()).filter(Boolean);
}

function provasVisiveis() {
  const et = el('ap-etapa').value;
  return dados.provas.filter(p => !et || p.etapa === et);
}

// ---------- choques (mesmo dia e turno) ----------
function conflitos(provas) {
  const out = [];
  const porSlot = {};
  provas.forEach(p => { if (!p.turno) return; const k = `${p.data}|${p.turno}`; (porSlot[k] = porSlot[k] || []).push(p); }); // turno a definir não entra no choque
  Object.values(porSlot).forEach(l => {
    if (l.length < 2) return;
    const d = `${ddmm(l[0].data)} ${TURNO[l[0].turno].toLowerCase()}`;
    // turma com duas provas no mesmo turno
    const porTurma = {};
    l.forEach(p => (porTurma[p.turma] = porTurma[p.turma] || []).push(p));
    Object.entries(porTurma).forEach(([t, ps]) => { if (ps.length > 1) out.push({ ids: ps.map(p => p.id), msg: `${d}: a ${t} tem ${ps.length} provas no mesmo turno (${ps.map(p => p.disciplina).join(' e ')}).` }); });
    // professor em duas aplicações
    const porProf = {};
    l.forEach(p => (p.aplicadores || []).forEach(a => { const k = norm(a); (porProf[k] = porProf[k] || { nome: a, ps: [] }).ps.push(p); }));
    Object.values(porProf).forEach(x => { if (x.ps.length > 1) out.push({ ids: x.ps.map(p => p.id), msg: `${d}: ${x.nome} aplica ${x.ps.length} provas ao mesmo tempo (${x.ps.map(p => `${p.turma} ${p.disciplina}`).join(' e ')}).` }); });
    // laboratório em uso por duas provas
    const porLab = {};
    l.forEach(p => labsDe(p.laboratorios).forEach(lb => (porLab[lb] = porLab[lb] || []).push(p)));
    Object.entries(porLab).forEach(([lb, ps]) => { if (ps.length > 1) out.push({ ids: ps.map(p => p.id), msg: `${d}: laboratório ${/^\d+$/.test(lb) ? lb : `"${lb}"`} em ${ps.length} provas (${ps.map(p => `${p.turma} ${p.disciplina}`).join(' e ')}).` }); });
  });
  return out;
}

// ==========================================================================================
// TELA
// ==========================================================================================
function renderStatus() {
  const c = dados.config;
  const val = c.status === 'validado';
  const dt = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  el('ap-status').className = `ap-status ${val ? 'ap-status-ok' : 'ap-status-mont'}`;
  el('ap-status').innerHTML = `
    <div class="ap-status-txt">
      <b>${val ? 'Calendário validado' : 'Calendário em montagem'}</b>
      <span>${val ? `por ${esc(c.validadoPor || '')} em ${dt(c.validadoEm)} — pode imprimir e mandar aos setores.` : (c.reabertoPor ? `Reaberto por ${esc(c.reabertoPor)} em ${dt(c.reabertoEm)}${c.motivoReabertura ? ` (${esc(c.motivoReabertura)})` : ''}. ` : '') + (dados.editor ? 'Confira e valide antes de mandar aos setores. Impressão sai com a marca RASCUNHO até validar.' : 'Ainda pode mudar: aguarde a validação da coordenação.')}</span>
    </div>
    ${dados.editor ? (val
      ? '<button type="button" class="ap-btn" id="ap-reabrir">Reabrir para alterar</button>'
      : `<button type="button" class="ap-btn ap-btn-ok" id="ap-validar" ${dados.provas.length ? '' : 'disabled'}>Validar calendário</button>`) : ''}`;
}

function linhaTurma(p) {
  return `<li class="ap-tp ${p.minha ? 'ap-minha' : ''} ${p.tipo === 'osce' ? 'ap-osce' : ''}">
    <button type="button" class="ap-tp-btn" data-prova="${esc(p.id)}" ${dados.editor ? '' : 'data-ler="1"'} aria-label="${esc(`${ddmm(p.data)}, ${p.disciplina}, ${TURNO[p.turno]}`)}">
      <span class="ap-tp-data"><b>${ddmm(p.data)}</b><small>${diaSemana(p.data)}</small></span>
      <span class="ap-tp-disc">${esc(p.disciplina)}${p.tipo !== 'prova' ? ` <em class="ap-tipo">${TIPO[p.tipo]}</em>` : ''}${p.minha ? ' <em class="ap-eu">você aplica</em>' : ''}</span>
      <span class="ap-turno ap-turno-${p.turno}">${TURNO[p.turno]}</span>
    </button>
  </li>`;
}
function renderTurmas(provas) {
  const turmas = dados.config.turmas || [];
  if (!turmas.length) return '<div class="ap-vazio">Nenhuma turma configurada.</div>';
  return `<div class="ap-turmas" style="--n:${turmas.length}">${turmas.map(t => {
    const ps = provas.filter(p => p.turma === t.id);
    return `<section class="ap-turma ap-${corTurma(t.id)}" aria-label="Turma ${esc(t.id)}">
      <header><h2>${esc(t.id)}</h2><span>${t.periodo}º período · ${ps.length} ${ps.length === 1 ? 'prova' : 'provas'}</span></header>
      ${ps.length ? `<ol class="ap-tp-lista">${ps.map(linhaTurma).join('')}</ol>` : `<p class="ap-turma-vazia">${dados.editor ? 'Nenhuma prova ainda. Use “+ Prova”.' : 'Nenhuma prova cadastrada.'}</p>`}
    </section>`;
  }).join('')}</div>`;
}

function napaTxt(p) {
  if (!p.napa || !(p.napa.sala || p.napa.responsavel || p.napa.notebooks)) return '';
  return [p.napa.sala, p.napa.responsavel, p.napa.notebooks ? `${p.napa.notebooks} notebook${p.napa.notebooks > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
}
function renderAplicadores(provas, soMinhas) {
  const ps = soMinhas ? provas.filter(p => p.minha) : provas;
  if (!ps.length) return `<div class="ap-vazio">${soMinhas ? 'Você não está como aplicador(a) em nenhuma prova desta etapa.' : 'Nenhuma prova cadastrada.'}</div>`;
  const ids = new Set(conflitos(dados.provas).flatMap(c => c.ids));
  const c = dados.config;
  return `<div class="ap-tab-wrap"><table class="ap-tab">
    <thead><tr><th scope="col">Data</th><th scope="col">Turma</th><th scope="col">Disciplina</th><th scope="col">Professores aplicadores</th><th scope="col">Horário</th><th scope="col">Laboratório(s)</th><th scope="col">NAPA</th></tr></thead>
    <tbody>${ps.map(p => `<tr class="${p.minha ? 'ap-minha' : ''} ${ids.has(p.id) ? 'ap-choque' : ''}" data-prova="${esc(p.id)}" tabindex="0">
      <td data-r="Data"><b>${ddmm(p.data)}</b> <small>${diaSemana(p.data)}</small></td>
      <td data-r="Turma"><span class="ap-chip ap-${corTurma(p.turma)}">${esc(p.turma)}</span></td>
      <td data-r="Disciplina" class="ap-td-disc">${esc(p.disciplina)}${p.tipo !== 'prova' ? ` <em class="ap-tipo">${TIPO[p.tipo]}</em>` : ''}</td>
      <td data-r="Aplicadores">${(p.aplicadores || []).map(a => `<span title="${esc(a)}">${esc(curto(a))}</span>`).join(', ') || '<span class="ap-falta">a definir</span>'}</td>
      <td data-r="Horário"><b>${hora(p.horario) || TURNO[p.turno]}</b></td>
      <td data-r="Laboratório(s)">${esc(p.laboratorios) || '<span class="ap-falta">a definir</span>'}</td>
      <td data-r="NAPA">${esc(napaTxt(p)) || '<span class="ap-nada">—</span>'}</td>
    </tr>`).join('')}</tbody></table></div>
    ${!soMinhas ? `<div class="ap-rodape-equipe">
      <p><b>Apoio:</b> ${(c.apoio || []).map(esc).join(', ') || '<span class="ap-falta">a definir</span>'}</p>
      <p><b>NAPA:</b> ${[c.napa && c.napa.responsavelManha ? `Manhã: ${esc(c.napa.responsavelManha)}` : '', c.napa && c.napa.responsavelTarde ? `Tarde: ${esc(c.napa.responsavelTarde)}` : ''].filter(Boolean).join(' · ') || '<span class="ap-falta">a definir</span>'}</p>
    </div>` : ''}`;
}

function renderNapa(provas) {
  const c = dados.config;
  const turmasNapa = (c.turmas || []).filter(t => t.napa);
  const ps = provas.filter(p => turmasNapa.some(t => t.id === p.turma));
  const alunos = (t) => (c.napaAlunos && c.napaAlunos[t]) || [];
  return `
    <div class="ap-napa-turmas">${turmasNapa.map(t => `<div class="ap-napa-card ap-${corTurma(t.id)}">
      <h3>${esc(t.id)} <small>${alunos(t.id).length} aluno(s) com laudo</small></h3>
      ${alunos(t.id).length ? `<ul>${alunos(t.id).map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="ap-falta">Nenhum aluno cadastrado. Use “Configurar”.</p>'}
    </div>`).join('') || '<div class="ap-vazio">Nenhuma turma com NAPA. Marque em “Configurar”.</div>'}</div>
    <p class="ap-nota">Os nomes dos alunos só aparecem para a coordenação, a secretaria e a responsável pelas avaliações (dado de saúde). O professor vê só sala, responsável e quantos notebooks.</p>
    ${ps.length ? `<div class="ap-tab-wrap"><table class="ap-tab">
      <thead><tr><th scope="col">Data</th><th scope="col">Turma</th><th scope="col">Disciplina</th><th scope="col">Horário</th><th scope="col">Sala NAPA</th><th scope="col">Responsável</th><th scope="col">Notebooks</th></tr></thead>
      <tbody>${ps.map(p => { const n = p.napa || {}; const falta = !n.sala || !n.responsavel; return `<tr data-prova="${esc(p.id)}" tabindex="0" class="${falta ? 'ap-choque' : ''}">
        <td data-r="Data"><b>${ddmm(p.data)}</b> <small>${diaSemana(p.data)}</small></td>
        <td data-r="Turma"><span class="ap-chip ap-${corTurma(p.turma)}">${esc(p.turma)}</span></td>
        <td data-r="Disciplina" class="ap-td-disc">${esc(p.disciplina)}</td>
        <td data-r="Horário"><b>${hora(p.horario) || TURNO[p.turno]}</b></td>
        <td data-r="Sala NAPA">${esc(n.sala) || '<span class="ap-falta">a definir</span>'}</td>
        <td data-r="Responsável">${esc(n.responsavel) || '<span class="ap-falta">a definir</span>'}</td>
        <td data-r="Notebooks"><b>${n.notebooks || alunos(p.turma).length || '—'}</b></td>
      </tr>`; }).join('')}</tbody></table></div>` : ''}`;
}

function renderConflitos() {
  const cs = conflitos(provasVisiveis());
  const box = el('ap-conflitos');
  box.hidden = !cs.length;
  box.innerHTML = cs.length ? `<h2>${cs.length} ${cs.length === 1 ? 'choque' : 'choques'} no calendário</h2><ul>${cs.map(c => `<li>${esc(c.msg)}</li>`).join('')}</ul>` : '';
}

function render() {
  if (!dados) return;
  renderStatus();
  const provas = provasVisiveis();
  const nMinhas = provas.filter(p => p.minha).length;
  $('[data-aba="minhas"]').hidden = !nMinhas;
  el('ap-n-minhas').textContent = nMinhas ? `(${nMinhas})` : '';
  $('[data-aba="napa"]').hidden = !dados.editor;
  if ((aba === 'minhas' && !nMinhas) || (aba === 'napa' && !dados.editor)) aba = 'turmas';
  document.querySelectorAll('.ap-aba').forEach(b => { const on = b.dataset.aba === aba; b.classList.toggle('ativa', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  el('ap-menu-exportar').innerHTML = `<fieldset class="ap-sai"><legend>O que sai na arte da turma</legend>${Object.entries(SAI_ROTULO).map(([k, l]) => `<label><input type="checkbox" data-sai="${k}" ${SAI[k] ? 'checked' : ''}> ${l}</label>`).join('')}</fieldset>`
    + (dados.config.turmas || []).map(t => `<button type="button" role="menuitem" data-exp="img-turma:${esc(t.id)}">Imagem da ${esc(t.id)} (alunos)</button>`).join('')
    + (dados.config.turmas || []).map(t => `<button type="button" role="menuitem" data-exp="pdf-turma:${esc(t.id)}">Imprimir / PDF da ${esc(t.id)} (alunos)</button>`).join('')
    + '<hr><button type="button" role="menuitem" data-exp="img-turmas">Imagem: todas as turmas lado a lado</button>'
    + '<button type="button" role="menuitem" data-exp="img-aplicadores">Imagem: professores aplicadores</button>'
    + '<button type="button" role="menuitem" data-exp="pdf-turmas">Imprimir / PDF: todas as turmas</button>'
    + '<button type="button" role="menuitem" data-exp="pdf-aplicadores">Imprimir / PDF: aplicadores e laboratórios</button>'
    + (dados.editor ? '<button type="button" role="menuitem" data-exp="pdf-napa">Imprimir / PDF: NAPA (sala, notebooks)</button>' : '');
  document.querySelectorAll('.ap-so-editor').forEach(b => { b.hidden = !dados.editor; });
  renderConflitos();
  el('ap-conteudo').innerHTML = aba === 'turmas' ? renderTurmas(provas)
    : aba === 'aplicadores' ? renderAplicadores(provas, false)
    : aba === 'minhas' ? renderAplicadores(provas, true)
    : renderNapa(provas);
}

// ==========================================================================================
// JANELAS (prova e configuração)
// ==========================================================================================
function modal(id, titulo, corpo, rodape) {
  let m = el(id);
  if (!m) { m = document.createElement('div'); m.id = id; m.className = 'ap-modal-fundo'; document.body.appendChild(m); }
  m.innerHTML = `<div class="ap-modal" role="dialog" aria-modal="true" aria-labelledby="${id}-tit">
    <header><h2 id="${id}-tit">${titulo}</h2><button type="button" class="ap-x" data-fechar aria-label="Fechar">✕</button></header>
    <div class="ap-modal-corpo">${corpo}</div>
    <footer>${rodape}</footer></div>`;
  m.hidden = false;
  m.onclick = (e) => { if (e.target === m || e.target.closest('[data-fechar]')) m.hidden = true; };
  setTimeout(() => { const f = m.querySelector('input, select, textarea'); if (f) f.focus(); }, 30);
  return m;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.ap-modal-fundo').forEach(m => { m.hidden = true; }); });

async function carregarEdubox() {
  if (edubox) return edubox;
  try { edubox = await api(`${BASE}/edubox?semestre=${encodeURIComponent(dados.semestre)}`); }
  catch (e) { edubox = { disciplinas: [], professores: [] }; }
  return edubox;
}

function lerProva(p) {
  const c = dados.config;
  const turmas = c.turmas || [];
  const napaDe = (t) => (turmas.find(x => x.id === t) || {}).napa;
  const corpo = `
    <div class="ap-grid3">
      <label class="ap-campo"><span>Turma</span><input value="${esc(p.turma)} · ${(turmas.find(t => t.id === p.turma) || {}).periodo || ''}º período" disabled></label>
      <label class="ap-campo"><span>Data</span><input value="${ddmm(p.data)} (${diaSemana(p.data)})" disabled></label>
      <label class="ap-campo"><span>Horário</span><input value="${hora(p.horario) || ''} ${TURNO[p.turno]}" disabled></label>
    </div>
    <label class="ap-campo"><span>Disciplina</span><input value="${esc(p.disciplina)}" disabled></label>
    <label class="ap-campo"><span>Professores aplicadores</span><input value="${esc((p.aplicadores || []).join(', '))}" disabled></label>
    <label class="ap-campo"><span>Laboratório(s)</span><input value="${esc(p.laboratorios)}" disabled></label>
    ${napaDe(p.turma) && napaTxt(p) ? `<label class="ap-campo"><span>NAPA</span><input value="${esc(napaTxt(p))}" disabled></label>` : ''}
    ${p.observacao ? `<label class="ap-campo"><span>Observação</span><textarea disabled>${esc(p.observacao)}</textarea></label>` : ''}`;
  modal('ap-m-prova', 'Prova', corpo, '<button type="button" class="ap-btn" data-fechar>Fechar</button>');
}

async function abrirProva(id) {
  const p = id ? dados.provas.find(x => x.id === id) : null;
  if (!dados.editor) { if (p) lerProva(p); return; }
  const c = dados.config;
  const turmas = c.turmas || [];
  const ed = await carregarEdubox();
  const v = p || { turma: turmas[0] ? turmas[0].id : '', data: '', turno: 'manha', horario: '08:30', disciplina: '', tipo: 'prova', etapa: el('ap-etapa').value || 'b2', aplicadores: [], laboratorios: '', observacao: '', napa: null };
  const discDaTurma = (t) => { const per = (turmas.find(x => x.id === t) || {}).periodo; return ed.disciplinas.filter(d => d.periodo === per).map(d => d.nome); };
  const corpo = `
    <form id="ap-f-prova" class="ap-form" novalidate>
      <div class="ap-grid3">
        <label class="ap-campo"><span>Turma</span><select name="turma" required>${turmas.map(t => `<option value="${esc(t.id)}" ${t.id === v.turma ? 'selected' : ''}>${esc(t.id)} · ${t.periodo}º período</option>`).join('')}</select></label>
        <label class="ap-campo"><span>Data</span><input type="date" name="data" value="${esc(v.data)}" required></label>
        <label class="ap-campo"><span>Etapa</span><select name="etapa">${Object.entries(ETAPA).map(([k, l]) => `<option value="${k}" ${k === v.etapa ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div class="ap-grid3">
        <label class="ap-campo"><span>Turno</span><select name="turno">${Object.entries(TURNO).map(([k, l]) => `<option value="${k}" ${k === v.turno ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="ap-campo"><span>Horário</span><input type="time" name="horario" value="${esc(v.horario)}"></label>
        <label class="ap-campo"><span>Tipo</span><select name="tipo">${Object.entries(TIPO).map(([k, l]) => `<option value="${k}" ${k === v.tipo ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label class="ap-campo"><span>Disciplina</span><input name="disciplina" list="ap-dl-disc" value="${esc(v.disciplina)}" required placeholder="Escolha da lista ou escreva (ex.: OSCE – Teórico e Prático)" autocomplete="off"></label>
      <datalist id="ap-dl-disc"></datalist>
      <div class="ap-campo"><span>Professores aplicadores</span>
        <div class="ap-chips" id="ap-chips">${(v.aplicadores || []).map(a => `<span class="ap-chip-ed">${esc(a)}<button type="button" data-tirar aria-label="Tirar ${esc(a)}">✕</button></span>`).join('')}</div>
        <div class="ap-add"><input id="ap-add-prof" list="ap-dl-prof" placeholder="Nome do professor e Enter (pode ser só o primeiro nome)" autocomplete="off"><button type="button" class="ap-btn" id="ap-add-btn">Adicionar</button></div>
        <datalist id="ap-dl-prof">${ed.professores.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      </div>
      <label class="ap-campo"><span>Laboratório(s)</span><input name="laboratorios" value="${esc(v.laboratorios)}" placeholder="Ex.: Laboratórios 12 e 20" list="ap-dl-lab"></label>
      <datalist id="ap-dl-lab"><option value="Laboratório 12"><option value="Laboratório 20"><option value="Laboratórios 12 e 20"><option value="Conforme organização"><option value="Tutorias"></datalist>
      <fieldset class="ap-napa-f" id="ap-napa-f">
        <legend>NAPA — alunos com laudo, em sala separada</legend>
        <div class="ap-grid3">
          <label class="ap-campo"><span>Sala</span><input name="napaSala" value="${esc((v.napa && v.napa.sala) || (c.napa && c.napa.sala) || '')}" placeholder="Sala com os notebooks"></label>
          <label class="ap-campo"><span>Responsável</span><input name="napaResp" value="${esc((v.napa && v.napa.responsavel) || '')}" placeholder="Quem aplica no NAPA"></label>
          <label class="ap-campo"><span>Notebooks</span><input type="number" min="0" max="99" name="napaNb" value="${esc(String((v.napa && v.napa.notebooks) || ''))}"></label>
        </div>
      </fieldset>
      <label class="ap-campo"><span>Observação</span><textarea name="observacao" rows="2" maxlength="500">${esc(v.observacao || '')}</textarea></label>
    </form>`;
  const m = modal('ap-m-prova', p ? 'Editar prova' : 'Nova prova', corpo,
    `${p ? '<button type="button" class="ap-btn ap-btn-perigo" id="ap-excluir">Retirar do calendário</button>' : ''}<span class="ap-esp"></span><button type="button" class="ap-btn" data-fechar>Cancelar</button><button type="button" class="ap-btn ap-btn-pri" id="ap-salvar">Salvar</button>`);
  const f = el('ap-f-prova');
  const atualizarTurma = () => {
    const t = f.turma.value;
    el('ap-dl-disc').innerHTML = discDaTurma(t).concat(['OSCE – Teórico e Prático']).map(n => `<option value="${esc(n)}">`).join('');
    const temNapa = (turmas.find(x => x.id === t) || {}).napa;
    el('ap-napa-f').hidden = !temNapa;
    if (temNapa && !f.napaNb.value) f.napaNb.value = ((c.napaAlunos && c.napaAlunos[t]) || []).length || (c.napaQtd && c.napaQtd[t]) || '';
  };
  const atualizarHorario = () => { if (!f.horario.value || ['08:30', '13:30'].includes(f.horario.value)) f.horario.value = f.turno.value === 'tarde' ? '13:30' : f.turno.value === 'manha' ? '08:30' : f.horario.value; };
  const atualizarNapaResp = () => { if (!f.napaResp.value && c.napa) f.napaResp.value = (f.turno.value === 'tarde' ? c.napa.responsavelTarde : c.napa.responsavelManha) || ''; };
  f.turma.addEventListener('change', atualizarTurma);
  f.turno.addEventListener('change', () => { atualizarHorario(); atualizarNapaResp(); });
  atualizarTurma(); atualizarNapaResp();
  const addProf = () => {
    const i = el('ap-add-prof'); const n = i.value.replace(/\s+/g, ' ').trim();
    if (!n) return;
    el('ap-chips').insertAdjacentHTML('beforeend', `<span class="ap-chip-ed">${esc(n)}<button type="button" data-tirar aria-label="Tirar ${esc(n)}">✕</button></span>`);
    i.value = ''; i.focus();
  };
  el('ap-add-btn').onclick = addProf;
  el('ap-add-prof').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addProf(); } });
  el('ap-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-tirar]'); if (b) b.parentElement.remove(); });
  el('ap-salvar').onclick = async () => {
    const pendente = el('ap-add-prof').value.trim(); if (pendente) addProf();
    const corpoReq = {
      semestre: dados.semestre, turma: f.turma.value, data: f.data.value, etapa: f.etapa.value, turno: f.turno.value, horario: f.horario.value,
      tipo: f.tipo.value, disciplina: f.disciplina.value.trim(), laboratorios: f.laboratorios.value.trim(), observacao: f.observacao.value.trim(),
      aplicadores: [...el('ap-chips').querySelectorAll('.ap-chip-ed')].map(x => x.firstChild.textContent.trim()),
      napa: el('ap-napa-f').hidden ? null : { sala: f.napaSala.value.trim(), responsavel: f.napaResp.value.trim(), notebooks: f.napaNb.value }
    };
    if (!corpoReq.data) { toast('Informe a data da prova.', 'erro'); f.data.focus(); return; }
    if (!corpoReq.disciplina) { toast('Informe a disciplina.', 'erro'); f.disciplina.focus(); return; }
    const b = el('ap-salvar'); b.disabled = true; b.textContent = 'Salvando…';
    try {
      const r = await api(p ? `${BASE}/provas/${encodeURIComponent(p.id)}` : `${BASE}/provas`, { method: p ? 'PUT' : 'POST', body: JSON.stringify(corpoReq) });
      m.hidden = true; toast(r.message); await carregar();
    } catch (e) { toast(e.message, 'erro'); b.disabled = false; b.textContent = 'Salvar'; }
  };
  if (p) el('ap-excluir').onclick = async () => {
    const b = el('ap-excluir');
    if (b.dataset.conf !== '1') { b.dataset.conf = '1'; b.textContent = 'Toque de novo para retirar'; return; }
    try { const r = await api(`${BASE}/provas/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); m.hidden = true; toast(r.message); await carregar(); }
    catch (e) { toast(e.message, 'erro'); }
  };
}

function abrirConfig() {
  const c = dados.config;
  const linhasTurma = (c.turmas || []).map(t => `<div class="ap-cfg-turma">
      <input name="tId" value="${esc(t.id)}" aria-label="Nome da turma" maxlength="10">
      <label>Período <input type="number" name="tPer" min="1" max="12" value="${t.periodo}"></label>
      <label class="ap-check"><input type="checkbox" name="tNapa" ${t.napa ? 'checked' : ''}> Tem NAPA</label>
    </div>`).join('');
  const corpo = `<form id="ap-f-cfg" class="ap-form">
    <fieldset><legend>Turmas e período (${esc(dados.semestre)})</legend>${linhasTurma}
      <p class="ap-nota">A cada semestre a turma sobe de período: ajuste aqui (ex.: T3 passa do 2º para o 3º).</p></fieldset>
    <label class="ap-campo"><span>Apoio (um nome por linha)</span><textarea name="apoio" rows="3">${esc((c.apoio || []).join('\n'))}</textarea></label>
    <fieldset><legend>NAPA</legend>
      <div class="ap-grid3">
        <label class="ap-campo"><span>Responsável de manhã</span><input name="napaManha" value="${esc((c.napa && c.napa.responsavelManha) || '')}"></label>
        <label class="ap-campo"><span>Responsável à tarde</span><input name="napaTarde" value="${esc((c.napa && c.napa.responsavelTarde) || '')}"></label>
        <label class="ap-campo"><span>Sala de sempre</span><input name="napaSala" value="${esc((c.napa && c.napa.sala) || '')}" placeholder="Ex.: Sala 5"></label>
      </div>
      ${(c.turmas || []).filter(t => t.napa).map(t => `<label class="ap-campo"><span>Alunos do NAPA da ${esc(t.id)} (um por linha) — só a coordenação vê</span><textarea name="napa_${esc(t.id)}" rows="3">${esc(((c.napaAlunos || {})[t.id] || []).join('\n'))}</textarea></label>`).join('')}
    </fieldset></form>`;
  const m = modal('ap-m-cfg', 'Configurar o calendário', corpo, '<span class="ap-esp"></span><button type="button" class="ap-btn" data-fechar>Cancelar</button><button type="button" class="ap-btn ap-btn-pri" id="ap-cfg-salvar">Salvar</button>');
  el('ap-cfg-salvar').onclick = async () => {
    const f = el('ap-f-cfg');
    const turmas = [...f.querySelectorAll('.ap-cfg-turma')].map(d => ({ id: d.querySelector('[name=tId]').value.trim(), periodo: Number(d.querySelector('[name=tPer]').value), napa: d.querySelector('[name=tNapa]').checked }));
    const linhas = (s) => s.split('\n').map(x => x.trim()).filter(Boolean);
    const napaAlunos = {};
    f.querySelectorAll('textarea[name^="napa_"]').forEach(t => { napaAlunos[t.name.slice(5)] = linhas(t.value); });
    try {
      const r = await api(`${BASE}/config/${encodeURIComponent(dados.semestre)}`, { method: 'PUT', body: JSON.stringify({ turmas, apoio: linhas(f.apoio.value), napa: { responsavelManha: f.napaManha.value, responsavelTarde: f.napaTarde.value, sala: f.napaSala.value }, napaAlunos }) });
      m.hidden = true; toast(r.message); await carregar();
    } catch (e) { toast(e.message, 'erro'); }
  };
}

// ==========================================================================================
// IMPRESSÃO / PDF E IMAGEM (WhatsApp)
// ==========================================================================================
function cabecalhoSaida(titulo) {
  const c = dados.config;
  const et = el('ap-etapa').value;
  const val = c.status === 'validado';
  // identidade MED FATEC (faixa azul royal com as marcas em negativo) — 16/11/2026
  return `<header class="ap-s-cab">
      <img src="/img/naped/medfatec-negativo.png" alt="MED FATEC" class="ap-s-logo-med">
      <div class="ap-s-cab-txt"><h1>${titulo}</h1><p>Medicina · ${esc(dados.semestre)}${et ? ` · ${ETAPA[et]}` : ''}</p></div>
      <img src="/img/naped/fatecivp-negativo.png" alt="FATEC Ivaiporã" class="ap-s-logo-fatec">
    </header>
    <p class="ap-s-val ${val ? '' : 'ap-s-rasc'}">${val ? `Validado por ${esc(c.validadoPor || '')} em ${new Date(c.validadoEm).toLocaleDateString('pt-BR')}` : 'RASCUNHO — calendário ainda não validado'}</p>`;
}
function saidaTurmas() {
  const provas = provasVisiveis();
  return `<div class="ap-s ap-s-turmas">${cabecalhoSaida('Calendário de Provas e Avaliações')}
    <div class="ap-s-cols" style="--n:${(dados.config.turmas || []).length}">${(dados.config.turmas || []).map(t => {
      const ps = provas.filter(p => p.turma === t.id);
      return `<section class="ap-s-col ap-${corTurma(t.id)}"><h2>${esc(t.id)}</h2>
        <table><thead><tr><th>Data</th><th>Disciplina</th><th>Turno</th></tr></thead>
        <tbody>${ps.map(p => `<tr><td><b>${ddmm(p.data)}</b></td><td>${esc(p.disciplina)}</td><td>${TURNO[p.turno]}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</tbody></table></section>`;
    }).join('')}</div>
    <p class="ap-s-rod">Confirme sempre com a coordenação possíveis alterações.</p></div>`;
}
// arte de UMA turma, para mandar aos alunos: sem o nome dos aplicadores (16/11/2026)
function saidaTurma(tid) {
  const t = (dados.config.turmas || []).find(x => x.id === tid) || { id: tid, periodo: '' };
  const ps = provasVisiveis().filter(p => p.turma === tid);
  const blocos = ['b1', 'b2', 'sub', 'exame'].filter(et => SAI[grupoDe(et)]).map(et => ({ et, ps: ps.filter(p => p.etapa === et) })).filter(b => b.ps.length);
  const escolhidos = Object.keys(SAI).filter(k => SAI[k]);
  return `<div class="ap-s ap-s-turma ap-${corTurma(tid)}">${cabecalhoSaida(`${escolhidos.length === 1 ? SAI_ROTULO[escolhidos[0]] : 'Calendário de Provas'} · ${esc(tid)}`)}
    <p class="ap-s-turma-per">${esc(tid)} · ${t.periodo}º período</p>
    ${blocos.map(b => `<section class="ap-s-bloco"><h2>${ETAPA_BLOCO[b.et]}</h2>
      <table><thead><tr><th>Data</th><th>Dia</th><th>Disciplina</th><th>Horário</th><th>Local</th></tr></thead>
      <tbody>${b.ps.map(p => `<tr><td><b>${ddmm(p.data)}</b></td><td>${diaSemana(p.data)}</td><td>${esc(p.disciplina)}</td><td>${hora(p.horario) ? `<b>${hora(p.horario)}</b>` : TURNO[p.turno]}</td><td>${esc(p.laboratorios || '')}</td></tr>`).join('')}</tbody></table></section>`).join('') || '<p>Nenhuma prova.</p>'}
    <p class="ap-s-rod">Confirme sempre com a coordenação possíveis alterações.</p></div>`;
}
function saidaAplicadores() {
  const provas = provasVisiveis();
  const c = dados.config;
  return `<div class="ap-s ap-s-aplic">${cabecalhoSaida('Professores Aplicadores de Provas')}
    <table class="ap-s-tab"><thead><tr><th>Data</th><th>Turma</th><th>Disciplina</th><th>Professores(as) aplicadores(as)</th><th>Horário</th><th>Laboratório(s)</th></tr></thead>
    <tbody>${provas.map(p => `<tr><td><b>${ddmm(p.data)}</b></td><td>${esc(p.turma)}</td><td>${esc(p.disciplina)}</td><td>${(p.aplicadores || []).map(a => esc(curto(a))).join(', ')}</td><td><b>${hora(p.horario) || TURNO[p.turno]}</b></td><td>${esc(p.laboratorios)}</td></tr>`).join('')}</tbody></table>
    <div class="ap-s-equipe"><p><b>Apoio:</b> ${(c.apoio || []).map(esc).join(', ') || '—'}</p>
      <p><b>NAPA:</b> ${[c.napa && c.napa.responsavelManha ? `Manhã: ${esc(c.napa.responsavelManha)}` : '', c.napa && c.napa.responsavelTarde ? `Tarde: ${esc(c.napa.responsavelTarde)}` : ''].filter(Boolean).join(' · ') || '—'}</p></div></div>`;
}
function saidaNapa() {
  const c = dados.config;
  const turmasNapa = (c.turmas || []).filter(t => t.napa).map(t => t.id);
  const provas = provasVisiveis().filter(p => turmasNapa.includes(p.turma));
  return `<div class="ap-s ap-s-aplic">${cabecalhoSaida('NAPA — Provas em sala separada')}
    <table class="ap-s-tab"><thead><tr><th>Data</th><th>Turma</th><th>Disciplina</th><th>Horário</th><th>Sala</th><th>Responsável</th><th>Notebooks</th></tr></thead>
    <tbody>${provas.map(p => { const n = p.napa || {}; return `<tr><td><b>${ddmm(p.data)}</b></td><td>${esc(p.turma)}</td><td>${esc(p.disciplina)}</td><td><b>${hora(p.horario) || TURNO[p.turno]}</b></td><td>${esc(n.sala || '')}</td><td>${esc(n.responsavel || '')}</td><td>${n.notebooks || ((c.napaAlunos || {})[p.turma] || []).length || ''}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function carregarHtml2canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  return new Promise((ok, falha) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    sc.onload = () => ok(window.html2canvas); sc.onerror = () => falha(new Error('Não consegui carregar o gerador de imagem.'));
    document.head.appendChild(sc);
  });
}
async function exportar(tipo) {
  el('ap-menu-exportar').hidden = true; el('ap-exportar').setAttribute('aria-expanded', 'false');
  const turmaSo = (tipo.match(/-turma:(.+)$/) || [])[1];
  if (turmaSo && !Object.values(SAI).some(Boolean)) { toast('Marque o que vai sair na arte: 1ª chamada, 2ª chamada ou exames.', 'erro'); return; }
  if (turmaSo && !provasVisiveis().some(p => p.turma === turmaSo && SAI[grupoDe(p.etapa)])) { toast(`A ${turmaSo} não tem provas no que foi marcado.`, 'erro'); return; }
  if (!provasVisiveis().filter(p => !turmaSo || p.turma === turmaSo).length) { toast(turmaSo ? `A ${turmaSo} não tem provas nessa etapa.` : 'Não há provas nessa etapa.', 'erro'); return; }
  const saida = el('ap-saida');
  saida.innerHTML = turmaSo ? saidaTurma(turmaSo) : tipo.endsWith('turmas') ? saidaTurmas() : tipo.endsWith('napa') ? saidaNapa() : saidaAplicadores();
  saida.firstElementChild.insertAdjacentHTML('beforeend', `<footer class="ap-s-pe">
      <span class="ap-s-orbita"><span class="ap-s-orb"><span>F</span><i></i></span><span class="ap-s-orb-nome"><b>ÓRBITA</b> FATEC</span></span>
      <span>Gerado pelo Órbita em ${new Date().toLocaleDateString('pt-BR')}</span>
    </footer>`);
  if (tipo.startsWith('pdf')) {
    document.body.classList.add('ap-imprimindo');
    setTimeout(() => { window.print(); document.body.classList.remove('ap-imprimindo'); }, 150);
    return;
  }
  try {
    toast('Gerando a imagem…');
    saida.classList.add('ap-saida-img');
    const html2canvas = await carregarHtml2canvas();
    await Promise.all([...saida.querySelectorAll('img')].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })));
    const canvas = await html2canvas(saida.firstElementChild, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    const a = document.createElement('a');
    const sufixo = turmaSo ? '-' + Object.keys(SAI).filter(k => SAI[k]).map(k => ({ c1: '1chamada', sub: '2chamada', exame: 'exames' }[k])).join('-') : '';
    a.download = `${turmaSo ? `calendario-provas-${turmaSo}${sufixo}` : tipo === 'img-turmas' ? 'calendario-provas' : tipo === 'img-napa' ? 'napa-provas' : 'aplicadores-provas'}-medicina-${dados.semestre}.png`;
    a.href = canvas.toDataURL('image/png'); a.click();
    toast('Imagem baixada. É só mandar no WhatsApp.');
  } catch (e) { toast(e.message, 'erro'); }
  finally { saida.classList.remove('ap-saida-img'); }
}

// ==========================================================================================
// DADOS E EVENTOS
// ==========================================================================================
async function carregar() {
  const sem = el('ap-semestre').value;
  try {
    dados = await api(`${BASE}?semestre=${encodeURIComponent(sem)}`);
    render();
  } catch (e) { el('ap-conteudo').innerHTML = `<div class="ap-vazio">${esc(e.message)}</div>`; }
}
function ligarEventos() {
  el('ap-semestre').addEventListener('change', () => { edubox = null; carregar(); });
  el('ap-etapa').addEventListener('change', render);
  document.querySelector('.ap-abas').addEventListener('click', (e) => { const b = e.target.closest('.ap-aba'); if (b) { aba = b.dataset.aba; render(); } });
  el('ap-conteudo').addEventListener('click', (e) => { const t = e.target.closest('[data-prova]'); if (t) abrirProva(t.dataset.prova); });
  el('ap-conteudo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const t = e.target.closest('tr[data-prova]'); if (t) abrirProva(t.dataset.prova); } });
  el('ap-nova').addEventListener('click', () => abrirProva(null));
  el('ap-config').addEventListener('click', abrirConfig);
  el('ap-status').addEventListener('click', async (e) => {
    const v = e.target.closest('#ap-validar'), rb = e.target.closest('#ap-reabrir');
    if (!v && !rb) return;
    const cs = conflitos(dados.provas);
    if (v && cs.length && v.dataset.conf !== '1') { v.dataset.conf = '1'; v.textContent = `Há ${cs.length} choque(s). Validar assim mesmo?`; return; }
    try { const r = await api(`${BASE}/config/${encodeURIComponent(dados.semestre)}/${v ? 'validar' : 'reabrir'}`, { method: 'POST' }); toast(r.message); await carregar(); }
    catch (err) { toast(err.message, 'erro'); }
  });
  el('ap-exportar').addEventListener('click', () => { const m = el('ap-menu-exportar'); m.hidden = !m.hidden; el('ap-exportar').setAttribute('aria-expanded', m.hidden ? 'false' : 'true'); });
  el('ap-menu-exportar').addEventListener('click', (e) => { const b = e.target.closest('[data-exp]'); if (b) exportar(b.dataset.exp); });
  el('ap-menu-exportar').addEventListener('change', (e) => { const c = e.target.closest('[data-sai]'); if (c) SAI[c.dataset.sai] = c.checked; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.ap-menu-wrap')) { el('ap-menu-exportar').hidden = true; el('ap-exportar').setAttribute('aria-expanded', 'false'); } });
}

async function initApp(user, role) {
  if (iniciado) return;
  iniciado = true;
  setupLayout(user, role, 'aplicacao-provas-med', () => { clearCachedAuth(); auth.signOut().then(() => { window.location.href = '../../auth/login.html'; }); });
  el('auth-guard').classList.add('hidden');
  el('app').classList.remove('hidden');
  ligarEventos();
  let semestres = [];
  try { semestres = await api(`${BASE}/semestres`); } catch (e) { semestres = []; }
  const padrao = semestres.includes('2026.2') ? '2026.2' : (semestres[0] || '2026.2');
  el('ap-semestre').innerHTML = (semestres.length ? semestres : [padrao]).map(s => `<option ${s === padrao ? 'selected' : ''}>${esc(s)}</option>`).join('');
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
  // o acesso é decidido no servidor (o GET do calendário responde 403 a quem não pode)
  initApp(user, role);
});
