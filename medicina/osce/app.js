// OSCE — Medicina (25/11/2026)
// Estações (montar ou importar do Word, com a conferência ao lado), OSCE (coordenação: turma, data, estações, valor e
// avaliadores), avaliar na estação (o avaliador marca fez / parcial / não fez e a nota é calculada) e resultado
// (aluno × estação, para baixar). A conta da nota e a conferência são as de window.OsceConferencia — as mesmas do servidor.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";

const C = window.OsceConferencia;
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.'))
  ? `http://${window.location.hostname}:3000/api`
  : '/api';
const BASE = '/osce-med';

let currentUser = null;
let iniciado = false;
let dados = null;       // { semestre, editor, eu, estacoes, osces, provasOsce }
let tela = { v: 'inicio' };
let aberta = null;      // { osce, editor, minhas, estacoes, alunos, notas }
let disciplinas = null; // [{ nome, periodo }]
const planos = new Map();
let professores = null;

const el = (id) => document.getElementById(id);
const fmt = (v) => C.fmt(v);
const GLOBAL = ['Insuficiente', 'Limítrofe', 'Satisfatório', 'Bom', 'Excelente'];
const linhas = (s) => String(s || '').split(/\n/).map(x => x.trim()).filter(Boolean);
const dataBR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

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
const enviar = (u, b, metodo = 'POST') => api(u, { method: metodo, body: JSON.stringify(b) });
function toast(msg, tipo = 'ok') {
  let t = el('oc-toast');
  if (!t) { t = document.createElement('div'); t.id = 'oc-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.className = `oc-toast-${tipo}`; t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4500);
}
function trilha(itens) {
  el('oc-trilha').innerHTML = itens.map((it, i) => i < itens.length - 1
    ? `<button type="button" data-ir="${esc(it.ir)}">${esc(it.t)}</button><span aria-hidden="true">›</span>`
    : `<span class="oc-trilha-atual">${esc(it.t)}</span>`).join('');
}
const seloConf = (c) => (!c ? '' : c.importantes ? `<span class="oc-selo oc-selo-imp">${c.importantes} ponto(s) importante(s)</span>` : c.sugestoes ? `<span class="oc-selo oc-selo-sug">${c.sugestoes} sugestão(ões)</span>` : '<span class="oc-selo oc-selo-ok">Sem pendências</span>');

// ============================================================ início
async function carregar() {
  dados = await api(`${BASE}?semestre=${encodeURIComponent(el('oc-semestre').value)}`);
  render();
}
function render() {
  if (tela.v === 'estacao') return renderEstacao();
  if (tela.v === 'osce') return renderOsceForm();
  if (tela.v === 'avaliar') return renderAvaliar();
  if (tela.v === 'resultado') return renderResultado();
  trilha([{ t: 'OSCE' }]);
  const d = dados;
  el('oc-conteudo').innerHTML = `
    <section class="oc-bloco">
      <header><h2>OSCEs do semestre</h2>${d.editor ? '<button type="button" class="oc-btn oc-btn-pri" data-a="nova-osce">+ Nova OSCE</button>' : ''}</header>
      ${d.osces.length ? `<div class="oc-cards">${d.osces.map(o => `<article class="oc-card">
        <h3>${esc(o.nome)}</h3>
        <p class="oc-nota">${esc(o.turma)} · ${dataBR(o.data) || 'data a definir'} · ${(o.estacoes || []).length} estação(ões) · total ${fmt(o.total)} pontos</p>
        <div class="oc-acoes">
          <button type="button" class="oc-btn oc-btn-pri" data-a="avaliar" data-id="${esc(o.id)}">Avaliar</button>
          ${d.editor ? `<button type="button" class="oc-btn" data-a="resultado" data-id="${esc(o.id)}">Resultado</button><button type="button" class="oc-btn" data-a="editar-osce" data-id="${esc(o.id)}">Editar</button>` : ''}
        </div></article>`).join('')}</div>` : `<div class="oc-vazio">${d.editor ? 'Nenhuma OSCE montada. Use “+ Nova OSCE” (as estações precisam estar cadastradas).' : 'Você ainda não está como avaliador em nenhuma OSCE deste semestre.'}</div>`}
    </section>
    <section class="oc-bloco">
      <header><h2>Estações</h2><div class="oc-acoes">
        <button type="button" class="oc-btn" data-a="importar">Importar do Word</button>
        <button type="button" class="oc-btn oc-btn-pri" data-a="nova-estacao">+ Nova estação</button></div></header>
      <p class="oc-nota">Monte a estação aqui ou suba o Word no modelo da Fatec. O Órbita mostra o que já está bom e o que pode melhorar, com o porquê — quem decide é o professor.</p>
      ${d.estacoes.length ? `<div class="oc-wrap"><table class="oc-tab"><thead><tr><th>Disciplina</th><th>Tema</th><th>Itens</th><th>Montada por</th><th>Conferência</th></tr></thead>
        <tbody>${d.estacoes.map(e => `<tr data-ir="estacao:${esc(e.id)}" tabindex="0"><td>${esc(e.disciplina)}</td><td><b>${esc(e.tema)}</b></td><td>${(e.itens || []).length}</td><td>${esc(e.autorNome || '')}</td><td>${seloConf(e.conf)}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="oc-vazio">Nenhuma estação ainda.</div>'}
    </section>`;
}

// ============================================================ estação: editor + conferência ao vivo
async function carregarDisciplinas() {
  if (!disciplinas) { try { disciplinas = await api(`${BASE}/disciplinas?semestre=${encodeURIComponent(dados.semestre)}`); } catch (e) { disciplinas = []; } }
  return disciplinas;
}
async function objetivosDe(disc) {
  if (!disc) return [];
  if (!planos.has(disc)) { try { planos.set(disc, (await api(`${BASE}/plano?semestre=${encodeURIComponent(dados.semestre)}&disciplina=${encodeURIComponent(disc)}`)).objetivos || []); } catch (e) { planos.set(disc, []); } }
  return planos.get(disc);
}
function estacaoVazia() {
  return { disciplina: '', tema: '', objetivo: '', tempoMin: '', cenario: '', tarefas: [], itens: [{ texto: '', parcial: '', peso: 1 }], criticos: [], escalaGlobal: true, papelAvaliador: '', materiais: [], gabarito: '' };
}
async function abrirEstacao(id, pre) {
  const e = id ? dados.estacoes.find(x => x.id === id) : null;
  tela = { v: 'estacao', id: e ? e.id : null, e: JSON.parse(JSON.stringify(pre || e || estacaoVazia())) };
  await carregarDisciplinas();
  renderEstacao();
}
function podeMexer(e) { return !tela.id || dados.editor || (dados.estacoes.find(x => x.id === tela.id) || {}).autorUid === dados.eu.uid; }
async function renderEstacao() {
  const e = tela.e;
  trilha([{ t: 'OSCE', ir: 'inicio' }, { t: tela.id ? `Estação: ${e.tema || ''}` : 'Nova estação' }]);
  const objs = await objetivosDe(e.disciplina);
  const pode = podeMexer(e);
  const dis = pode ? '' : 'disabled';
  el('oc-conteudo').innerHTML = `<div class="oc-editor">
    <form class="oc-bloco oc-form" id="oc-f-est" novalidate>
      <header><h2>${tela.id ? 'Editar estação' : 'Nova estação'}</h2><div class="oc-acoes">
        <button type="button" class="oc-btn" data-a="imprimir-estacao">Imprimir folha</button>
        ${pode && tela.id ? '<button type="button" class="oc-btn oc-btn-perigo" data-a="apagar-estacao">Apagar</button>' : ''}
        ${pode ? '<button type="button" class="oc-btn oc-btn-pri" data-a="salvar-estacao">Salvar</button>' : ''}</div></header>
      <div class="oc-grid3">
        <label class="oc-campo">Disciplina<select name="disciplina" ${dis}><option value="">— escolha —</option>${disciplinas.map(d => `<option ${d.nome === e.disciplina ? 'selected' : ''}>${esc(d.nome)}</option>`).join('')}${e.disciplina && !disciplinas.some(d => d.nome === e.disciplina) ? `<option selected>${esc(e.disciplina)}</option>` : ''}</select></label>
        <label class="oc-campo">Tema da estação<input name="tema" value="${esc(e.tema)}" placeholder="Ex.: Via aérea — intubação com Bougie" ${dis}></label>
        <label class="oc-campo">Tempo (min)<input name="tempoMin" type="number" min="1" max="60" value="${esc(String(e.tempoMin || ''))}" ${dis}></label>
      </div>
      <label class="oc-campo">Objetivo do plano de ensino <small>${e.disciplina ? (objs.length ? 'escolha o que esta estação avalia' : 'o plano de ensino desta disciplina não tem objetivos no Edubox — escreva o objetivo') : 'escolha a disciplina primeiro'}</small>
        ${objs.length ? `<select name="objetivo" ${dis}><option value="">— escolha —</option>${objs.map(o => `<option ${o === e.objetivo ? 'selected' : ''}>${esc(o)}</option>`).join('')}${e.objetivo && !objs.includes(e.objetivo) ? `<option selected>${esc(e.objetivo)}</option>` : ''}</select>` : `<input name="objetivo" value="${esc(e.objetivo)}" ${dis}>`}</label>
      <label class="oc-campo">Cenário (o aluno lê na porta)<textarea name="cenario" rows="4" ${dis}>${esc(e.cenario)}</textarea></label>
      <label class="oc-campo">Tarefas do aluno <small>uma por linha</small><textarea name="tarefas" rows="4" ${dis}>${esc((e.tarefas || []).join('\n'))}</textarea></label>
      <div class="oc-campo">Checklist do avaliador <small>um passo que dá para ver por item · diga quando vale “parcial” · peso 1 = normal</small>
        <div class="oc-itens" id="oc-itens">${(e.itens || []).map((it, i) => linhaItem(it, i, dis)).join('')}</div>
        ${pode ? '<button type="button" class="oc-btn" data-a="add-item">+ Item</button>' : ''}</div>
      <label class="oc-campo">Erros críticos <small>um por linha — a coordenação define a consequência</small><textarea name="criticos" rows="3" ${dis}>${esc((e.criticos || []).join('\n'))}</textarea></label>
      <label class="oc-chk" style="display:flex;gap:.5rem;align-items:center;font-weight:700;font-size:.85rem"><input type="checkbox" name="escalaGlobal" ${e.escalaGlobal !== false ? 'checked' : ''} ${dis}> Impressão geral do avaliador (insuficiente → excelente)</label>
      <label class="oc-campo">Papel do avaliador <small>o que ele faz e o que não faz (igual para todos os alunos)</small><textarea name="papelAvaliador" rows="3" ${dis}>${esc(e.papelAvaliador)}</textarea></label>
      <label class="oc-campo">Materiais da sala <small>um por linha</small><textarea name="materiais" rows="3" ${dis}>${esc((e.materiais || []).join('\n'))}</textarea></label>
      <label class="oc-campo">Gabarito da técnica <small>para o avaliador</small><textarea name="gabarito" rows="5" ${dis}>${esc(e.gabarito)}</textarea></label>
    </form>
    <aside class="oc-bloco oc-conf" id="oc-conf" aria-live="polite"></aside>
  </div>`;
  renderConf();
}
function linhaItem(it, i, dis = '') {
  return `<div class="oc-item" data-i="${i}">
    <span class="oc-item-n">${i + 1}</span>
    <div class="oc-item-campos">
      <input type="text" data-k="texto" value="${esc(it.texto || '')}" placeholder="O que o avaliador vê (ex.: introduz o Bougie com a ponta para cima)" aria-label="Item ${i + 1}" ${dis}>
      <input type="text" class="oc-parcial" data-k="parcial" value="${esc(it.parcial || '')}" placeholder="Quando vale parcial (ex.: esquece 1 material)" aria-label="Parcial do item ${i + 1}" ${it.semParcial ? 'disabled' : dis}>
      <label class="oc-chk"><input type="checkbox" data-k="semParcial" ${it.semParcial ? 'checked' : ''} ${dis}> Este item não tem parcial</label>
    </div>
    <label class="oc-peso">Peso<input type="number" min="0.5" max="10" step="0.5" data-k="peso" value="${esc(String(it.peso || 1))}" ${dis}></label>
    <button type="button" class="oc-x" data-a="tirar-item" data-i="${i}" aria-label="Tirar item ${i + 1}" ${dis}>✕</button>
  </div>`;
}
function lerForm() {
  const f = el('oc-f-est');
  if (!f) return;
  const e = tela.e;
  e.disciplina = f.disciplina.value; e.tema = f.tema.value; e.tempoMin = f.tempoMin.value;
  e.objetivo = f.objetivo ? f.objetivo.value : ''; e.cenario = f.cenario.value; e.tarefas = linhas(f.tarefas.value);
  e.criticos = linhas(f.criticos.value); e.escalaGlobal = f.escalaGlobal.checked; e.papelAvaliador = f.papelAvaliador.value;
  e.materiais = linhas(f.materiais.value); e.gabarito = f.gabarito.value;
  e.itens = [...document.querySelectorAll('#oc-itens .oc-item')].map(d => ({
    texto: d.querySelector('[data-k=texto]').value, parcial: d.querySelector('[data-k=parcial]').value,
    semParcial: d.querySelector('[data-k=semParcial]').checked, peso: Number(d.querySelector('[data-k=peso]').value) || 1
  }));
}
function renderConf() {
  const c = C.conferir(tela.e, window.RevisaoPt);
  const box = el('oc-conf');
  if (!box) return;
  box.innerHTML = `<h2>Conferência da estação</h2>
    <div class="oc-conf-resumo">${c.importantes ? `${c.importantes} ponto(s) importante(s) para a correção ficar igual entre avaliadores` : c.sugestoes.length ? 'Nada que atrapalhe a correção. Há sugestões para melhorar.' : 'Estação completa pelos critérios do Órbita.'}</div>
    ${c.fortes.length ? `<h3>O que já está bom</h3><ul>${c.fortes.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
    ${c.sugestoes.length ? `<h3>O que pode melhorar</h3>${c.sugestoes.map(s => `<div class="oc-sug ${s.nivel === 'importante' ? 'oc-imp' : ''}"><b>${esc(s.campo)} · ${esc(s.oque)}</b><p class="oc-porque"><b style="display:inline">Por quê:</b> ${esc(s.porque)}</p><p class="oc-como"><b style="display:inline">Sugestão:</b> ${esc(s.como)}</p></div>`).join('')}` : ''}
    ${c.portugues.length ? `<h3>Português</h3><ul>${c.portugues.map(p => `<li class="oc-pt"><b>${esc(p.campo)}:</b> ${p.de ? `<s>${esc(p.de)}</s> → <ins>${esc(p.para || '')}</ins> ` : ''}<span>${esc(p.motivo || '')}</span></li>`).join('')}</ul>` : ''}
    <p class="oc-nota">A conferência segue os guias internacionais de OSCE (AMEE 81 e 49). São sugestões: a decisão é do professor e a validação, da coordenação do curso.</p>`;
}
async function salvarEstacao() {
  lerForm();
  const e = tela.e;
  const corpo = { ...e, semestre: dados.semestre, itens: e.itens.filter(it => String(it.texto).trim()) };
  const r = tela.id ? await enviar(`${BASE}/estacoes/${encodeURIComponent(tela.id)}`, corpo, 'PUT') : await enviar(`${BASE}/estacoes`, corpo);
  toast(r.message);
  if (!tela.id && r.id) tela.id = r.id;
  await carregar();
  tela.v = 'estacao';
  renderEstacao();
}

// ============================================================ importar do Word (modelo da Fatec: tabela TAREFA / CENÁRIO / TAREFAS / Gabarito)
async function lerWord(arquivo) {
  if (!window.JSZip) throw new Error('O leitor de Word ainda está carregando. Tente de novo em instantes.');
  const zip = await window.JSZip.loadAsync(arquivo);
  const xml = await zip.file('word/document.xml').async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const textoDe = (n) => [...n.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join('').replace(/\s+/g, ' ').trim();
  const corpo = doc.getElementsByTagNameNS(W, 'body')[0];
  const blocos = [];
  [...corpo.childNodes].forEach(n => {
    if (n.localName === 'p') { const t = textoDe(n); if (t) blocos.push({ p: t }); }
    else if (n.localName === 'tbl') blocos.push({ tab: [...n.getElementsByTagNameNS(W, 'tr')].map(tr => [...tr.getElementsByTagNameNS(W, 'tc')].map(tc => textoDe(tc))) });
  });
  const e = estacaoVazia();
  e.itens = [];
  blocos.filter(b => b.tab).forEach(b => b.tab.forEach(cel => cel.forEach(c => {
    const m = c.match(/^Tema:\s*(.+)$/i); if (m) e.tema = m[1].trim();
    const d = c.match(/^Disciplina[^:]*:\s*(.+)$/i); if (d) e.disciplinaWord = d[1].trim();
  })));
  // checklist: linhas depois do cabeçalho "TAREFA | Correto | Parcial | Não fez"
  blocos.filter(b => b.tab).forEach(b => {
    let dentro = false;
    b.tab.forEach(l => {
      const t0 = (l[0] || '').trim();
      if (/^TAREFA$/i.test(t0)) { dentro = true; return; }
      if (!dentro) return;
      if (/^TOTAL/i.test(t0)) { dentro = false; return; }
      if (t0) e.itens.push({ texto: t0.replace(/^[•\-–\s]+/, ''), parcial: '', peso: 1 });
    });
  });
  // seções em texto
  let sec = '';
  const gab = [];
  blocos.filter(b => b.p).forEach(({ p }) => {
    if (/^CEN[AÁ]RIO:?$/i.test(p)) { sec = 'cen'; return; }
    if (/^TAREFAS:?$/i.test(p)) { sec = 'tar'; return; }
    if (/^Gabarito:?$/i.test(p)) { sec = 'gab'; return; }
    if (/^ORIENTA/i.test(p)) { sec = ''; return; }
    if (sec === 'cen') e.cenario += (e.cenario ? '\n' : '') + p;
    else if (sec === 'tar') e.tarefas.push(p.replace(/^[•\-–\s]+/, ''));
    else if (sec === 'gab') gab.push(p);
  });
  e.gabarito = gab.join('\n');
  // "Materiais que deverão ser selecionados: - Laringoscópio - Tubo ..." → materiais
  const iMat = gab.findIndex(g => /materiais/i.test(g));
  if (iMat >= 0) for (let i = iMat + 1; i < gab.length && /^[-–]\s*/.test(gab[i]); i++) e.materiais.push(gab[i].replace(/^[-–]\s*/, ''));
  if (!e.itens.length && !e.cenario) throw new Error('Não reconheci o modelo da estação neste Word (tabela "TAREFA" e partes "CENÁRIO", "TAREFAS", "Gabarito").');
  if (!e.itens.length) e.itens = [{ texto: '', parcial: '', peso: 1 }];
  return e;
}

// ============================================================ OSCE (coordenação)
async function abrirOsceForm(id) {
  const o = id ? dados.osces.find(x => x.id === id) : null;
  if (!professores) { try { professores = await api(`${BASE}/professores`); } catch (e) { professores = []; } }
  tela = { v: 'osce', id: o ? o.id : null, o: JSON.parse(JSON.stringify(o || { nome: '', turma: 'T1', data: '', provaId: '', total: 40, estacoes: [] })) };
  renderOsceForm();
}
function renderOsceForm() {
  const o = tela.o;
  trilha([{ t: 'OSCE', ir: 'inicio' }, { t: tela.id ? `Editar: ${o.nome}` : 'Nova OSCE' }]);
  const soma = (o.estacoes || []).reduce((s, x) => s + (Number(x.valor) || 0), 0);
  el('oc-conteudo').innerHTML = `<form class="oc-bloco oc-form" id="oc-f-osce" novalidate>
    <header><h2>${tela.id ? 'Editar OSCE' : 'Nova OSCE'}</h2><div class="oc-acoes">
      ${tela.id ? '<button type="button" class="oc-btn oc-btn-perigo" data-a="apagar-osce">Apagar</button>' : ''}
      <button type="button" class="oc-btn oc-btn-pri" data-a="salvar-osce">Salvar</button></div></header>
    <div class="oc-grid3">
      <label class="oc-campo">Nome<input name="nome" value="${esc(o.nome)}" placeholder="Ex.: OSCE Clínica Cirúrgica · T1"></label>
      <label class="oc-campo">Data (da Aplicação de Provas)<select name="provaId"><option value="">— escolha —</option>${dados.provasOsce.map(p => `<option value="${esc(p.id)}" ${p.id === o.provaId ? 'selected' : ''}>${dataBR(p.data)} · ${esc(p.turma)} · ${esc(p.etapa === 'sub' ? '2ª chamada' : p.etapa === 'exame' ? 'Exame' : '1ª chamada')}</option>`).join('')}</select></label>
      <label class="oc-campo">Total (pontos)<input name="total" type="number" min="1" max="100" value="${esc(String(o.total || 40))}"></label>
    </div>
    <label class="oc-campo" style="max-width:220px">Turma<select name="turma">${['T1', 'T2', 'T3'].map(t => `<option ${t === o.turma ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <div class="oc-campo">Estações (o aluno passa por todas) <small>soma dos valores: <b>${fmt(soma)}</b> de ${fmt(o.total || 40)} ${Math.abs(soma - (o.total || 40)) > 0.01 ? '· <span class="oc-selo oc-selo-imp">a soma não bate com o total</span>' : '· <span class="oc-selo oc-selo-ok">ok</span>'}</small>
      <div class="oc-wrap"><table class="oc-tab"><thead><tr><th>#</th><th>Estação</th><th>Vale</th><th>Avaliador(es)</th><th></th></tr></thead><tbody>
      ${(o.estacoes || []).map((x, i) => { const e = dados.estacoes.find(s => s.id === x.estacaoId) || {}; return `<tr data-i="${i}">
        <td>${i + 1}</td><td><b>${esc(e.tema || '(estação apagada)')}</b><br><small>${esc(e.disciplina || '')}</small></td>
        <td><input type="number" min="0" max="100" step="0.5" data-k="valor" value="${esc(String(x.valor))}" style="width:5.5rem;min-height:38px"></td>
        <td>${(x.avaliadores || []).map((a, j) => `<span class="oc-selo oc-selo-sug">${esc(a.nome)} <button type="button" data-a="tirar-aval" data-i="${i}" data-j="${j}" aria-label="Tirar ${esc(a.nome)}" style="border:0;background:none;cursor:pointer">✕</button></span>`).join(' ')}
          <select data-k="add-aval" data-i="${i}" style="min-height:36px;margin-top:.3rem"><option value="">+ avaliador</option>${(professores || []).map(p => `<option value="${esc(p.uid)}">${esc(p.nome)}</option>`).join('')}</select></td>
        <td><button type="button" class="oc-x" data-a="tirar-est" data-i="${i}" aria-label="Tirar estação">✕</button></td></tr>`; }).join('') || '<tr><td colspan="5">Nenhuma estação ainda.</td></tr>'}
      </tbody></table></div>
      <div class="oc-acoes"><select id="oc-add-est" style="min-height:40px;max-width:100%"><option value="">+ escolher estação…</option>${dados.estacoes.filter(e => !(o.estacoes || []).some(x => x.estacaoId === e.id)).map(e => `<option value="${esc(e.id)}">${esc(e.disciplina)} · ${esc(e.tema)}</option>`).join('')}</select>
        <button type="button" class="oc-btn" data-a="distribuir">Dividir o total igualmente</button></div>
    </div>
  </form>`;
}
function lerOsceForm() {
  const f = el('oc-f-osce');
  if (!f) return;
  const o = tela.o;
  o.nome = f.nome.value; o.turma = f.turma.value; o.total = Number(f.total.value) || 40; o.provaId = f.provaId.value;
  const p = dados.provasOsce.find(x => x.id === o.provaId);
  if (p) { o.data = p.data; if (!o.turma) o.turma = p.turma; }
  document.querySelectorAll('#oc-f-osce tr[data-i] [data-k=valor]').forEach(i => { o.estacoes[Number(i.closest('tr').dataset.i)].valor = Number(i.value) || 0; });
}

// ============================================================ avaliar na estação
async function abrirOsce(id, v) {
  aberta = await api(`${BASE}/osces/${encodeURIComponent(id)}`);
  const minhas = aberta.editor ? aberta.estacoes.map(e => e.id) : aberta.minhas;
  tela = { v, estacaoId: (tela.osceId === id && tela.estacaoId) || minhas[0] || '', ra: '', osceId: id, busca: '' };
  render();
}
const cfgDe = (eid) => (aberta.osce.estacoes || []).find(x => x.estacaoId === eid) || {};
const notaDe = (eid, ra) => aberta.notas.find(n => n.estacaoId === eid && n.ra === ra);
function renderAvaliar() {
  const o = aberta.osce;
  trilha([{ t: 'OSCE', ir: 'inicio' }, { t: `${o.nome} · avaliar` }]);
  const visiveis = aberta.editor ? aberta.estacoes : aberta.estacoes.filter(e => aberta.minhas.includes(e.id));
  const est = visiveis.find(e => e.id === tela.estacaoId) || visiveis[0];
  if (!est) { el('oc-conteudo').innerHTML = '<div class="oc-vazio">Nenhuma estação para você nesta OSCE.</div>'; return; }
  tela.estacaoId = est.id;
  const busca = (tela.busca || '').toLowerCase();
  const alunos = aberta.alunos.filter(a => !busca || a.nome.toLowerCase().includes(busca) || a.ra.includes(busca));
  const feitos = aberta.alunos.filter(a => notaDe(est.id, a.ra)).length;
  el('oc-conteudo').innerHTML = `
    <section class="oc-bloco"><header>
      <label class="oc-campo" style="min-width:min(100%,420px)">Estação<select id="oc-est-sel">${visiveis.map(e => `<option value="${esc(e.id)}" ${e.id === est.id ? 'selected' : ''}>${esc(e.tema)} · vale ${fmt(cfgDe(e.id).valor)}</option>`).join('')}</select></label>
      <div class="oc-acoes"><span class="oc-nota">${feitos} de ${aberta.alunos.length} alunos avaliados</span>
        <button type="button" class="oc-btn" data-a="imprimir-osce">Folhas impressas (reserva)</button></div></header>
      ${est.papelAvaliador ? `<p class="oc-nota"><b>Seu papel:</b> ${esc(est.papelAvaliador)}</p>` : ''}
    </section>
    <div class="oc-aval">
      <aside class="oc-bloco oc-alunos"><input type="search" id="oc-busca" placeholder="Buscar aluno" value="${esc(tela.busca || '')}" aria-label="Buscar aluno">
        ${alunos.map(a => { const n = notaDe(est.id, a.ra); return `<button type="button" class="oc-aluno ${a.ra === tela.ra ? 'ativo' : ''}" data-ra="${esc(a.ra)}"><span>${esc(a.nome)}</span><small>${n ? (n.ausente ? '<span class="oc-selo oc-selo-crit">ausente</span>' : `<span class="oc-selo ${n.completo ? 'oc-selo-ok' : 'oc-selo-imp'}">${fmt(n.pontos)}</span>`) : ''}</small></button>`; }).join('') || '<p class="oc-nota">Nenhum aluno.</p>'}
      </aside>
      <section class="oc-bloco" id="oc-marcar">${tela.ra ? formMarcar(est) : '<div class="oc-vazio">Escolha o aluno que entrou na estação.</div>'}</section>
    </div>`;
}
function formMarcar(est) {
  const a = aberta.alunos.find(x => x.ra === tela.ra);
  const n = notaDe(est.id, tela.ra);
  if (!tela.rasc || tela.rasc.ra !== tela.ra || tela.rasc.eid !== est.id) tela.rasc = { ra: tela.ra, eid: est.id, marcas: n ? [...(n.marcas || [])] : est.itens.map(() => null), criticos: n ? [...(n.criticos || [])] : (est.criticos || []).map(() => false), global: n ? n.global : null, comentario: n ? n.comentario || '' : '' };
  const r = tela.rasc;
  const calc = C.calcular(est, r.marcas, cfgDe(est.id).valor);
  return `<h2 style="margin:0 0 .6rem">${esc(a.nome)} <small class="oc-nota">RA ${esc(a.ra)}</small></h2>
    <div class="oc-marcar">${est.itens.map((it, i) => `<div class="oc-linha ${r.marcas[i] !== null && r.marcas[i] !== undefined ? 'feito' : ''}">
      <b style="text-align:center">${i + 1}</b>
      <div>${esc(it.texto)}${C.temParcial(it) && it.parcial ? `<small>Parcial: ${esc(it.parcial)}</small>` : ''}</div>
      <div class="oc-opcoes" role="group" aria-label="Item ${i + 1}">
        <button type="button" class="oc-op oc-fez" data-m="1" data-i="${i}" aria-pressed="${r.marcas[i] === 1}">Fez</button>
        <button type="button" class="oc-op oc-parc" data-m="0.5" data-i="${i}" aria-pressed="${r.marcas[i] === 0.5}" ${C.temParcial(it) ? '' : 'disabled'}>Parcial</button>
        <button type="button" class="oc-op oc-nao" data-m="0" data-i="${i}" aria-pressed="${r.marcas[i] === 0}">Não fez</button>
      </div></div>`).join('')}</div>
    ${(est.criticos || []).length ? `<div class="oc-crit" style="margin-top:.7rem"><b>Erro crítico — marque se aconteceu</b>${est.criticos.map((c, i) => `<label><input type="checkbox" data-crit="${i}" ${r.criticos[i] ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div>` : ''}
    ${est.escalaGlobal !== false ? `<div style="margin-top:.7rem"><b>Impressão geral</b> <span class="oc-nota">sem olhar a soma: este aluno está pronto para fazer isso num paciente?</span>
      <div class="oc-global" role="group" aria-label="Impressão geral">${GLOBAL.map((g, i) => `<button type="button" data-g="${i + 1}" aria-pressed="${r.global === i + 1}">${g}</button>`).join('')}</div></div>` : ''}
    <label class="oc-campo" style="margin-top:.7rem">Comentário (opcional)<input id="oc-coment" value="${esc(r.comentario)}"></label>
    <div class="oc-total" style="margin-top:.8rem"><span>Nota da estação: <b>${fmt(calc.pontos)}</b> de ${fmt(calc.valor)} · ${calc.marcados}/${est.itens.length} itens marcados</span>
      <div class="oc-acoes"><button type="button" class="oc-btn" data-a="ausente">Ausente</button><button type="button" class="oc-btn" data-a="salvar-nota">Salvar e próximo aluno</button></div></div>`;
}
async function salvarNota(ausente) {
  const est = aberta.estacoes.find(e => e.id === tela.estacaoId);
  const r = tela.rasc;
  if (!ausente && r.marcas.some(m => m === null || m === undefined)) {
    if (!confirm('Há itens sem marcar. Eles contam como "não fez". Salvar assim mesmo?')) return;
  }
  const res = await enviar(`${BASE}/osces/${encodeURIComponent(aberta.osce.id)}/notas`, { estacaoId: est.id, ra: tela.ra, marcas: r.marcas, criticos: r.criticos, global: r.global, comentario: el('oc-coment') ? el('oc-coment').value : '', ausente }, 'PUT');
  aberta.notas = aberta.notas.filter(n => n.id !== res.nota.id).concat(res.nota);
  toast(res.message);
  // próximo aluno ainda sem nota nesta estação
  const prox = aberta.alunos.find(a => !notaDe(est.id, a.ra));
  tela.ra = prox ? prox.ra : ''; tela.rasc = null;
  renderAvaliar();
}

// ============================================================ resultado (coordenação)
function totais() {
  const o = aberta.osce;
  return aberta.alunos.map(a => {
    const porEst = (o.estacoes || []).map(x => notaDe(x.estacaoId, a.ra));
    const total = porEst.reduce((s, n) => s + (n ? Number(n.pontos) || 0 : 0), 0);
    const faltam = porEst.filter(n => !n).length;
    const crit = porEst.some(n => n && (n.criticos || []).some(Boolean));
    return { a, porEst, total: C.r2(total), faltam, crit };
  });
}
function renderResultado() {
  const o = aberta.osce;
  trilha([{ t: 'OSCE', ir: 'inicio' }, { t: `${o.nome} · resultado` }]);
  const ests = (o.estacoes || []).map(x => aberta.estacoes.find(e => e.id === x.estacaoId) || { tema: '?' });
  const t = totais();
  el('oc-conteudo').innerHTML = `<section class="oc-bloco"><header><h2>${esc(o.nome)} · ${esc(o.turma)} · ${dataBR(o.data)}</h2>
      <div class="oc-acoes"><button type="button" class="oc-btn" data-a="planilha">Baixar planilha (Excel)</button><button type="button" class="oc-btn" data-a="avaliar" data-id="${esc(o.id)}">Ir para avaliar</button></div></header>
    <p class="oc-nota">${t.filter(x => !x.faltam).length} de ${t.length} alunos com todas as estações · <span class="oc-selo oc-selo-crit">!</span> = erro crítico marcado (a coordenação decide).</p>
    <div class="oc-wrap"><table class="oc-tab"><thead><tr><th>Aluno(a)</th>${ests.map((e, i) => `<th title="${esc(e.tema)}">E${i + 1} <small>(${fmt(o.estacoes[i].valor)})</small></th>`).join('')}<th>Total (${fmt(o.total)})</th></tr></thead>
    <tbody>${t.map(x => `<tr><td>${esc(x.a.nome)}${x.crit ? ' <span class="oc-selo oc-selo-crit">!</span>' : ''}</td>${x.porEst.map(n => `<td>${n ? (n.ausente ? 'aus.' : fmt(n.pontos)) : '<span class="oc-nota">—</span>'}</td>`).join('')}<td><b>${fmt(x.total)}</b>${x.faltam ? ` <small class="oc-nota">(faltam ${x.faltam})</small>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <p class="oc-nota">${ests.map((e, i) => `E${i + 1} = ${esc(e.tema)}`).join(' · ')}</p></section>`;
}
function baixarPlanilha() {
  const o = aberta.osce;
  const ests = (o.estacoes || []).map(x => aberta.estacoes.find(e => e.id === x.estacaoId) || { tema: '?' });
  const cel = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lin = [['RA', 'Aluno', ...ests.map((e, i) => `E${i + 1} ${e.tema}`), 'Total', 'Erro crítico'].map(cel).join(';')];
  totais().forEach(x => lin.push([x.a.ra, x.a.nome, ...x.porEst.map(n => (n ? (n.ausente ? 'ausente' : fmt(n.pontos)) : '')), fmt(x.total), x.crit ? 'sim' : ''].map(cel).join(';')));
  const blob = new Blob(['﻿' + lin.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${o.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w -]+/g, '')} - notas.csv`;
  a.click();
  toast('Planilha baixada. Abre no Excel e no Google Planilhas.');
}

// ============================================================ impressão (folha do avaliador + orientação do aluno)
function folhaAvaliador(e, aluno, valor) {
  return `<div class="oc-folha">
    <div class="oc-folha-cab"><img src="/img/medfatec-logo.png" alt=""><img src="/img/fatec-ivp-horizontal.png" alt=""></div>
    <h1>OSCE · FOLHA DO AVALIADOR</h1><h2>Estação: ${esc(e.tema)}</h2>
    <table><tr><td style="width:62%"><b>Aluno(a):</b> ${esc(aluno ? aluno.nome : '')}</td><td><b>RA/Nº:</b> ${esc(aluno ? aluno.ra : '')}</td></tr>
      <tr><td><b>Avaliador(a):</b></td><td><b>Data:</b> ___/___/______ ${e.tempoMin ? `· <b>Tempo:</b> ${esc(String(e.tempoMin))} min` : ''}</td></tr></table>
    <p style="font-size:8.5pt;font-style:italic;color:#5b6a80">Marque um X em cada linha. "Parcial" só quando acontecer o que está escrito embaixo do item.</p>
    <table><thead><tr><th style="width:6%">Nº</th><th>O que observar</th><th class="oc-c">Fez</th><th class="oc-c">Parcial</th><th class="oc-c">Não fez</th></tr></thead><tbody>
      ${(e.itens || []).map((it, i) => `<tr><td class="oc-c"><b>${i + 1}</b></td><td>${esc(it.texto)}${C.temParcial(it) && it.parcial ? `<span class="oc-parc-txt">Parcial: ${esc(it.parcial)}</span>` : ''}</td><td class="oc-c">☐ ${fmt(C.pesoDe(it))}</td><td class="oc-c">${C.temParcial(it) ? `☐ ${fmt(C.pesoDe(it) / 2)}` : '—'}</td><td class="oc-c">☐ 0</td></tr>`).join('')}
      <tr><td colspan="2" style="text-align:right"><b>SOMA DOS ITENS</b></td><td colspan="3" class="oc-c"><b>_____ / ${fmt((e.itens || []).reduce((s, it) => s + C.pesoDe(it), 0))}</b>${valor ? ` <small>(vale ${fmt(valor)})</small>` : ''}</td></tr></tbody></table>
    ${(e.criticos || []).length ? `<div class="oc-quadro oc-quadro-crit"><b>ERRO CRÍTICO — marque se aconteceu</b><br>${e.criticos.map(c => `☐ ${esc(c)}`).join('<br>')}</div>` : ''}
    ${e.escalaGlobal !== false ? `<div class="oc-quadro oc-quadro-glob"><b>IMPRESSÃO GERAL — sem olhar a soma: está pronto para fazer isso num paciente?</b><div class="oc-lado">${GLOBAL.map(g => `<span>☐ ${g}</span>`).join('')}</div></div>` : ''}
    <p>Comentário: ________________________________________________________________</p>
    <p>Assinatura do avaliador(a): ____________________________________</p></div>`;
}
function folhaAluno(e) {
  return `<div class="oc-folha">
    <div class="oc-folha-cab"><img src="/img/medfatec-logo.png" alt=""><img src="/img/fatec-ivp-horizontal.png" alt=""></div>
    <h1>OSCE · ORIENTAÇÕES PARA O ESTUDANTE</h1><h2>${esc(e.tema)}${e.tempoMin ? ` · ${esc(String(e.tempoMin))} minutos` : ''}</h2>
    <p class="oc-grande"><b style="color:#0052b8">CENÁRIO</b></p>${linhas(e.cenario).map(l => `<p class="oc-grande">${esc(l)}</p>`).join('')}
    <p class="oc-grande" style="margin-top:6mm"><b style="color:#0052b8">TAREFAS</b></p><ul class="oc-grande">${(e.tarefas || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
}
function imprimir(html) {
  el('oc-impressao').innerHTML = html;
  document.body.classList.add('oc-imprimindo');
  const fim = () => { document.body.classList.remove('oc-imprimindo'); window.removeEventListener('afterprint', fim); };
  window.addEventListener('afterprint', fim);
  const imgs = [...el('oc-impressao').querySelectorAll('img')];
  Promise.all(imgs.map(i => (i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })))).then(() => setTimeout(() => window.print(), 100));
}

// ============================================================ eventos
function ligarEventos() {
  el('oc-semestre').addEventListener('change', () => { tela = { v: 'inicio' }; disciplinas = null; carregar(); });
  el('oc-trilha').addEventListener('click', (ev) => { const b = ev.target.closest('[data-ir]'); if (b) { tela = { v: 'inicio' }; carregar(); } });
  el('oc-word').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    try {
      const e = await lerWord(f);
      await carregarDisciplinas();
      const k = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      // só escolhe a disciplina sozinho quando o nome do Word aponta para UMA ("Habilidades" bate com várias)
      const ds = disciplinas.filter(x => e.disciplinaWord && k(x.nome).includes(k(e.disciplinaWord)));
      if (ds.length === 1) e.disciplina = ds[0].nome;
      await abrirEstacao(null, e);
      toast(`Importei ${e.itens.length} itens, o cenário e as tarefas. Confira, escolha a disciplina e o objetivo e salve.`);
    } catch (err) { toast(err.message, 'erro'); }
  });
  const conteudo = el('oc-conteudo');
  conteudo.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-a], [data-ir], [data-ra], [data-m], [data-g]');
    if (!b) return;
    try {
      if (b.dataset.ir && b.dataset.ir.startsWith('estacao:')) return abrirEstacao(b.dataset.ir.slice(8));
      if (b.dataset.ra) { tela.ra = b.dataset.ra; tela.rasc = null; return renderAvaliar(); }
      if (b.dataset.m !== undefined && tela.rasc) { tela.rasc.marcas[Number(b.dataset.i)] = Number(b.dataset.m); el('oc-marcar').innerHTML = formMarcar(aberta.estacoes.find(e => e.id === tela.estacaoId)); return; }
      if (b.dataset.g && tela.rasc) { tela.rasc.global = Number(b.dataset.g); tela.rasc.comentario = el('oc-coment') ? el('oc-coment').value : ''; el('oc-marcar').innerHTML = formMarcar(aberta.estacoes.find(e => e.id === tela.estacaoId)); return; }
      const a = b.dataset.a;
      if (a === 'nova-estacao') return abrirEstacao(null);
      if (a === 'importar') return el('oc-word').click();
      if (a === 'add-item') { lerForm(); tela.e.itens.push({ texto: '', parcial: '', peso: 1 }); el('oc-itens').insertAdjacentHTML('beforeend', linhaItem(tela.e.itens[tela.e.itens.length - 1], tela.e.itens.length - 1)); renderConf(); return; }
      if (a === 'tirar-item') { lerForm(); tela.e.itens.splice(Number(b.dataset.i), 1); el('oc-itens').innerHTML = tela.e.itens.map((it, i) => linhaItem(it, i)).join(''); renderConf(); return; }
      if (a === 'salvar-estacao') { b.disabled = true; try { await salvarEstacao(); } finally { b.disabled = false; } return; }
      if (a === 'apagar-estacao') { if (!confirm('Apagar esta estação? Não dá para desfazer.')) return; const r = await api(`${BASE}/estacoes/${encodeURIComponent(tela.id)}`, { method: 'DELETE' }); toast(r.message); tela = { v: 'inicio' }; return carregar(); }
      if (a === 'imprimir-estacao') { lerForm(); return imprimir(folhaAvaliador(tela.e, null, null) + folhaAluno(tela.e)); }
      if (a === 'nova-osce') return abrirOsceForm(null);
      if (a === 'editar-osce') return abrirOsceForm(b.dataset.id);
      if (a === 'tirar-est') { lerOsceForm(); tela.o.estacoes.splice(Number(b.dataset.i), 1); return renderOsceForm(); }
      if (a === 'tirar-aval') { lerOsceForm(); tela.o.estacoes[Number(b.dataset.i)].avaliadores.splice(Number(b.dataset.j), 1); return renderOsceForm(); }
      if (a === 'distribuir') { lerOsceForm(); const n = tela.o.estacoes.length; if (n) { const v = C.r2(tela.o.total / n); tela.o.estacoes.forEach((x, i) => { x.valor = i === n - 1 ? C.r2(tela.o.total - v * (n - 1)) : v; }); } return renderOsceForm(); }
      if (a === 'salvar-osce') {
        lerOsceForm();
        const r = tela.id ? await enviar(`${BASE}/osces/${encodeURIComponent(tela.id)}`, { ...tela.o, semestre: dados.semestre }, 'PUT') : await enviar(`${BASE}/osces`, { ...tela.o, semestre: dados.semestre });
        toast(r.message); tela = { v: 'inicio' }; return carregar();
      }
      if (a === 'apagar-osce') { if (!confirm('Apagar esta OSCE?')) return; const r = await api(`${BASE}/osces/${encodeURIComponent(tela.id)}`, { method: 'DELETE' }); toast(r.message); tela = { v: 'inicio' }; return carregar(); }
      if (a === 'avaliar') return abrirOsce(b.dataset.id, 'avaliar');
      if (a === 'resultado') return abrirOsce(b.dataset.id, 'resultado');
      if (a === 'salvar-nota' || a === 'ausente') { b.disabled = true; try { await salvarNota(a === 'ausente'); } finally { b.disabled = false; } return; }
      if (a === 'planilha') return baixarPlanilha();
      if (a === 'imprimir-osce') {
        const e = aberta.estacoes.find(x => x.id === tela.estacaoId);
        return imprimir(aberta.alunos.map(al => folhaAvaliador(e, al, cfgDe(e.id).valor)).join('') + folhaAluno(e));
      }
    } catch (err) { toast(err.message, 'erro'); }
  });
  conteudo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches('tr[data-ir]')) abrirEstacao(ev.target.dataset.ir.slice(8)); });
  conteudo.addEventListener('input', (ev) => {
    if (tela.v === 'estacao' && ev.target.closest('#oc-f-est')) { lerForm(); renderConf(); }
    if (ev.target.id === 'oc-busca') { tela.busca = ev.target.value; const pos = ev.target.selectionStart; renderAvaliar(); const i = el('oc-busca'); i.focus(); i.setSelectionRange(pos, pos); }
    if (ev.target.id === 'oc-coment' && tela.rasc) tela.rasc.comentario = ev.target.value;
  });
  conteudo.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (tela.v === 'estacao' && t.name === 'disciplina') { lerForm(); tela.e.objetivo = ''; return renderEstacao(); }
    if (tela.v === 'estacao' && t.dataset.k === 'semParcial') { const p = t.closest('.oc-item').querySelector('[data-k=parcial]'); p.disabled = t.checked; lerForm(); renderConf(); return; }
    if (t.id === 'oc-est-sel') { tela.estacaoId = t.value; tela.ra = ''; tela.rasc = null; return renderAvaliar(); }
    if (t.dataset.crit !== undefined && tela.rasc) { tela.rasc.criticos[Number(t.dataset.crit)] = t.checked; return; }
    if (t.id === 'oc-add-est' && t.value) { lerOsceForm(); tela.o.estacoes.push({ estacaoId: t.value, valor: 0, avaliadores: [] }); return renderOsceForm(); }
    if (t.dataset.k === 'add-aval' && t.value) { lerOsceForm(); const p = professores.find(x => x.uid === t.value); const x = tela.o.estacoes[Number(t.dataset.i)]; if (p && !x.avaliadores.some(a => a.uid === p.uid)) x.avaliadores.push({ uid: p.uid, nome: p.nome }); return renderOsceForm(); }
    if (tela.v === 'osce' && (t.name === 'total' || t.dataset.k === 'valor')) { lerOsceForm(); return renderOsceForm(); }
  });
}

async function initApp(user, role) {
  if (iniciado) return;
  iniciado = true;
  setupLayout(user, role, 'osce-med', () => { clearCachedAuth(); auth.signOut().then(() => { window.location.href = '../../auth/login.html'; }); });
  el('auth-guard').classList.add('hidden');
  el('app').classList.remove('hidden');
  ligarEventos();
  el('oc-semestre').innerHTML = ['2026.2', '2027.1'].map(s => `<option ${s === '2026.2' ? 'selected' : ''}>${s}</option>`).join('');
  try { await carregar(); } catch (e) { el('oc-conteudo').innerHTML = `<div class="oc-vazio">${esc(e.message)}</div>`; }
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
