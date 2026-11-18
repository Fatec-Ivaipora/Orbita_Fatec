// ================================================================
//  ÓRBITA — FINANCEIRO MEDICINA · 18/11/2026
//  A planilha de rematrícula da Medicina dentro do Órbita: uma "aba" por turma (T1, T2, T3, T4…), uma linha por
//  aluno com contrato mãe, % de desconto, mensal do acordo, saldos por coluna, saldo do semestre calculado
//  ((contrato − mensal) × 6) e total a receber. Reajuste por turma com prévia. Só Lisa e Fábio acessam.
//  Servidor: src/rotas/financeiro-medicina.js
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../../core/firebase-config.js";
import { setupLayout, getCachedAuth, setCachedAuth, clearCachedAuth } from "../../core/layout.js";
import { escapeHTML as esc } from "../../core/security.js";
import { MODULES } from "../../core/permissions.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname) || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.');
const API_BASE = LOCAL && !/^300[0-2]$/.test(location.port) ? `http://${location.hostname}:3000/api` : '/api';
const MODULO = 'financeiro-medicina';
const CAT_ROTULO = { '': 'Normal', pravaler: 'Pravaler', prouni50: 'ProUni 50%', prouni100: 'ProUni 100%', 'prouni50-pravaler': 'ProUni 50% + Pravaler',
  quitou: 'Quitou o semestre', 'vai-quitar': 'Vai quitar', inadimplente: 'Inadimplente', 'pendente-fabio': 'Pendente: acordar c/ Fábio' };
const CAT_COR = { pravaler: '#2e8b57', prouni50: '#7b5cd6', prouni100: '#c05ad1', 'prouni50-pravaler': '#f0a500', quitou: '#fa50ee', 'vai-quitar': '#2f80ed', inadimplente: '#e02424', 'pendente-fabio': '#f2994a' };

const $ = (id) => document.getElementById(id);
const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const n2 = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const lerNum = (s) => { const t = String(s || '').trim(); if (!t) return null; const v = Number(t.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '')); return Number.isFinite(v) ? v : null; };
const nomeBonito = (n) => String(n || '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E)\b/g, x => x.toLowerCase());

let currentUser = null, iniciado = false;
let resumo = null, turmaId = null, dados = null, podeEditar = false;
let filtroCat = 'todas', busca = '', mostrarHistorico = false;

async function api(caminho, opts = {}) {
  const token = await currentUser.getIdToken();
  const r = await fetch(`${API_BASE}/${MODULO}${caminho}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
  return j;
}
let tToast;
function toast(m, tipo = '') { const t = $('fm-toast'); t.textContent = m; t.className = `fm-toast ${tipo}`; clearTimeout(tToast); tToast = setTimeout(() => t.classList.add('hidden'), 3500); }
const fechar = () => $('fm-modal').classList.add('hidden');
function modal(titulo, html) { $('fm-modal-titulo').textContent = titulo; $('fm-modal-corpo').innerHTML = html; $('fm-modal').classList.remove('hidden'); }

// ---------------- carregar ----------------
async function carregarResumo() {
  $('fm-tela').innerHTML = '<p class="fm-vazio">Carregando...</p>';
  try {
    resumo = await api(`/resumo?semestre=${encodeURIComponent($('fm-semestre').value)}`);
    podeEditar = resumo.podeEditar;
    if (!resumo.turmas.some(t => t.id === turmaId)) turmaId = resumo.turmas[0] ? resumo.turmas[0].id : null;
    renderResumo();
    if (turmaId) await carregarTurma(); else $('fm-tela').innerHTML = `<div class="fm-card"><b>Nenhuma turma em ${esc($('fm-semestre').value)}.</b><span>Crie a turma (ex.: T4) no botão "+ Turma".</span></div>`;
  } catch (e) { $('fm-tela').innerHTML = `<div class="fm-card" style="color:var(--orb-crit)">${esc(e.message)}</div>`; }
}
async function carregarTurma() {
  dados = await api(`/turmas/${encodeURIComponent(turmaId)}`);
  renderTurmas(); renderTurma();
}

function renderResumo() {
  const g = resumo.geral || {};
  $('fm-resumo').innerHTML = `<div class="fm-cards">
    <div class="fm-card destaque"><b>${brl(g.totalReceber)}</b><span>Total a receber (${esc(resumo.semestre)})</span></div>
    <div class="fm-card"><b>${brl(g.saldosAnteriores)}</b><span>Saldos acumulados (colunas que somam)</span></div>
    <div class="fm-card"><b>${brl(g.saldoSemestre)}</b><span>Saldo do semestre (contrato − mensal × 6)</span></div>
    <div class="fm-card"><b>${brl(g.mensal)}</b><span>Mensalidades por mês (o que pagam)</span></div>
    <div class="fm-card"><b>${g.alunos || 0}</b><span>alunos · ${g.comSaldo || 0} com saldo</span></div>
  </div>`;
  renderTurmas();
}
function renderTurmas() {
  $('fm-turmas').innerHTML = (resumo.turmas || []).map(t => `<button type="button" class="fm-turma-btn ${t.id === turmaId ? 'ativo' : ''}" data-turma="${esc(t.id)}">${esc(t.turma)} · ${esc(t.periodo || '')}<small>${t.totais.alunos} alunos · ${brl(t.totais.totalReceber)}</small></button>`).join('')
    + (podeEditar ? '<button type="button" class="btn-secondary" data-nova-turma>+ Turma</button>' : '');
}

function linhaAluno(a, cols) {
  const c = a.calc || {};
  const cel = (campo, v, cls = '') => podeEditar
    ? `<input class="fm-cel ${cls}" inputmode="decimal" data-aluno="${esc(a.id)}" data-campo="${campo}" value="${esc(n2(v))}" aria-label="${campo} de ${esc(a.nome)}">`
    : `<span class="fm-calc">${esc(n2(v))}</span>`;
  return `<tr class="cat-${esc(a.categoria || 'normal')}" data-linha="${esc(a.id)}">
    <td class="fm-nome">${esc(nomeBonito(a.nome))}${podeEditar ? `<span class="fm-sub"><select class="fm-cat-sel" data-aluno="${esc(a.id)}" data-campo="categoria" aria-label="Categoria">${Object.entries(CAT_ROTULO).map(([k, r]) => `<option value="${k}" ${(a.categoria || '') === k ? 'selected' : ''}>${r}</option>`).join('')}</select></span>` : (a.categoria ? `<span class="fm-sub">${esc(CAT_ROTULO[a.categoria])}</span>` : '')}</td>
    <td>${cel('contratoMae', a.contratoMae)}</td>
    <td>${cel('descontoPct', a.descontoPct, 'pct')}</td>
    <td>${cel('mensal', a.mensal)}</td>
    <td class="fm-calc" data-calc="difMes">${c.difMes ? n2(c.difMes) : ''}</td>
    <td>${cel('quitou', a.quitou)}</td>
    ${cols.map(col => `<td>${cel(`saldo:${col.id}`, (a.saldos || {})[col.id])}</td>`).join('')}
    <td class="fm-calc" data-calc="saldoSemestre">${c.saldoSemestre ? n2(c.saldoSemestre) : ''}</td>
    <td class="fm-calc fm-total" data-calc="totalReceber">${c.totalReceber ? n2(c.totalReceber) : ''}</td>
    <td>${podeEditar ? `<input class="fm-cel fm-obs" data-aluno="${esc(a.id)}" data-campo="obs" value="${esc(a.obs || '')}" title="${esc(a.obs || '')}" aria-label="Observação">` : `<span class="fm-sub" title="${esc(a.obs || '')}">${esc((a.obs || '').slice(0, 60))}</span>`}</td>
    <td>${podeEditar ? `<button type="button" class="fm-btn-x" data-excluir="${esc(a.id)}" title="Tirar da turma" aria-label="Tirar ${esc(a.nome)} da turma">×</button>` : ''}</td>
  </tr>`;
}

function renderTurma() {
  const t = dados.turma;
  const cols = (t.colunas || []).filter(c => mostrarHistorico || c.entraNoTotal);
  const b = busca.toUpperCase();
  const alunos = dados.alunos.filter(a => (filtroCat === 'todas' || (a.categoria || '') === filtroCat) && (!b || a.nome.includes(b)));
  const tot = dados.totais;
  const ult = (t.historicoReajustes || []).slice(-1)[0];
  $('fm-tela').innerHTML = `
    <div class="fm-barra">
      <label>Turma<span class="fm-input" style="display:flex;align-items:center;font-weight:700">${esc(t.turma)}</span></label>
      <label>Período<input class="fm-input" style="width:70px" data-turma-campo="periodo" value="${esc(t.periodo || '')}" ${podeEditar ? '' : 'disabled'}></label>
      <label>Ingresso<input class="fm-input" style="width:90px" data-turma-campo="ingresso" value="${esc(t.ingresso || '')}" ${podeEditar ? '' : 'disabled'}></label>
      <label>Valor integral da mensalidade<input class="fm-input" style="width:140px;text-align:right" inputmode="decimal" data-turma-campo="integral" value="${esc(n2(t.integral))}" ${podeEditar ? '' : 'disabled'}></label>
      ${podeEditar ? `<div class="fm-direita">
        <button type="button" class="btn-secondary" data-acao="colunas">Colunas de saldo</button>
        <button type="button" class="btn-secondary" data-acao="matriculas">Trazer das Matrículas</button>
        <button type="button" class="btn-secondary" data-acao="novo-aluno">+ Aluno</button>
        <button type="button" class="btn-primary" data-acao="reajuste">Reajuste</button></div>` : ''}
    </div>
    ${ult ? `<p class="fm-sub" style="margin:-0.3rem 0 0.6rem">Último reajuste: ${new Date(ult.em).toLocaleDateString('pt-BR')} por ${esc(ult.por)} — parcela ${ult.pctParcela}%${ult.pctSaldo ? `, saldo ${ult.pctSaldo}% (${esc((ult.colunas || []).join(', '))})` : ''}.</p>` : ''}
    <div class="fm-filtros">
      <label>Categoria <select class="fm-input" data-filtro-cat><option value="todas">Todas (${dados.alunos.length})</option>${Object.entries(CAT_ROTULO).map(([k, r]) => { const q = dados.alunos.filter(a => (a.categoria || '') === k).length; return q ? `<option value="${k}" ${filtroCat === k ? 'selected' : ''}>${r} (${q})</option>` : ''; }).join('')}</select></label>
      <input class="fm-input" data-busca placeholder="Buscar aluno" value="${esc(busca)}" style="width:220px">
      ${(t.colunas || []).some(c => !c.entraNoTotal) ? `<label class="fm-check"><input type="checkbox" data-historico ${mostrarHistorico ? 'checked' : ''}> mostrar colunas de histórico (originais, não somam)</label>` : ''}
    </div>
    <div class="fm-tabela-wrap"><table class="fm-tabela">
      <thead><tr>
        <th class="fm-nome">Acadêmico(a)</th><th>Valor contrato mãe</th><th>% desc.</th><th>Mensal (paga)</th><th>Diferença/mês</th><th>Quitou o semestre</th>
        ${cols.map(c => `<th class="${c.entraNoTotal ? '' : 'fm-hist'}">${esc(c.rotulo)}${c.entraNoTotal ? '' : '<span class="fm-sub">histórico</span>'}</th>`).join('')}
        <th class="fm-tot">Saldo do semestre<span class="fm-sub">(contrato − mensal) × 6</span></th><th class="fm-tot">Total a receber</th><th>Observações</th><th></th>
      </tr></thead>
      <tbody>${alunos.map(a => linhaAluno(a, cols)).join('') || `<tr><td colspan="${10 + cols.length}" class="fm-vazio">Nenhum aluno neste filtro.</td></tr>`}</tbody>
      <tfoot><tr>
        <td class="fm-nome">Total da turma (${tot.alunos})</td><td class="fm-calc">${n2(tot.contratoMae)}</td><td></td><td class="fm-calc">${n2(tot.mensal)}</td><td></td><td></td>
        ${cols.map(c => `<td class="fm-calc">${n2(tot.porColuna[c.id] || 0)}</td>`).join('')}
        <td class="fm-calc">${n2(tot.saldoSemestre)}</td><td class="fm-calc fm-total">${n2(tot.totalReceber)}</td><td></td><td></td>
      </tr></tfoot>
    </table></div>
    <div class="fm-legenda">${Object.entries(CAT_COR).map(([k, c]) => `<span><i style="background:${c}"></i>${CAT_ROTULO[k]}</span>`).join('')}</div>
    <p class="fm-sub" style="margin-top:0.5rem">Total a receber = colunas de saldo que somam + saldo do semestre. Os valores são para lançar no Edubox: este módulo não grava nada lá.</p>`;
}

// ---------------- edição ----------------
async function salvarCelula(el) {
  const id = el.dataset.aluno, campo = el.dataset.campo;
  const a = dados.alunos.find(x => x.id === id);
  let corpo;
  if (campo.startsWith('saldo:')) corpo = { saldos: { [campo.slice(6)]: el.value.trim() === '' ? '' : lerNum(el.value) } };
  else if (campo === 'obs' || campo === 'categoria') corpo = { [campo]: el.value };
  else corpo = { [campo]: el.value.trim() === '' ? '' : lerNum(el.value) };
  el.classList.add('salvando');
  try {
    const novo = await api(`/alunos/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(corpo) });
    Object.assign(a, novo);
    el.classList.remove('salvando'); el.classList.add('salvo'); setTimeout(() => el.classList.remove('salvo'), 900);
    if (campo !== 'obs' && campo !== 'categoria' && el.value.trim()) el.value = n2(lerNum(el.value));
    const tr = el.closest('tr');
    ['difMes', 'saldoSemestre', 'totalReceber'].forEach(k => { const td = tr.querySelector(`[data-calc="${k}"]`); if (td) td.textContent = a.calc[k] ? n2(a.calc[k]) : ''; });
    if (campo === 'categoria') tr.className = `cat-${a.categoria || 'normal'}`;
    atualizarTotais();
  } catch (e) { el.classList.remove('salvando'); toast(e.message, 'erro'); }
}
let tTotais;
function atualizarTotais() { clearTimeout(tTotais); tTotais = setTimeout(async () => { const sc = $('fm-tela').querySelector('.fm-tabela-wrap')?.scrollTop; resumo = await api(`/resumo?semestre=${encodeURIComponent($('fm-semestre').value)}`); renderResumo(); dados = await api(`/turmas/${encodeURIComponent(turmaId)}`); renderTurma(); const w = $('fm-tela').querySelector('.fm-tabela-wrap'); if (w && sc) w.scrollTop = sc; }, 1500); }

// ---------------- ações ----------------
function abrirReajuste() {
  const t = dados.turma;
  modal(`Reajuste · ${t.turma} ${t.semestre}`, `
    <div class="fm-form">
      <label>% na parcela (integral, contrato mãe e mensal)<input class="fm-input" id="rj-p" inputmode="decimal" placeholder="ex.: 6"></label>
      <label>% nos saldos escolhidos<input class="fm-input" id="rj-s" inputmode="decimal" placeholder="ex.: 10"></label>
      <label class="fm-largo" style="flex-direction:row;align-items:center;gap:.4rem;font-weight:500"><input type="checkbox" id="rj-mensal" checked> reajustar também o mensal que o aluno paga (acordo)</label>
      <label class="fm-largo" style="flex-direction:row;align-items:center;gap:.4rem;font-weight:500"><input type="checkbox" id="rj-integral"> reajustar também o valor integral da turma (hoje ${brl(t.integral)}) — deixe desmarcado se ele já está reajustado</label>
      <div class="fm-largo"><b style="font-size:.8rem">Colunas de saldo que recebem o %:</b><br>${(t.colunas || []).map(c => `<label style="display:inline-flex;align-items:center;gap:.3rem;margin:.3rem 1rem 0 0;font-weight:500"><input type="checkbox" class="rj-col" value="${esc(c.id)}" ${c.entraNoTotal ? 'checked' : ''}> ${esc(c.rotulo)}</label>`).join('') || '<span class="fm-sub">a turma não tem colunas de saldo</span>'}</div>
    </div>
    <div class="fm-acoes"><button type="button" class="btn-primary" data-rj="previa">Ver prévia</button></div>
    <div id="rj-res"></div>`);
}
async function reajuste(aplicar) {
  const corpo = { pctParcela: lerNum($('rj-p').value) || 0, pctSaldo: lerNum($('rj-s').value) || 0, ajustarMensal: $('rj-mensal').checked, ajustarIntegral: $('rj-integral').checked, colunasSaldo: [...document.querySelectorAll('.rj-col:checked')].map(i => i.value), aplicar };
  try {
    const r = await api(`/turmas/${encodeURIComponent(turmaId)}/reajuste`, { method: 'POST', body: JSON.stringify(corpo) });
    if (aplicar) { fechar(); toast(r.message); return carregarResumo(); }
    $('rj-res').innerHTML = `
      <div class="fm-aviso">Prévia — nada foi gravado. Integral: ${brl(r.resumo.integral[0])} → <b>${brl(r.resumo.integral[1])}</b> · Total a receber da turma: ${brl(r.resumo.totalReceber[0])} → <b>${brl(r.resumo.totalReceber[1])}</b></div>
      <div class="fm-lista"><table><thead><tr><th>Aluno</th><th>Contrato mãe</th><th>Mensal</th><th>Total a receber</th></tr></thead><tbody>
      ${r.previa.map(p => `<tr><td>${esc(nomeBonito(p.nome))}</td><td class="n">${n2(p.contratoMae[0])} → <b>${n2(p.contratoMae[1])}</b></td><td class="n">${n2(p.mensal[0])} → <b>${n2(p.mensal[1])}</b></td><td class="n">${n2(p.totalReceber[0])} → <b>${n2(p.totalReceber[1])}</b></td></tr>`).join('')}
      </tbody></table></div>
      <div class="fm-acoes"><button type="button" class="btn-secondary" data-fechar>Cancelar</button><button type="button" class="btn-primary" data-rj="aplicar">Confirmar reajuste</button></div>`;
  } catch (e) { toast(e.message, 'erro'); }
}
async function trazerMatriculas(aplicar) {
  try {
    const r = await api(`/turmas/${encodeURIComponent(turmaId)}/trazer-matriculas`, { method: 'POST', body: JSON.stringify({ aplicar }) });
    if (aplicar) { fechar(); toast(r.message); return carregarResumo(); }
    modal(`Trazer das Matrículas · ${dados.turma.turma} (${dados.turma.periodo})`, `
      <p class="fm-sub" style="font-size:.84rem;margin:0 0 .6rem">Matrículas da Medicina ${esc(dados.turma.semestre)} no ${esc(dados.turma.periodo)} período (sem quem saiu): ${r.matriculas}.</p>
      <b style="font-size:.85rem">Estão nas Matrículas e não estão na turma (${r.faltam.length}):</b>
      <div class="fm-lista" style="margin:.4rem 0 .8rem"><table><tbody>${r.faltam.map(f => `<tr><td>${esc(nomeBonito(f.nome))}</td><td class="fm-sub">${esc(f.situacao || '')}</td></tr>`).join('') || '<tr><td class="fm-vazio">Ninguém faltando.</td></tr>'}</tbody></table></div>
      <b style="font-size:.85rem">Estão na turma e não nas Matrículas deste período (${r.soNaTurma.length}):</b>
      <div class="fm-lista" style="margin:.4rem 0"><table><tbody>${r.soNaTurma.map(nm => `<tr><td>${esc(nomeBonito(nm))}</td></tr>`).join('') || '<tr><td class="fm-vazio">Nenhum.</td></tr>'}</tbody></table></div>
      <p class="fm-sub">Quem falta entra só com o nome; os valores você preenche. Ninguém é tirado da turma automaticamente.</p>
      <div class="fm-acoes"><button type="button" class="btn-secondary" data-fechar>Fechar</button>${r.faltam.length ? `<button type="button" class="btn-primary" data-mat-aplicar>Incluir ${r.faltam.length} aluno(s)</button>` : ''}</div>`);
  } catch (e) { toast(e.message, 'erro'); }
}
function abrirColunas() {
  const t = dados.turma;
  modal(`Colunas de saldo · ${t.turma}`, `
    <p class="fm-sub" style="font-size:.84rem;margin:0 0 .6rem">"Soma no total" = o saldo ainda é devido e entra no "a receber". Sem marcar = histórico (valor original, antes do reajuste).</p>
    <div id="col-lista">${(t.colunas || []).map(c => linhaCol(c)).join('')}</div>
    <div class="fm-acoes" style="justify-content:space-between"><button type="button" class="btn-secondary" data-col-add>+ Coluna</button><button type="button" class="btn-primary" data-col-salvar>Salvar colunas</button></div>`);
}
const linhaCol = (c) => `<div class="fm-form col-linha" data-col-id="${esc(c.id || '')}" style="grid-template-columns:1fr auto auto;align-items:end;margin-bottom:.4rem">
  <label>Rótulo<input class="fm-input col-rot" value="${esc(c.rotulo || '')}" placeholder="ex.: Saldo devedor 6º sem. 2027.1"></label>
  <label style="flex-direction:row;align-items:center;gap:.3rem;font-weight:500"><input type="checkbox" class="col-tot" ${c.entraNoTotal ? 'checked' : ''}> soma no total</label>
  <button type="button" class="fm-btn-x" data-col-del aria-label="Remover coluna">×</button></div>`;
function abrirNovaTurma() {
  const ant = (resumo.turmas || []);
  modal('Nova turma', `<div class="fm-form">
    <label>Semestre<input class="fm-input" id="nt-sem" value="${esc($('fm-semestre').value)}"></label>
    <label>Turma<input class="fm-input" id="nt-turma" placeholder="ex.: T4"></label>
    <label>Período<input class="fm-input" id="nt-per" placeholder="ex.: 1º"></label>
    <label>Ingresso<input class="fm-input" id="nt-ing" placeholder="ex.: 2027/1"></label>
    <label>Valor integral<input class="fm-input" id="nt-int" inputmode="decimal"></label>
    <label class="fm-largo">Copiar colunas de saldo de<select class="fm-input" id="nt-copiar"><option value="">— nenhuma —</option>${ant.map(t => `<option value="${esc(t.id)}">${esc(t.turma)} ${esc(t.semestre)}</option>`).join('')}</select></label>
    <label class="fm-largo" style="flex-direction:row;align-items:center;gap:.4rem;font-weight:500"><input type="checkbox" id="nt-alunos"> copiar também os alunos (com valores e saldos) — para abrir o semestre seguinte da mesma turma</label>
  </div><div class="fm-acoes"><button type="button" class="btn-primary" data-nt-criar>Criar turma</button></div>`);
}

// ---------------- eventos ----------------
function ligar() {
  $('fm-semestre').addEventListener('change', carregarResumo);
  $('fm-turmas').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-turma]'); if (b) { turmaId = b.dataset.turma; renderTurmas(); return carregarTurma(); }
    if (e.target.closest('[data-nova-turma]')) abrirNovaTurma();
  });
  $('fm-tela').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.aluno) return salvarCelula(t);
    if (t.dataset.filtroCat !== undefined) { filtroCat = t.value; return renderTurma(); }
    if (t.dataset.historico !== undefined) { mostrarHistorico = t.checked; return renderTurma(); }
    if (t.dataset.turmaCampo) {
      const campo = t.dataset.turmaCampo;
      try { await api(`/turmas/${encodeURIComponent(turmaId)}`, { method: 'PUT', body: JSON.stringify({ [campo]: campo === 'integral' ? lerNum(t.value) : t.value }) }); dados.turma[campo] = campo === 'integral' ? lerNum(t.value) : t.value; toast('Turma salva.'); carregarResumo(); }
      catch (err) { toast(err.message, 'erro'); }
    }
  });
  let tb; $('fm-tela').addEventListener('input', (e) => { if (e.target.dataset.busca === undefined) return; clearTimeout(tb); tb = setTimeout(() => { busca = e.target.value; renderTurma(); const i = $('fm-tela').querySelector('[data-busca]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); });
  $('fm-tela').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('fm-cel')) e.target.blur(); });
  $('fm-tela').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.acao === 'reajuste') return abrirReajuste();
    if (b.dataset.acao === 'matriculas') return trazerMatriculas(false);
    if (b.dataset.acao === 'colunas') return abrirColunas();
    if (b.dataset.acao === 'novo-aluno') return modal('Novo aluno', `<div class="fm-form"><label class="fm-largo">Nome<input class="fm-input" id="na-nome"></label><label>Contrato mãe<input class="fm-input" id="na-cm" inputmode="decimal"></label><label>% desconto<input class="fm-input" id="na-desc" inputmode="decimal"></label><label>Mensal (paga)<input class="fm-input" id="na-mensal" inputmode="decimal"></label></div><div class="fm-acoes"><button type="button" class="btn-primary" data-na-criar>Incluir</button></div>`);
    if (b.dataset.excluir) {
      const a = dados.alunos.find(x => x.id === b.dataset.excluir);
      if (!confirm(`Tirar ${a ? nomeBonito(a.nome) : 'o aluno'} desta turma? Os valores e saldos dele nesta turma serão apagados.`)) return;
      try { await api(`/alunos/${encodeURIComponent(b.dataset.excluir)}`, { method: 'DELETE' }); toast('Aluno retirado.'); carregarResumo(); } catch (err) { toast(err.message, 'erro'); }
    }
  });
  $('fm-modal').addEventListener('click', async (e) => {
    if (e.target === $('fm-modal') || e.target.closest('#fm-modal-fechar') || e.target.closest('[data-fechar]')) return fechar();
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.rj) return reajuste(b.dataset.rj === 'aplicar');
      if (b.dataset.matAplicar !== undefined) return trazerMatriculas(true);
      if (b.dataset.colAdd !== undefined) return $('col-lista').insertAdjacentHTML('beforeend', linhaCol({ id: '', rotulo: '', entraNoTotal: true }));
      if (b.dataset.colDel !== undefined) { if (confirm('Remover a coluna? Os valores dela continuam guardados nos alunos, mas deixam de aparecer e de somar.')) b.closest('.col-linha').remove(); return; }
      if (b.dataset.colSalvar !== undefined) {
        const colunas = [...document.querySelectorAll('.col-linha')].map((l, i) => ({ id: l.dataset.colId || `c${Date.now()}${i}`, rotulo: l.querySelector('.col-rot').value, entraNoTotal: l.querySelector('.col-tot').checked }));
        await api(`/turmas/${encodeURIComponent(turmaId)}`, { method: 'PUT', body: JSON.stringify({ colunas }) }); fechar(); toast('Colunas salvas.'); return carregarResumo();
      }
      if (b.dataset.naCriar !== undefined) {
        await api('/alunos', { method: 'POST', body: JSON.stringify({ turmaId, nome: $('na-nome').value, contratoMae: lerNum($('na-cm').value), descontoPct: lerNum($('na-desc').value), mensal: lerNum($('na-mensal').value) }) }); fechar(); toast('Aluno incluído.'); return carregarResumo();
      }
      if (b.dataset.ntCriar !== undefined) {
        const r = await api('/turmas', { method: 'POST', body: JSON.stringify({ semestre: $('nt-sem').value.trim(), turma: $('nt-turma').value.trim(), periodo: $('nt-per').value.trim(), ingresso: $('nt-ing').value.trim(), integral: lerNum($('nt-int').value), copiarDe: $('nt-copiar').value || null, copiarAlunos: $('nt-alunos').checked }) });
        fechar(); toast(`Turma ${r.turma} criada${r.copiados ? ` com ${r.copiados} aluno(s)` : ''}.`); turmaId = r.id;
        const sems = await api('/semestres'); $('fm-semestre').innerHTML = sems.map(s => `<option ${s === r.semestre ? 'selected' : ''}>${esc(s)}</option>`).join('');
        return carregarResumo();
      }
    } catch (err) { toast(err.message, 'erro'); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });
}

async function iniciar(user, role) {
  iniciado = true;
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); location.href = '../../auth/login.html'; });
  $('auth-guard').classList.add('hidden'); $('app').classList.remove('hidden');
  ligar();
  let sems = ['2027.1'];
  try { sems = await api('/semestres'); } catch (e) { toast(e.message, 'erro'); }
  $('fm-semestre').innerHTML = sems.map(s => `<option>${esc(s)}</option>`).join('');
  await carregarResumo();
}

const cached = getCachedAuth();
onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); location.href = '../../auth/login.html'; return; }
  currentUser = user;
  // acesso por usuário (só Lisa e Fábio) — o servidor também barra
  if (!(MODULES[MODULO].somenteUsuarios || []).includes(user.uid)) { location.href = '../../meu-espaco/index.html'; return; }
  let role = cached ? cached.role : 'visitante';
  try { const r = await fetch(`${API_BASE}/usuarios/me`, { headers: { Authorization: `Bearer ${await user.getIdToken()}` } }); const u = await r.json(); role = u.role || role; } catch (e) { /* mantém o do cache */ }
  setCachedAuth(user, role, await user.getIdToken());
  if (!iniciado) iniciar(user, role);
});
