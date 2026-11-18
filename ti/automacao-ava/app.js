// ================================================================
//  ÓRBITA — AUTOMAÇÃO AVA (TI) · 26/10/2026
//  Disciplinas EAD do semestre (Edubox) e a CRIAÇÃO das que são novas:
//  etapas (treinamento, seleção, validação do coordenador, criação no AVA,
//  validação da TI), entrega das avaliações ao coordenador do curso e ao
//  coordenador EAD, professor responsável, titulação e valor a pagar.
//  Relatório no padrão FATEC (PDF). Servidor: src/rotas/automacao-ava.js
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
  ? `http://${location.hostname}:3000/api` : '/api';
const MODULO = 'automacao-ava';
const NIVEL_PADRAO = { adm_l2: 3, ti: 3, coordenador: 3, ead: 3 };

const ORIGEM = {
  criar: { rotulo: 'Criar do zero', curto: 'Criar' },
  replicar: { rotulo: 'Replicar do semestre anterior', curto: 'Replicar' },
  'replicar-outro': { rotulo: 'Replicar de outro curso', curto: 'Replicar de outro curso' },
  'ja-existe': { rotulo: 'Já pronta no AVA', curto: 'Já pronta' }
};
const PAPEL_ROTULO = { adm: 'ADM', ti: 'TI', coordenador: 'Coordenador do curso', ead: 'Coordenação EAD', leitura: 'Consulta' };

const $ = (id) => document.getElementById(id);
const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const quando = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

let currentUser = null, appInitialized = false, initializedRole = null;
let dados = null;            // { semestre, papel, titulacoes, etapas, avaliacoes, disciplinas }
let aba = 'criacao';
let filtroOrigem = 'criar';
let filtroCurso = '';
let professores = null;
let conduit = null;          // { semestre, linhas } da aba Arquivos do Conduit

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}
let toastTimer;
function toast(msg, tipo = '') {
  const t = $('av-toast'); t.textContent = msg; t.className = `av-toast ${tipo}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}
const tela = () => $('av-tela');

// ---------------- andamento de uma disciplina ----------------
function andamento(d) {
  const etapas = dados.etapas.map(e => !!(d.etapas || {})[e.id]);
  const total = dados.avaliacoes.length * 2;
  let entregues = 0;
  dados.avaliacoes.forEach(a => { const x = (d.avaliacoes || {})[a.id] || {}; if (x.coordenador) entregues++; if (x.ead) entregues++; });
  const feitas = etapas.filter(Boolean).length;
  let situacao;
  if (feitas === etapas.length && entregues === total) situacao = { id: 'concluida', rotulo: 'Concluída' };
  else if (feitas === etapas.length) situacao = { id: 'avaliacoes', rotulo: 'Aguardando avaliações' };
  else if (feitas || d.professor) situacao = { id: 'andamento', rotulo: 'Em criação' };
  else situacao = { id: 'nova', rotulo: 'Não iniciada' };
  return { etapas, feitas, entregues, total, situacao, pago: !!(d.pagamento && d.pagamento.pago) };
}

// ---------------- carregamento ----------------
async function carregar() {
  const sem = $('av-semestre').value;
  if (!sem) { tela().innerHTML = '<p class="av-vazio">Nenhum semestre disponível no Edubox.</p>'; return; }
  tela().innerHTML = '<p class="av-vazio">Buscando as disciplinas EAD no Edubox...</p>';
  try {
    dados = await apiFetch(`/${MODULO}?semestre=${encodeURIComponent(sem)}`);
    $('av-subtitulo').textContent = `Disciplinas EAD de ${sem} e criação das novas · você está como ${PAPEL_ROTULO[dados.papel]}`;
    render();
  } catch (e) { tela().innerHTML = `<div class="av-card av-erro">${esc(e.message)}</div>`; }
}

function render() {
  document.querySelectorAll('#av-abas .aba').forEach(b => { const on = b.dataset.aba === aba; b.classList.toggle('ativa', on); b.setAttribute('aria-selected', on); });
  if (!dados) return;
  if (aba === 'relatorio') return renderRelatorio();
  if (aba === 'conduit') return renderConduit();
  if (aba === 'unidades') return renderUnidades();
  renderCriacao();
}

// ================================================================
//  ABA: DISCIPLINAS EAD / CRIAÇÃO
// ================================================================
function renderCriacao() {
  const cursos = [...new Map(dados.disciplinas.map(d => [d.cursoId, d.cursoNome])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  const doCurso = dados.disciplinas.filter(d => !filtroCurso || d.cursoId === filtroCurso);
  const conta = (o) => doCurso.filter(d => d.origem === o).length;
  const lista = doCurso.filter(d => filtroOrigem === 'todas' || d.origem === filtroOrigem);
  const criar = doCurso.filter(d => d.origem === 'criar');
  const anda = criar.map(andamento);
  const totalPagar = criar.reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const pago = criar.filter(d => d.pagamento && d.pagamento.pago).reduce((s, d) => s + (Number(d.valor) || 0), 0);

  tela().innerHTML = `
    <section class="av-resumo">
      <div class="av-num"><b>${doCurso.length}</b><span>disciplinas EAD</span></div>
      <div class="av-num"><b>${criar.length}</b><span>para criar do zero</span></div>
      <div class="av-num"><b>${anda.filter(a => a.situacao.id === 'concluida').length}</b><span>criações concluídas</span></div>
      <div class="av-num"><b>${brl(totalPagar)}</b><span>a pagar aos professores</span></div>
      <div class="av-num"><b>${brl(pago)}</b><span>já pago</span></div>
    </section>
    <div class="av-filtros">
      <label class="av-filtro-curso">Curso
        <select class="select-filter" data-av-curso><option value="">Todos os cursos</option>${cursos.map(([id, nome]) => `<option value="${esc(id)}" ${filtroCurso === id ? 'selected' : ''}>${esc(nomeCurso(nome))}</option>`).join('')}</select>
      </label>
      <div class="av-pilulas">
        ${['criar', 'replicar', 'replicar-outro', 'ja-existe'].map(o => `<button type="button" class="av-pilula${filtroOrigem === o ? ' ativo' : ''}" data-av-origem="${o}">${ORIGEM[o].rotulo} <span>${conta(o)}</span></button>`).join('')}
        <button type="button" class="av-pilula${filtroOrigem === 'todas' ? ' ativo' : ''}" data-av-origem="todas">Todas <span>${doCurso.length}</span></button>
      </div>
    </div>
    <section class="av-card av-card-tabela">
      ${lista.length ? `<div class="av-tabela-wrap"><table class="av-tabela">
        <thead><tr><th>Disciplina</th><th>Situação no AVA</th>${filtroOrigem === 'criar' || filtroOrigem === 'todas' ? '<th>Professor que cria</th><th>Andamento</th>' : '<th>Copiar de</th>'}</tr></thead>
        <tbody>${lista.map(linha).join('')}</tbody></table></div>`
      : `<p class="av-vazio">${dados.disciplinas.length ? 'Nenhuma disciplina neste filtro.' : 'Nenhuma disciplina EAD lançada no Edubox para este semestre.'}</p>`}
    </section>
    <p class="av-legenda">EAD = disciplina do tipo "A Distância" no Edubox, lançada nas turmas do semestre. Síncronas e as com carga EAD zerada ficam de fora. A situação no AVA é sugerida pelo histórico do Edubox (8 semestres) e pelas salas que já existem no AVA (de semestre anterior, só as com "EAD" no nome); a TI confirma.</p>`;
}

const nomeCurso = (n) => String(n || '').replace(/^(BACHARELADO|LICENCIATURA|SUPERIOR DE TECNOLOGIA) EM /i, '');

// Sala com o mesmo nome em OUTRO curso (fora dos que compartilham conteúdo): não é o mesmo conteúdo,
// então a sugestão é criar; o aviso fica pra TI decidir se foi combinado copiar.
function avisoParecida(d) {
  const p = d.origem === 'criar' && d.sugestao && d.sugestao.parecida;
  return p ? `<span class="av-sub av-parecida" title="Mesmo nome em outro curso não é o mesmo conteúdo. Só copie se foi combinado (escolha na ficha).">Há sala com o mesmo nome em ${esc(nomeCurso(p.cursoNome))} (${esc(p.semestre)}) — outro curso, só copiar se combinado</span>` : '';
}

function linha(d) {
  const per = d.periodos && d.periodos.length ? `${d.periodos.join('º/')}º per.` : '';
  const meta = [nomeCurso(d.cursoNome), per, d.chEad ? `${d.chEad}h EAD` : ''].filter(Boolean).join(' · ');
  const tags = `${d.edubox === false ? '<span class="av-tag av-tag-alerta" title="Não está mais lançada no Edubox">fora do Edubox</span>' : ''}${d.sugestao && d.sugestao.comum ? '<span class="av-tag" title="Disciplina comum a todos os cursos: copia a sala mais recente de qualquer curso">disciplina comum</span>' : ''}`;
  const origem = `<span class="av-origem av-origem-${d.origem}">${ORIGEM[d.origem].curto}</span>`;
  const de = d.sugestao && d.sugestao.de ? `${esc(d.sugestao.de.nome)}<span class="av-sub">${esc(nomeCurso(d.sugestao.de.cursoNome))} · ${esc(d.sugestao.de.semestre)}${d.sugestao.de.ava ? ' · sala no AVA' : ''}</span>` : '<span class="av-sub">—</span>';
  let resto;
  if (d.origem === 'criar') {
    const a = andamento(d);
    resto = `<td>${d.professor ? `${esc(d.professor)}<span class="av-sub">${d.titulacao ? `${esc(dados.titulacoes[d.titulacao].rotulo)} · ${brl(d.valor)}` : 'titulação não definida'}${a.pago ? ' · <b class="av-ok">pago</b>' : ''}</span>` : '<span class="av-sub av-alerta">definir professor</span>'}</td>
      <td><div class="av-passos">${dados.etapas.map((e, i) => `<span class="av-passo${a.etapas[i] ? ' feito' : ''}" title="${esc(e.rotulo)}">${i + 1}</span>`).join('')}</div>
        <span class="av-sub">avaliações ${a.entregues}/${a.total} · <span class="av-sit av-sit-${a.situacao.id}">${a.situacao.rotulo}</span></span></td>`;
  } else if (d.sugestao && d.sugestao.mesmaSala) resto = `<td colspan="2" class="av-sub">mesma sala do ${esc((d.sugestao.de.periodos || []).join('º/'))}º período${d.sugestao.de.cursoId !== d.cursoId ? ` de ${esc(nomeCurso(d.sugestao.de.cursoNome))}` : ''} — criada uma vez só, as turmas usam a mesma${d.sugestao.juntas === null ? ' <b class="av-alerta">(sem horário do curso: confirmar se estudam juntos)</b>' : d.sugestao.juntasConfirmado === false ? ' <i>(estudam juntos pelo horário do semestre anterior; confirmar quando sair o novo)</i>' : ''}</td>`;
  else if (filtroOrigem === 'todas') resto = `<td colspan="2" class="av-sub">${d.sugestao && d.sugestao.de ? `copiar de ${esc(d.sugestao.de.nome)} (${esc(nomeCurso(d.sugestao.de.cursoNome))} · ${esc(d.sugestao.de.semestre)}${d.sugestao.de.ava ? ' · sala no AVA' : ''})` : '—'}</td>`;
  else resto = `<td>${de}</td>`;
  return `<tr class="av-linha" data-av-abrir="${esc(d.id)}" tabindex="0">
    <td><span class="av-titulo">${esc(d.nome)}</span>${tags}<span class="av-sub">${esc(meta)}</span>${avisoParecida(d)}</td>
    <td>${origem}</td>${resto}</tr>`;
}

// ---------------- detalhe / ficha da disciplina ----------------
function abrirFicha(id) {
  const d = dados.disciplinas.find(x => x.id === id);
  if (!d) return;
  const p = dados.papel;
  const ehTi = p === 'ti' || p === 'adm';
  const pode = (quem) => p === 'adm' || (quem === 'ti' && p === 'ti') || (quem === p);
  const a = andamento(d);
  const marcaTxt = (m) => m ? `<span class="av-quem">${esc(m.por)} · ${quando(m.em)}</span>` : '';
  const caixa = (marcado, attrs, habilitada) => `<button type="button" class="av-check${marcado ? ' on' : ''}" ${attrs} aria-pressed="${marcado}" ${habilitada ? '' : 'disabled'}></button>`;
  const QUEM = { ti: 'TI', coordenador: 'Coordenador do curso', ead: 'Coordenação EAD' };

  $('av-modal-titulo').textContent = d.nome;
  $('av-modal-corpo').innerHTML = `
    <p class="av-sub av-ficha-meta">${esc(nomeCurso(d.cursoNome))} · ${d.periodos.join('º/')}º período ${d.chEad ? ` · ${d.chEad}h EAD` : ''} · turmas ${esc(d.turmas.join(', '))} · ${esc(d.semestre)}</p>
    <div class="av-ficha-grade">
      <section>
        <h3>Situação no AVA</h3>
        <select id="av-f-origem" class="select-filter" ${ehTi ? '' : 'disabled'}>${Object.entries(ORIGEM).map(([k, o]) => `<option value="${k}" ${d.origem === k ? 'selected' : ''}>${o.rotulo}</option>`).join('')}</select>
        ${d.sugestao && d.sugestao.de ? `<p class="av-sub">Sugestão do Órbita: ${esc(ORIGEM[d.sugestao.origem].rotulo.toLowerCase())} — ${esc(d.sugestao.de.nome)} (${esc(nomeCurso(d.sugestao.de.cursoNome))} · ${esc(d.sugestao.de.semestre)}${d.sugestao.de.ava ? ' · sala que já existe no AVA' : ''})</p>` : '<p class="av-sub">Sugestão do Órbita: não achei no Edubox nem no AVA — criar do zero.</p>'}
      </section>
      ${d.origem === 'criar' ? `
      <section>
        <h3>Professor que cria</h3>
        <input type="text" id="av-f-prof" list="av-professores" maxlength="120" value="${esc(d.professor || '')}" placeholder="Nome do professor" ${ehTi ? '' : 'disabled'}>
        <p class="av-sub" id="av-f-tit-edubox"></p>
        <div class="av-linha-campos">
          <select id="av-f-tit" class="select-filter" ${ehTi ? '' : 'disabled'}><option value="">Titulação...</option>${Object.entries(dados.titulacoes).map(([k, t]) => `<option value="${k}" ${d.titulacao === k ? 'selected' : ''}>${t.rotulo} — ${brl(t.valor)}</option>`).join('')}</select>
          <b class="av-valor" id="av-f-valor">${brl(d.valor)}</b>
        </div>
        <label class="av-check-linha"><input type="checkbox" id="av-f-pago" ${a.pago ? 'checked' : ''} ${ehTi ? '' : 'disabled'}> Pago ao professor ${a.pago ? `<span class="av-quem">${esc(d.pagamento.por)} · ${quando(d.pagamento.em)}</span>` : ''}</label>
      </section>` : ''}
    </div>
    ${d.origem === 'criar' ? `
    <section>
      <h3>Etapas da criação</h3>
      <ol class="av-etapas">${dados.etapas.map(e => { const m = (d.etapas || {})[e.id]; return `
        <li class="${m ? 'feito' : ''}">${caixa(!!m, `data-av-etapa="${e.id}"`, pode(e.quem))}
          <div><span>${esc(e.rotulo)}</span><span class="av-sub">marca: ${QUEM[e.quem]}</span>${marcaTxt(m)}</div></li>`; }).join('')}</ol>
    </section>
    <section>
      <h3>Avaliações entregues <span class="av-sub">(5 questões discursivas em cada; recebidas pelo coordenador do curso e pelo coordenador EAD)</span></h3>
      <table class="av-tabela av-tab-aval"><thead><tr><th>Avaliação</th><th>Coordenador do curso</th><th>Coordenação EAD (Carlos)</th></tr></thead>
        <tbody>${dados.avaliacoes.map(v => { const x = (d.avaliacoes || {})[v.id] || {}; return `<tr><td>${esc(v.rotulo)}</td>
          <td>${caixa(!!x.coordenador, `data-av-aval="${v.id}" data-av-destino="coordenador"`, pode('coordenador'))}${marcaTxt(x.coordenador)}</td>
          <td>${caixa(!!x.ead, `data-av-aval="${v.id}" data-av-destino="ead"`, pode('ead'))}${marcaTxt(x.ead)}</td></tr>`; }).join('')}</tbody></table>
    </section>` : ''}
    <section>
      <h3>Observações</h3>
      <textarea id="av-f-obs" rows="2" maxlength="1000" ${ehTi ? '' : 'disabled'}>${esc(d.obs || '')}</textarea>
    </section>
    ${ehTi ? '<div class="av-modal-acoes"><button type="button" class="btn-primary" data-av-salvar>Salvar</button></div>' : ''}`;
  $('av-modal').dataset.id = id;
  $('av-modal').classList.remove('hidden');
  const tit = $('av-f-tit');
  if (tit) tit.addEventListener('change', () => { $('av-f-valor').textContent = brl(tit.value ? dados.titulacoes[tit.value].valor : 0); });
  const prof = $('av-f-prof');
  if (prof) prof.addEventListener('input', () => titulacaoDoEdubox(true));
  carregarProfessores().then(() => titulacaoDoEdubox(false));
  const ori = $('av-f-origem');
  if (ori && ehTi) ori.addEventListener('change', () => salvarFicha(true));
}

// Titulação que o Edubox tem do professor escolhido: mostra embaixo do nome e, ao trocar o
// professor (ou se a ficha ainda não tem titulação), já escolhe — a TI pode mudar.
function titulacaoDoEdubox(trocouProfessor) {
  const prof = $('av-f-prof'), tit = $('av-f-tit'), aviso = $('av-f-tit-edubox');
  if (!prof || !tit || !aviso) return;
  const nome = prof.value.trim().toUpperCase();
  const p = (professores || []).find(x => x.nome.toUpperCase() === nome);
  aviso.textContent = p && p.titulacaoEdubox ? `Titulação no Edubox: ${p.titulacaoEdubox}${p.titulacao ? '' : ' (não paga criação)'}` : (nome && p ? 'Edubox sem titulação para este professor' : '');
  if (p && p.titulacao && !tit.disabled && (trocouProfessor || !tit.value)) {
    tit.value = p.titulacao;
    tit.dispatchEvent(new Event('change'));
  }
}

function substituir(d) {
  const i = dados.disciplinas.findIndex(x => x.id === d.id);
  const antigo = dados.disciplinas[i] || {};
  dados.disciplinas[i] = { ...antigo, ...d, edubox: antigo.edubox };
}

async function salvarFicha(reabrir) {
  const id = $('av-modal').dataset.id;
  const body = { origem: $('av-f-origem').value, obs: $('av-f-obs').value };
  if ($('av-f-prof')) { body.professor = $('av-f-prof').value; body.titulacao = $('av-f-tit').value; body.pago = $('av-f-pago').checked; }
  try {
    substituir(await apiFetch(`/${MODULO}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }));
    render();
    if (reabrir) abrirFicha(id); else { $('av-modal').classList.add('hidden'); toast('Salvo.'); }
  } catch (e) { toast(e.message, 'erro'); }
}

async function marcar(btn) {
  const id = $('av-modal').dataset.id;
  const body = btn.dataset.avEtapa
    ? { tipo: 'etapa', item: btn.dataset.avEtapa, feito: !btn.classList.contains('on') }
    : { tipo: 'avaliacao', item: btn.dataset.avAval, destino: btn.dataset.avDestino, feito: !btn.classList.contains('on') };
  btn.disabled = true;
  try {
    substituir(await apiFetch(`/${MODULO}/${encodeURIComponent(id)}/marca`, { method: 'PATCH', body: JSON.stringify(body) }));
    render();
    abrirFicha(id);
  } catch (e) { toast(e.message, 'erro'); btn.disabled = false; }
}

async function carregarProfessores() {
  if (professores) return;
  professores = [];
  try { professores = await apiFetch(`/${MODULO}/professores`); } catch (e) { professores = []; }
  $('av-professores').innerHTML = professores.map(p => `<option value="${esc(p.nome)}">${p.titulacaoEdubox ? esc(p.titulacaoEdubox) : ''}</option>`).join('');
}

// ================================================================
//  ABA: RELATÓRIO (padrão FATEC)
// ================================================================
function renderRelatorio() {
  const criar = dados.disciplinas.filter(d => d.origem === 'criar' && (!filtroCurso || d.cursoId === filtroCurso));
  const cursos = [...new Map(dados.disciplinas.map(d => [d.cursoId, d.cursoNome])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  tela().innerHTML = `
    <div class="av-filtros">
      <label class="av-filtro-curso">Curso
        <select class="select-filter" data-av-curso><option value="">Todos os cursos</option>${cursos.map(([id, nome]) => `<option value="${esc(id)}" ${filtroCurso === id ? 'selected' : ''}>${esc(nomeCurso(nome))}</option>`).join('')}</select>
      </label>
      <button type="button" class="btn-secondary av-pdf" data-av-pdf>Abrir PDF</button>
    </div>
    <div class="av-papel-wrap"><article class="av-papel" id="av-papel">${papel(criar)}</article></div>`;
}

function papel(criar) {
  const porCurso = new Map();
  criar.forEach(d => { if (!porCurso.has(d.cursoNome)) porCurso.set(d.cursoNome, []); porCurso.get(d.cursoNome).push(d); });
  const ok = (m) => m ? '✓' : '—';
  const total = criar.reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const pago = criar.filter(d => d.pagamento && d.pagamento.pago).reduce((s, d) => s + (Number(d.valor) || 0), 0);
  const porProf = new Map();
  criar.filter(d => d.professor).forEach(d => {
    const k = d.professor; const p = porProf.get(k) || { qtd: 0, valor: 0, pago: 0, tit: d.titulacao };
    p.qtd++; p.valor += Number(d.valor) || 0; if (d.pagamento && d.pagamento.pago) p.pago += Number(d.valor) || 0;
    porProf.set(k, p);
  });
  const hoje = new Date().toLocaleDateString('pt-BR');
  return `
    <header class="av-cab">
      <img src="/docencia/plano-acao/img/logo-fatec-cabecalho.png" alt="FATEC Ivaiporã" class="av-logo">
      <div class="av-cab-inst">
        <span>Mantida pela União de Ensino Superior do Vale do Ivaí Ltda - UNESVI</span>
        <span>Credenciamento EaD - Portaria nº 874 de 28 de novembro de 2025</span>
        <span>Recredenciamento - Portaria nº 878 de 28 de novembro de 2025</span>
      </div>
    </header>
    <h2 class="av-rel-titulo">CRIAÇÃO DE DISCIPLINAS EAD — ${esc(dados.semestre)}</h2>
    <p class="av-rel-sub">${filtroCurso ? esc(nomeCurso(criar[0] ? criar[0].cursoNome : '')) + ' · ' : ''}${criar.length} disciplina(s) para criar do zero · emitido em ${hoje}</p>
    ${criar.length ? [...porCurso.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([curso, ds]) => `
      <table class="av-rel-tab av-rel-fixa">
        <colgroup><col style="width:27%"><col style="width:5%"><col style="width:17%"><col style="width:9%"><col style="width:9%"><col style="width:5%"><col style="width:5%"><col style="width:5%"><col style="width:5%"><col style="width:5%"><col style="width:7%"><col style="width:6%"></colgroup>
        <thead><tr><th colspan="12" class="av-rel-tab-titulo">${esc(nomeCurso(curso))}</th></tr>
          <tr><th>Disciplina</th><th>Per.</th><th>Professor</th><th>Titulação</th><th class="num">Valor</th>
            <th title="Treinamento">Trein.</th><th title="Seleção das unidades">Sel.</th><th title="Coordenador validou as unidades">Coord.</th><th title="Criada no AVA">AVA</th><th title="AVA validado pela TI">Valid.</th><th>Avaliações</th><th>Pago</th></tr></thead>
        <tbody>${ds.map(d => { const a = andamento(d); return `<tr>
          <td>${esc(d.nome)}</td><td class="c">${d.periodos.join('/')}º</td><td>${esc(d.professor || '—')}</td>
          <td>${d.titulacao ? esc(dados.titulacoes[d.titulacao].rotulo) : '—'}</td><td class="num">${brl(d.valor)}</td>
          ${dados.etapas.map(e => `<td class="c">${ok((d.etapas || {})[e.id])}</td>`).join('')}
          <td class="c">${a.entregues}/${a.total}</td><td class="c">${a.pago ? '✓' : '—'}</td></tr>`; }).join('')}
          <tr class="av-rel-tot"><td colspan="4">Total do curso</td><td class="num">${brl(ds.reduce((s, d) => s + (Number(d.valor) || 0), 0))}</td><td colspan="7"></td></tr>
        </tbody>
      </table>`).join('') : '<p class="av-rel-vazio">Nenhuma disciplina para criar do zero neste semestre/curso.</p>'}
    ${porProf.size ? `
    <table class="av-rel-tab av-rel-resumo">
      <thead><tr><th colspan="5" class="av-rel-tab-titulo">Resumo por professor</th></tr>
        <tr><th>Professor</th><th>Titulação</th><th class="c">Disciplinas</th><th class="num">A pagar</th><th class="num">Pago</th></tr></thead>
      <tbody>${[...porProf.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([n, p]) => `<tr><td>${esc(n)}</td><td>${p.tit ? esc(dados.titulacoes[p.tit].rotulo) : '—'}</td><td class="c">${p.qtd}</td><td class="num">${brl(p.valor)}</td><td class="num">${brl(p.pago)}</td></tr>`).join('')}
        <tr class="av-rel-tot"><td colspan="3">Total geral</td><td class="num">${brl(total)}</td><td class="num">${brl(pago)}</td></tr></tbody>
    </table>` : ''}
    <p class="av-rel-legenda">Etapas: Trein. = treinamento · Sel. = seleção das unidades · Coord. = unidades validadas pelo coordenador · AVA = disciplina criada no AVA · Valid. = AVA validado pela TI. Avaliações = recebimentos confirmados (coordenador do curso + coordenação EAD) de 1º bim. 1ª/2ª ch., 2º bim. 1ª/2ª ch., exame e simulado. Valores: Especialista R$ 800,00 · Mestre R$ 900,00 · Doutor R$ 1.000,00.</p>
    <footer class="av-rodape-inst">
      <span>Avenida Brasil, 45 – Fone (43) 3472-0201 – CEP 86870-000 – Ivaiporã /Paraná</span>
      <span>www.fatecivaipora.com.br</span>
    </footer>`;
}

// PDF do relatório (A4 paisagem), mesmo gerador do Plano de Ação.
const HTML2PDF = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
let pdfPronto = null;
function carregarHtml2pdf() {
  if (window.html2pdf) return Promise.resolve();
  if (!pdfPronto) pdfPronto = new Promise((ok, erro) => { const s = document.createElement('script'); s.src = HTML2PDF; s.onload = ok; s.onerror = () => { pdfPronto = null; erro(new Error('Não consegui carregar o gerador de PDF.')); }; document.head.appendChild(s); });
  return pdfPronto;
}
let marcaPng = null;
function marcaDagua() {
  if (marcaPng) return Promise.resolve(marcaPng);
  return new Promise((ok, erro) => {
    const img = new Image();
    img.onload = () => { const cv = document.createElement('canvas'); cv.width = 636; cv.height = 714; cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); marcaPng = cv.toDataURL('image/png'); ok(marcaPng); };
    img.onerror = () => erro(new Error('Não consegui carregar a marca d’água.'));
    img.src = '/docencia/plano-acao/img/marca-f.svg';
  });
}
async function abrirPdf(btn) {
  const aba2 = window.open('', '_blank');
  if (aba2) aba2.document.write('<p style="font-family:sans-serif;padding:2rem">Gerando o PDF...</p>');
  btn.disabled = true; btn.textContent = 'Gerando PDF...';
  const fora = document.createElement('div');
  try {
    await carregarHtml2pdf();
    const marca = await marcaDagua();
    fora.className = 'av-pdf-fora';
    fora.innerHTML = `<article class="av-papel av-papel-pdf">${$('av-papel').innerHTML}</article>`;
    document.body.appendChild(fora);
    await Promise.all([...fora.querySelectorAll('img')].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })));
    const nome = `Criação de disciplinas EAD - ${dados.semestre}.pdf`;
    const blob = await window.html2pdf().set({
      margin: [8, 10, 8, 10], filename: nome, image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.av-cab', '.av-rel-resumo', '.av-rodape-inst'] }
    }).from(fora.firstElementChild).toPdf().get('pdf').then(pdf => {
      const n = pdf.internal.getNumberOfPages(), pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      const lw = 115, lh = 115 * 238 / 212;
      for (let i = 1; i <= n; i++) { pdf.setPage(i); pdf.setGState(new pdf.GState({ opacity: 0.05 })); pdf.addImage(marca, 'PNG', (pw - lw) / 2, (ph - lh) / 2, lw, lh); pdf.setGState(new pdf.GState({ opacity: 1 })); }
      return pdf.output('blob');
    });
    const url = URL.createObjectURL(new File([blob], nome, { type: 'application/pdf' }));
    if (aba2) aba2.location.href = url; else { const a = document.createElement('a'); a.href = url; a.download = nome; a.click(); }
  } catch (e) { if (aba2) aba2.close(); toast(e.message, 'erro'); }
  finally { fora.remove(); btn.disabled = false; btn.textContent = 'Abrir PDF'; }
}

// ================================================================
//  ABA: ARQUIVOS DO CONDUIT
// ================================================================
async function renderConduit() {
  if (!['ti', 'adm'].includes(dados.papel)) { tela().innerHTML = '<p class="av-vazio">Só a TI gera os arquivos do Conduit.</p>'; return; }
  if (!conduit || conduit.semestre !== dados.semestre) {
    tela().innerHTML = '<p class="av-vazio">Buscando as salas EAD no Edubox...</p>';
    try { conduit = await apiFetch(`/${MODULO}/conduit?semestre=${encodeURIComponent(dados.semestre)}`); }
    catch (e) { tela().innerHTML = `<div class="av-card av-erro">${esc(e.message)}</div>`; return; }
    if (aba !== 'conduit') return;
  }
  const cursos = [...new Map(conduit.linhas.map(l => [l.cursoId, l.cursoNome])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  const novas = conduit.linhas.filter(l => l.origem !== 'ja-existe' && (!filtroCurso || l.cursoId === filtroCurso));
  const repl = novas.filter(l => /^replicar/.test(l.origem));
  const semModelo = repl.filter(l => !(l.modelo && l.modelo.shortname));
  const pronta = (l) => /^replicar/.test(l.origem) && l.modelo && l.modelo.shortname;
  const r1 = novas.filter(l => pronta(l) && l.rodada === 1), r2 = novas.filter(l => pronta(l) && l.rodada === 2);
  const porCurso = cursos.filter(([id]) => !filtroCurso || id === filtroCurso).map(([id, nome]) => ({ id, nome, linhas: novas.filter(l => l.cursoId === id) })).filter(c => c.linhas.length);
  const rot = { criar: 'Criar do zero', replicar: 'Replicar', 'replicar-outro': 'Replicar de outro curso' };
  const modeloTxt = (l) => {
    const mae = l.mae ? `<span class="av-tag">sala-mãe de ${l.grupo} salas${l.comum ? ' — disciplina comum a todos os cursos' : ''}</span>` : '';
    if (!/^replicar/.test(l.origem)) return `${mae}<span class="av-sub">sala nova — o professor monta as unidades (etapas da criação)</span>`;
    if (l.mae && l.modelo) return `${mae}${l.modelo.shortname ? `<code>${esc(l.modelo.shortname)}</code>` : '<span class="av-sub av-alerta">falta ler o shortname no AVA</span>'}<span class="av-sub"><b>1ª rodada</b> — ${esc(l.modelo.nome)}; depois a TI atualiza</span>`;
    if (!l.modelo) return '<span class="av-sub av-alerta">nenhuma sala EAD modelo achada no AVA — conferir</span>';
    if (l.modelo.mae) return `<code>${esc(l.modelo.shortname)}</code><span class="av-sub"><b>2ª rodada</b> — sala-mãe deste semestre, depois de atualizada</span>`;
    return `${l.modelo.shortname ? `<code>${esc(l.modelo.shortname)}</code>` : '<span class="av-sub av-alerta">falta ler o shortname no AVA</span>'}<span class="av-sub">${esc(l.modelo.nome)}</span>`;
  };
  tela().innerHTML = `
    <section class="av-resumo">
      <div class="av-num"><b>${novas.length}</b><span>salas a abrir no AVA</span></div>
      <div class="av-num"><b>${repl.length}</b><span>replicadas com as unidades</span></div>
      <div class="av-num"><b>${novas.length - repl.length}</b><span>criar do zero</span></div>
      <div class="av-num"><b>${novas.filter(l => l.mae).length}</b><span>salas-mãe (disciplina em mais de uma sala)</span></div>
      <div class="av-num"><b>${semModelo.length}</b><span>sem sala modelo conferida</span></div>
    </section>
    <section class="av-card av-passos">
      <h3>Ordem no AVA</h3>
      <ol>
        <li><b>course.csv de cada curso → Conduit.</b> Abre as salas novas do semestre na categoria <code>UNESVI\\Graduação\\CURSO\\${esc(dados.semestre.replace('.', '/'))}</code>, com o shortname e o idnumber que o enroll usa.</li>
        <li><b>Carregar cursos, 1ª rodada</b> (Administração do site › Cursos › Carregar cursos, modo <i>"Atualizar somente cursos existentes"</i>): as <b>salas-mãe</b> e as salas únicas recebem a sala do semestre anterior inteira (unidades de aprendizagem, atividades, avaliações) pela coluna <code>templatecourse</code>. <b>Teste antes com uma linha só.</b></li>
        <li><b>A TI atualiza cada sala-mãe</b> (uma por disciplina, mesmo que ela esteja em vários cursos).</li>
        <li><b>Carregar cursos, 2ª rodada:</b> as outras salas da mesma disciplina replicam da sala-mãe já atualizada.</li>
        <li><b>auth.csv</b> (um só, pra todos) — em breve, depois do HTTPS do relay (leva CPF e nascimento).</li>
        <li><b>enroll.csv de cada curso</b> — em breve; só na semana de início das aulas.</li>
      </ol>
    </section>
    <div class="av-filtros">
      <label class="av-filtro-curso">Curso
        <select class="select-filter" data-av-curso><option value="">Todos os cursos</option>${cursos.map(([id, nome]) => `<option value="${esc(id)}" ${filtroCurso === id ? 'selected' : ''}>${esc(nomeCurso(nome))}</option>`).join('')}</select>
      </label>
      <div class="av-pilulas">
        <button type="button" class="btn-primary" data-av-csv="carregar" data-av-rodada="1" ${r1.length ? '' : 'disabled'}>1ª rodada: salas do semestre anterior (${r1.length})</button>
        <button type="button" class="btn-secondary" data-av-csv="carregar" data-av-rodada="2" ${r2.length ? '' : 'disabled'}>2ª rodada: replicar das salas-mãe (${r2.length})</button>
      </div>
    </div>
    ${porCurso.map(c => `
    <section class="av-card av-card-tabela">
      <div class="av-conduit-topo"><h3>${esc(nomeCurso(c.nome))} <span class="av-sub">${c.linhas.length} sala(s)</span></h3>
        <button type="button" class="btn-secondary" data-av-csv="course" data-av-csv-curso="${esc(c.id)}">Baixar course.csv</button></div>
      <div class="av-tabela-wrap"><table class="av-tabela">
        <thead><tr><th>Sala (shortname)</th><th>Nome completo no AVA</th><th>Situação</th><th>Copiar unidades de (templatecourse)</th></tr></thead>
        <tbody>${c.linhas.map(l => `<tr>
          <td><code>${esc(l.shortname)}</code>${l.semSigla ? '<span class="av-sub av-alerta">sem sigla no Edubox</span>' : ''}<span class="av-sub">${esc(l.turma)}</span>${(l.diarios || []).length > 1 ? `<span class="av-sub ${l.juntasConfirmado ? '' : 'av-alerta'}">uma sala pros diários ${l.diarios.map(esc).join(' + ')} (estudam juntos${l.juntasConfirmado ? '' : ' — conferir no horário'}); os outros entram pelo enroll</span>` : ''}</td>
          <td>${esc(l.fullname)}</td>
          <td>${rot[l.origem] || esc(l.origem)}</td>
          <td>${modeloTxt(l)}</td>
        </tr>`).join('')}</tbody></table></div>
    </section>`).join('') || '<p class="av-vazio">Nenhuma sala nova pra abrir no AVA neste semestre.</p>'}
    <p class="av-legenda">Sala = disciplina EAD numa turma do Edubox (coddtu). shortname = sigla do Edubox + " - " + coddtu (padrão do AVA); idnumber = coddtu. As que já existem no AVA neste semestre não entram. Arquivos em UTF-8, separados por vírgula, fim de linha LF.</p>`;
}

// CSV no padrão do Conduit: UTF-8 sem BOM, vírgula, LF; vírgula dentro do texto vira espaço (como já é feito no AVA)
function baixarCsv(nome, cab, linhas) {
  const lim = (v) => String(v ?? '').replace(/[,\r\n]+/g, ' ');
  const txt = [cab.join(','), ...linhas.map(l => l.map(lim).join(','))].join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' }));
  a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function gerarCsv(b) {
  const novas = conduit.linhas.filter(l => l.origem !== 'ja-existe');
  if (b.dataset.avCsv === 'course') {
    const L = novas.filter(l => l.cursoId === b.dataset.avCsvCurso);
    baixarCsv('course.csv', ['action', 'shortname', 'idnumber', 'category', 'fullname', 'visible'], L.map(l => ['create', l.shortname, l.idnumber, l.category, l.fullname, 1]));
  } else {
    const rodada = Number(b.dataset.avRodada);
    const L = novas.filter(l => /^replicar/.test(l.origem) && l.modelo && l.modelo.shortname && l.rodada === rodada && (!filtroCurso || l.cursoId === filtroCurso));
    baixarCsv(`carregar-cursos-${dados.semestre}-rodada${rodada}.csv`, ['shortname', 'templatecourse'], L.map(l => [l.shortname, l.modelo.shortname]));
  }
}

// ================================================================
//  EVENTOS E INÍCIO
// ================================================================
// ================================================================
//  ABA: UNIDADES (LINKS) — 18/11/2026
//  Professor (sem login) escolhe as UAs do catálogo SAGAH pelo link dele; o coordenador do curso valida
//  pelo link do curso; a TI gera/copia os links e marca a validação da sala no AVA. Página pública:
//  /unidades-ead/index.html?t=<token>. Servidor: /automacao-ava/unidades e /publico/unidades.
// ================================================================
let unidades = null;          // { semestre, disciplinas, links }
let uaAberta = new Set();
const linkUrl = (token) => `${location.origin}/unidades-ead/index.html?t=${token}`;
const nomeCurso2 = (n) => String(n || '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|E|Em)\b/g, x => x.toLowerCase());
const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

async function renderUnidades(recarregar = true) {
  if (!['ti', 'adm'].includes(dados.papel)) { tela().innerHTML = '<p class="av-vazio">Só a TI gera os links das unidades.</p>'; return; }
  if (recarregar || !unidades || unidades.semestre !== dados.semestre) {
    tela().innerHTML = '<p class="av-vazio">Carregando as unidades...</p>';
    try { unidades = await apiFetch(`/${MODULO}/unidades?semestre=${encodeURIComponent(dados.semestre)}`); }
    catch (e) { tela().innerHTML = `<div class="av-card av-erro">${esc(e.message)}</div>`; return; }
  }
  const ds = unidades.disciplinas;
  if (!ds.length) {
    tela().innerHTML = `<div class="av-card ua-vazio"><b>Nenhuma disciplina para mandar link ainda.</b>
      <p>Entram aqui as disciplinas <b>Criar do zero</b> que já têm professor. Abra a aba <b>Disciplinas EAD</b>, clique na disciplina e preencha o professor na ficha.</p></div>`;
    return;
  }
  const conta = (d) => ({ pre: d.itens.filter(u => u.codigo).length, ok: d.itens.filter(u => u.coord?.status === 'ok').length, aj: d.itens.filter(u => u.coord?.status === 'ajustar').length, ava: d.itens.filter(u => u.ava).length });
  const tot = ds.reduce((a, d) => { const c = conta(d); a.qtd += d.qtd; a.pre += c.pre; a.ok += c.ok; a.aj += c.aj; a.ava += c.ava; return a; }, { qtd: 0, pre: 0, ok: 0, aj: 0, ava: 0 });
  const profs = [...ds.reduce((m, d) => { const k = normNome(d.professor); if (!m.has(k)) m.set(k, { nome: d.professor, discs: [] }); m.get(k).discs.push(d); return m; }, new Map()).values()]
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const cursos = [...ds.reduce((m, d) => { if (!m.has(d.cursoId)) m.set(d.cursoId, { id: d.cursoId, nome: d.cursoNome, discs: [] }); m.get(d.cursoId).discs.push(d); return m; }, new Map()).values()]
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const linkDe = (tipo, k) => unidades.links.find(l => l.tipo === tipo && (tipo === 'professor' ? normNome(l.professor) === k : l.cursoId === k));
  const acoesLink = (l, attrs) => l
    ? `<div class="ua-link-acoes"><button type="button" class="btn-secondary" data-ua-copiar="${esc(l.token)}">Copiar link</button><a class="ua-abrir" href="${esc(linkUrl(l.token))}" target="_blank" rel="noopener">Abrir ↗</a></div>`
    : `<button type="button" class="btn-primary" ${attrs}>Gerar link</button>`;
  const barra = (d) => { const c = conta(d); const p = (n) => Math.round(100 * n / d.qtd); return `<span class="ua-barra" title="${c.ok} validadas · ${c.pre - c.ok} aguardando · ${d.qtd - c.pre} sem preencher"><i class="ok" style="width:${p(c.ok)}%"></i><i class="pre" style="width:${p(c.pre - c.ok)}%"></i></span>`; };
  const pilulas = (d) => { const c = conta(d); return `<span class="ua-pills">
      <span class="ua-pill">${c.pre}/${d.qtd} preenchidas</span>
      <span class="ua-pill ${c.ok === d.qtd ? 'bom' : ''}">${c.ok} validadas</span>
      ${c.aj ? `<span class="ua-pill alerta">${c.aj} p/ ajustar</span>` : ''}
      <span class="ua-pill ${c.ava === d.qtd ? 'bom' : ''}">${c.ava} AVA</span></span>`; };
  const situacaoUa = (u) => !u.codigo ? '<span class="ua-sit-ti vazio">não preenchida</span>'
    : u.coord?.status === 'ok' ? '<span class="ua-sit-ti bom">✓ validada</span>'
    : u.coord?.status === 'ajustar' ? `<span class="ua-sit-ti alerta">ajustar</span><span class="av-sub">${esc(u.coord.obs)}</span>`
    : `<span class="ua-sit-ti espera">aguardando${u.coord?.status === 'reenviada' ? ' (corrigida)' : ''}</span>`;

  tela().innerHTML = `
    <div class="av-resumo">
      <div class="av-num"><b>${ds.length}</b><span>disciplinas novas com professor</span></div>
      <div class="av-num"><b>${tot.pre}<small>/${tot.qtd}</small></b><span>UAs preenchidas</span></div>
      <div class="av-num"><b>${tot.ok}</b><span>validadas pelo coordenador</span></div>
      <div class="av-num"><b class="${tot.aj ? 'av-alerta' : ''}">${tot.aj}</b><span>esperando ajuste do professor</span></div>
      <div class="av-num"><b>${tot.ava}</b><span>salas AVA validadas (TI)</span></div>
    </div>

    <div class="ua-duas">
      <section class="av-card av-card-tabela">
        <div class="ua-card-topo"><h3>Links dos professores</h3><p class="av-sub">Um link por professor, com todas as disciplinas novas dele.</p></div>
        <div class="av-tabela-wrap"><table class="av-tabela ua-tab">
          <thead><tr><th>Professor</th><th>Disciplinas</th><th></th></tr></thead>
          <tbody>${profs.map(p => `<tr>
            <td><b>${esc(p.nome)}</b></td>
            <td>${p.discs.map(d => `<div class="ua-disc-mini"><span>${esc(nomeCurso2(d.nome))}</span>${barra(d)}</div>`).join('')}</td>
            <td class="ua-col-link">${acoesLink(linkDe('professor', normNome(p.nome)), `data-ua-gerar="professor" data-ua-prof="${esc(p.nome)}"`)}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>
      <section class="av-card av-card-tabela">
        <div class="ua-card-topo"><h3>Links dos coordenadores</h3><p class="av-sub">Um link por curso. O coordenador vem do cadastro do Órbita (cargo Coordenador); dá para trocar o nome aqui.</p></div>
        <div class="av-tabela-wrap"><table class="av-tabela ua-tab">
          <thead><tr><th>Curso</th><th>Coordenador</th><th></th></tr></thead>
          <tbody>${cursos.map(c => { const l = linkDe('coordenador', c.id); const attrs = `data-ua-gerar="coordenador" data-ua-curso="${esc(c.id)}" data-ua-curso-nome="${esc(c.nome)}"`; return `<tr>
            <td><b>${esc(nomeCurso2(c.nome))}</b><span class="av-sub">${c.discs.length} disciplina(s)</span></td>
            <td><input class="ua-input" data-ua-coord="${esc(c.id)}" data-ua-coord-orig="${esc(l ? l.coordenador : '')}" value="${esc(l ? l.coordenador : (c.discs[0].coordenador || ''))}" placeholder="Nome do coordenador" aria-label="Coordenador de ${esc(nomeCurso2(c.nome))}"></td>
            <td class="ua-col-link">${l ? `${acoesLink(l)}<button type="button" class="ua-salvar-nome hidden" ${attrs}>Salvar nome</button>` : acoesLink(null, attrs)}</td></tr>`; }).join('')}</tbody>
        </table></div>
      </section>
    </div>

    ${cursos.map(c => `
    <section class="av-card ua-curso">
      <h3 class="ua-curso-nome">${esc(nomeCurso2(c.nome))}</h3>
      ${c.discs.map(d => { const aberta = uaAberta.has(d.id); const por = new Map(d.itens.map(u => [u.n, u])); return `
        <div class="ua-item ${aberta ? 'aberta' : ''}">
          <div class="ua-item-topo">
            <button type="button" class="ua-item-btn" data-ua-abrir="${esc(d.id)}" aria-expanded="${aberta}">
              <span class="ua-seta" aria-hidden="true">›</span>
              <span><b>${esc(nomeCurso2(d.nome))}</b><span class="av-sub">Prof. ${esc(d.professor)}${d.periodos?.length ? ` · ${d.periodos.join('º, ')}º período` : ''}${d.chEad ? ` · ${d.chEad} h EAD` : ''}</span></span>
            </button>
            ${pilulas(d)}
            <label class="ua-qtd">UAs <select class="select-filter" data-ua-qtd="${esc(d.id)}">${[6, 12].map(q => `<option ${q === d.qtd ? 'selected' : ''}>${q}</option>`).join('')}</select></label>
          </div>
          ${aberta ? `<div class="av-tabela-wrap"><table class="av-tabela ua-tab ua-tab-uas">
            <thead><tr><th>UA</th><th>Código SAGAH</th><th>Título</th><th>Coordenador</th><th>Sala AVA</th></tr></thead>
            <tbody>${Array.from({ length: d.qtd }, (_, i) => { const n = i + 1; const u = por.get(n) || {}; return `${n === 1 || n === d.qtd / 2 + 1 ? `<tr class="ua-bim-ti"><td colspan="5">${n === 1 ? '1º' : '2º'} bimestre</td></tr>` : ''}<tr>
              <td><b>UA ${String(n).padStart(2, '0')}</b></td>
              <td>${u.codigo ? `<code>${esc(u.codigo)}</code>` : '<span class="av-sub">—</span>'}</td>
              <td>${esc(u.titulo || '')}</td>
              <td>${situacaoUa(u)}</td>
              <td><label class="ua-check"><input type="checkbox" data-ua-ava="${esc(d.id)}" data-ua-n="${n}" ${u.ava ? 'checked' : ''} ${u.codigo ? '' : 'disabled'}> validada</label></td></tr>`; }).join('')}</tbody>
          </table></div>` : ''}
        </div>`; }).join('')}
    </section>`).join('')}
    <p class="av-legenda">Entram aqui as disciplinas "Criar do zero" com professor definido. Professor preencheu todas as UAs → a etapa "Seleção das unidades" marca sozinha; coordenador validou todas → marca "Unidades validadas pelo coordenador". Os links não pedem login: mande só para a pessoa certa.</p>`;
}

async function copiarTexto(txt) {
  try { await navigator.clipboard.writeText(txt); toast('Link copiado.', 'ok'); }
  catch (e) { window.prompt('Copie o link:', txt); }
}

async function acaoUnidades(e) {
  if (aba !== 'unidades') return;
  const t = e.target.closest('button, input[type="checkbox"], select');
  if (!t) return;
  try {
    if (e.type === 'click' && t.dataset.uaCopiar) return copiarTexto(linkUrl(t.dataset.uaCopiar));
    if (e.type === 'click' && t.dataset.uaAbrir) { uaAberta.has(t.dataset.uaAbrir) ? uaAberta.delete(t.dataset.uaAbrir) : uaAberta.add(t.dataset.uaAbrir); return renderUnidades(false); }
    if (e.type === 'click' && t.dataset.uaGerar) {
      const corpo = { semestre: dados.semestre, tipo: t.dataset.uaGerar };
      if (corpo.tipo === 'professor') corpo.professor = t.dataset.uaProf;
      else {
        corpo.cursoId = t.dataset.uaCurso; corpo.cursoNome = t.dataset.uaCursoNome;
        corpo.coordenador = (document.querySelector(`[data-ua-coord="${CSS.escape(t.dataset.uaCurso)}"]`) || {}).value || '';
      }
      t.disabled = true;
      const l = await apiFetch(`/${MODULO}/unidades/links`, { method: 'POST', body: JSON.stringify(corpo) });
      await renderUnidades(true);
      return copiarTexto(linkUrl(l.token));
    }
    if (e.type === 'change' && t.dataset.uaQtd) {
      await apiFetch(`/${MODULO}/unidades/${encodeURIComponent(t.dataset.uaQtd)}`, { method: 'PATCH', body: JSON.stringify({ qtd: Number(t.value) }) });
      toast('Quantidade de unidades salva.', 'ok'); return renderUnidades(true);
    }
    if (e.type === 'change' && t.dataset.uaAva) {
      t.disabled = true;
      await apiFetch(`/${MODULO}/unidades/${encodeURIComponent(t.dataset.uaAva)}`, { method: 'PATCH', body: JSON.stringify({ n: Number(t.dataset.uaN), ava: t.checked }) });
      return renderUnidades(true);
    }
  } catch (err) { toast(err.message, 'erro'); t.disabled = false; }
}

function ligarEventos() {
  tela().addEventListener('input', (e) => { const i = e.target.closest('[data-ua-coord]'); if (!i) return; const b = i.closest('tr').querySelector('.ua-salvar-nome'); if (b) b.classList.toggle('hidden', i.value.trim() === i.dataset.uaCoordOrig); });
  tela().addEventListener('click', acaoUnidades);
  tela().addEventListener('change', acaoUnidades);
  $('av-semestre').addEventListener('change', carregar);
  $('av-abas').addEventListener('click', (e) => { const b = e.target.closest('[data-aba]'); if (!b || b.disabled) return; aba = b.dataset.aba; render(); });
  document.addEventListener('change', (e) => { const s = e.target.closest('[data-av-curso]'); if (s) { filtroCurso = s.value; render(); } });
  tela().addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-av-abrir]');
    if (!t) return;
    if (t.dataset.avOrigem) { filtroOrigem = t.dataset.avOrigem; return render(); }
    if (t.dataset.avAbrir) return abrirFicha(t.dataset.avAbrir);
    if (t.dataset.avPdf !== undefined) return abrirPdf(t);
    if (t.dataset.avCsv) return gerarCsv(t);
  });
  tela().addEventListener('keydown', (e) => { const l = e.target.closest('[data-av-abrir]'); if (l && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); abrirFicha(l.dataset.avAbrir); } });
  $('av-modal').addEventListener('click', (e) => {
    if (e.target === $('av-modal') || e.target.closest('#av-modal-fechar')) { $('av-modal').classList.add('hidden'); return; }
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.avEtapa || b.dataset.avAval) return marcar(b);
    if (b.dataset.avSalvar !== undefined) return salvarFicha(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('av-modal').classList.add('hidden'); });
}

async function initApp(user, role) {
  appInitialized = true; initializedRole = role;
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); location.href = '../../auth/login.html'; });
  $('auth-guard').classList.add('hidden');
  $('app').classList.remove('hidden');
  ligarEventos();
  let semestres = [];
  try { semestres = await apiFetch(`/${MODULO}/semestres`); } catch (e) { toast(e.message, 'erro'); }
  // abre no próximo semestre (o que está sendo preparado), se já existir no Edubox
  const padrao = semestres[1] || semestres[0] || '';
  $('av-semestre').innerHTML = semestres.map(s => `<option value="${esc(s)}" ${s === padrao ? 'selected' : ''}>${esc(s)}</option>`).join('');
  await carregar();
}

const cached = getCachedAuth();
onAuthStateChanged(auth, async (user) => {
  if (!user) { clearCachedAuth(); location.href = '../../auth/login.html'; return; }
  currentUser = user;
  let role = 'visitante', meuOverrides = null;
  try { const u = await apiFetch('/usuarios/me'); role = u.role || 'visitante'; meuOverrides = u.permissoes || null; }
  catch (e) { role = cached ? cached.role : 'visitante'; }
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
  if (!appInitialized || initializedRole !== role) initApp(user, role);
});
