// ================================================================
//  ÓRBITA — FORMULÁRIOS (Docência, 12/11/2026)
//  A Direção (ADM N1/N2) cria o formulário, manda o link e acompanha as respostas: filtros, relatório
//  por pergunta, tabela, imprimir (padrão Órbita, logos) e Excel. O aluno responde em /formulario/?t=.
//  Servidor: src/rotas/formularios.js
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
const MODULO = 'formularios';
const NIVEL_PADRAO = { adm_l2: 3 };
const $ = (id) => document.getElementById(id);
let currentUser = null, appInitialized = false, initializedRole = null;

const TIPOS = [
  ['curta', 'Resposta curta'], ['longa', 'Parágrafo'], ['unica', 'Escolha uma opção'], ['multipla', 'Caixas de seleção'],
  ['escala', 'Escala de 1 a 5'], ['simnao', 'Sim / Não'], ['data', 'Data']
];
const TIPO_ROT = Object.fromEntries(TIPOS);
const SIT_ROT = { aberto: 'Aberto', agendado: 'Agendado', encerrado: 'Encerrado' };

async function apiFetch(endpoint, options = {}) {
  const token = await currentUser.getIdToken();
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}
let toastTimer;
function toast(msg, tipo = '') {
  const t = $('fm-toast');
  t.textContent = msg; t.className = `fm-toast ${tipo}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3400);
}
const dataBR = (iso) => { if (!iso) return ''; const [a, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${a}`; };
const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const linkPublico = (token) => `${location.origin}/formulario/?t=${encodeURIComponent(token)}`;
const novoId = () => Math.random().toString(36).slice(2, 10);
async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; }
  catch (e) { const t = document.createElement('textarea'); t.value = texto; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok; }
}

// ================= LISTA =================
let lista = [];
async function telaLista() {
  $('fm-novo').classList.remove('hidden');
  $('fm-tela').innerHTML = '<p class="fm-carregando">Carregando…</p>';
  try { lista = await apiFetch('/formularios'); }
  catch (err) { $('fm-tela').innerHTML = `<p class="fm-erro">${esc(err.message)}</p>`; return; }
  if (!lista.length) {
    $('fm-tela').innerHTML = `<div class="fm-vazio"><h2>Nenhum formulário ainda</h2><p>Crie o primeiro: escreva as perguntas, coloque a arte do evento se quiser, e mande o link para os alunos.</p><button type="button" class="btn-primary" data-acao="novo">+ Novo formulário</button></div>`;
    return;
  }
  $('fm-tela').innerHTML = `<div class="fm-lista">${lista.map(f => `
    <article class="fm-item">
      <div class="fm-item-topo"><span class="fm-sit fm-sit-${f.situacao}">${SIT_ROT[f.situacao]}</span><span class="fm-item-meta">${f.identificacao === 'identificado' ? 'Identificado' : 'Anônimo'}${f.umaPorPessoa ? ' · 1 resposta por pessoa' : ''}${f.fechaEm ? ` · até ${dataBR(f.fechaEm)}` : ''}</span></div>
      <h2>${esc(f.titulo)}</h2>
      <p class="fm-item-num"><b>${f.respostas || 0}</b> ${f.respostas === 1 ? 'resposta' : 'respostas'} · ${f.perguntas} ${f.perguntas === 1 ? 'pergunta' : 'perguntas'}</p>
      <div class="fm-item-acoes">
        <button type="button" class="btn-primary" data-acao="respostas" data-id="${f.id}">Respostas</button>
        <button type="button" class="btn-secondary" data-acao="link" data-id="${f.id}">Link e QR code</button>
        <button type="button" class="btn-secondary" data-acao="editar" data-id="${f.id}">Editar</button>
      </div>
    </article>`).join('')}</div>`;
}

// ================= LINK / QR =================
function carregarQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  return new Promise((ok, falha) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js'; s.onload = () => ok(window.qrcode); s.onerror = falha; document.head.appendChild(s); });
}
async function telaLink(id) {
  let f;
  try { f = await apiFetch(`/formularios/${id}`); } catch (err) { toast(err.message, 'erro'); return telaLista(); }   // completo (com a arte)
  const url = linkPublico(f.token);
  const msg = `${f.titulo}

Responda pelo link (não precisa de login):
${url}`;
  $('fm-novo').classList.add('hidden');
  $('fm-tela').innerHTML = `
    <div class="fm-barra fm-no-print"><button type="button" class="btn-secondary" data-acao="lista">← Voltar</button>
      <span class="fm-barra-dir"><button type="button" class="btn-primary" data-acao="imprimir-cartaz">Imprimir cartaz A4</button></span></div>
    <section class="card fm-card fm-link fm-no-print">
      <h2>${esc(f.titulo)}</h2>
      <p class="fm-dica">Mande este link para os alunos. Eles respondem do celular ou do computador, sem login.</p>
      <div class="fm-link-url"><input type="text" readonly value="${esc(url)}" aria-label="Link do formulário"><button type="button" class="btn-primary" data-acao="copiar-link" data-url="${esc(url)}">Copiar link</button></div>
      <div class="fm-link-botoes">
        <a class="btn-secondary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">Mandar no WhatsApp</a>
        <a class="btn-secondary" target="_blank" rel="noopener" href="${esc(url)}">Abrir como o aluno vê</a>
        <button type="button" class="btn-secondary" data-acao="baixar-qr">Baixar QR code</button>
      </div>
      <h3 class="fm-cartaz-tit">Cartaz para imprimir (A4)</h3>
    </section>
    <!-- Cartaz A4 (12/11/2026): pra fixar em mural/sala — logos, arte, título, texto, QR grande e o link -->
    <article class="fm-cartaz" id="fm-cartaz">
      <header class="fm-cartaz-cab">
        <span class="fm-marca"><span class="fm-orb">F<i></i></span><b>ÓRBITA</b><em>FATEC</em></span>
        <img src="/img/fatec-ivp-horizontal.png" alt="Fatec Ivaiporã">
      </header>
      ${f.capa ? `<img class="fm-cartaz-arte" src="${f.capa}" alt="Arte do evento">` : ''}
      <h1>${esc(f.titulo)}</h1>
      ${f.descricao ? `<p class="fm-cartaz-desc">${esc(f.descricao)}</p>` : ''}
      <div class="fm-cartaz-qr"><div id="fm-qr" class="fm-qr" aria-label="QR code do link"></div>
        <div class="fm-cartaz-instr"><b>Aponte a câmera do celular para o código</b><span>e responda na hora, sem precisar de login.</span>${f.fechaEm ? `<span class="fm-cartaz-prazo">Responda até ${dataBR(f.fechaEm)}</span>` : ''}</div></div>
      <p class="fm-cartaz-link">Ou acesse: <b>${esc(url)}</b></p>
    </article>`;
  try {
    const qrcode = await carregarQr();
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    $('fm-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    $('fm-qr').dataset.png = qr.createDataURL(10, 4);
  } catch (e) { $('fm-qr').innerHTML = '<p class="fm-dica">Não foi possível gerar o QR code agora.</p>'; }
}

// ================= EDITOR =================
let edit = null;   // { id?, titulo, descricao, capa, perguntas, identificacao, umaPorPessoa, abreEm, fechaEm, ativo, respostas }
async function telaEditor(id) {
  $('fm-novo').classList.add('hidden');
  if (id) {
    try { edit = await apiFetch(`/formularios/${id}`); } catch (err) { toast(err.message, 'erro'); return telaLista(); }
  } else {
    edit = { titulo: '', descricao: '', capa: null, identificacao: 'identificado', umaPorPessoa: true, abreEm: '', fechaEm: '', ativo: true, respostas: 0,
      perguntas: [{ id: novoId(), tipo: 'curta', texto: '', obrigatoria: true, opcoes: [] }] };
  }
  desenharEditor();
}
function desenharEditor() {
  const e = edit;
  const temResp = (e.respostas || 0) > 0;
  $('fm-tela').innerHTML = `
    <div class="fm-barra fm-no-print"><button type="button" class="btn-secondary" data-acao="lista">← Voltar</button>
      <span class="fm-dica">${e.id ? `Editando · ${e.respostas || 0} resposta(s) recebida(s)${temResp ? ' — perguntas já respondidas não podem ser apagadas' : ''}` : 'Novo formulário'}</span></div>
    <div class="fm-editor">
      <section class="card fm-card">
        <label class="fm-campo">Título<input type="text" id="ed-titulo" maxlength="150" value="${esc(e.titulo)}" placeholder="Ex.: Inscrição — Semana Acadêmica 2027"></label>
        <label class="fm-campo">Descrição (aparece no topo, opcional)<textarea id="ed-descricao" rows="3" maxlength="2000">${esc(e.descricao || '')}</textarea></label>
        <div class="fm-capa">
          <div class="fm-capa-prev">${e.capa ? `<img src="${e.capa}" alt="Arte do formulário">` : '<span>Sem arte</span>'}</div>
          <div><b>Arte do evento (capa)</b><p class="fm-dica">Aparece no topo do formulário. JPG ou PNG; a imagem é reduzida sozinha.</p>
            <label class="btn-secondary fm-arquivo">Escolher imagem<input type="file" id="ed-capa" accept="image/png,image/jpeg,image/webp"></label>
            ${e.capa ? '<button type="button" class="btn-link" data-acao="tirar-capa">Tirar imagem</button>' : ''}</div>
        </div>
      </section>

      <section class="card fm-card fm-config">
        <h3>Configuração</h3>
        <fieldset class="fm-escolha"><legend>Quem responde se identifica?</legend>
          <label><input type="radio" name="ed-ident" value="identificado" ${e.identificacao === 'identificado' ? 'checked' : ''}> Identificado (nome, curso e período)</label>
          <label><input type="radio" name="ed-ident" value="anonimo" ${e.identificacao !== 'identificado' ? 'checked' : ''}> Anônimo</label>
        </fieldset>
        <label class="fm-check"><input type="checkbox" id="ed-uma" ${e.umaPorPessoa ? 'checked' : ''}> Só uma resposta por pessoa <small>(se responder de novo, a resposta é atualizada)</small></label>
        <div class="fm-datas">
          <label class="fm-campo">Abre em<input type="date" id="ed-abre" value="${esc(e.abreEm || '')}"></label>
          <label class="fm-campo">Fecha em<input type="date" id="ed-fecha" value="${esc(e.fechaEm || '')}"></label>
        </div>
        <label class="fm-check"><input type="checkbox" id="ed-ativo" ${e.ativo !== false ? 'checked' : ''}> Recebendo respostas <small>(desmarque para encerrar agora)</small></label>
      </section>

      <section class="fm-perguntas" id="ed-perguntas">${e.perguntas.map((p, i) => blocoPergunta(p, i)).join('')}</section>
      <button type="button" class="btn-secondary fm-add" data-acao="add-pergunta">+ Adicionar pergunta</button>

      <div class="fm-salvar fm-no-print">
        ${e.id ? '<button type="button" class="btn-link fm-perigo" data-acao="excluir">Excluir formulário</button>' : ''}
        <button type="button" class="btn-secondary" data-acao="lista">Cancelar</button>
        <button type="button" class="btn-primary" data-acao="salvar">Salvar formulário</button>
      </div>
    </div>`;
}
function blocoPergunta(p, i) {
  const comOpcoes = ['unica', 'multipla'].includes(p.tipo);
  return `<article class="card fm-pergunta" data-i="${i}">
    <div class="fm-p-topo"><span class="fm-p-num">${i + 1}</span>
      <select class="select-filter fm-p-tipo" data-campo="tipo" aria-label="Tipo da pergunta">${TIPOS.map(([v, r]) => `<option value="${v}" ${p.tipo === v ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <label class="fm-check"><input type="checkbox" data-campo="obrigatoria" ${p.obrigatoria ? 'checked' : ''}> Obrigatória</label>
      <span class="fm-p-ordem"><button type="button" class="btn-link" data-acao="subir" title="Subir" aria-label="Subir pergunta">↑</button><button type="button" class="btn-link" data-acao="descer" title="Descer" aria-label="Descer pergunta">↓</button><button type="button" class="btn-link fm-perigo" data-acao="remover" title="Remover" aria-label="Remover pergunta">Remover</button></span>
    </div>
    <label class="fm-campo">Pergunta<textarea data-campo="texto" rows="2" maxlength="600" placeholder="Escreva a pergunta">${esc(p.texto)}</textarea></label>
    ${comOpcoes ? `<label class="fm-campo">Opções (uma por linha)<textarea data-campo="opcoes" rows="${Math.max(3, p.opcoes.length + 1)}" placeholder="Opção 1&#10;Opção 2">${esc((p.opcoes || []).join('\n'))}</textarea></label>` : ''}
    ${p.tipo === 'escala' ? '<p class="fm-dica">O aluno escolhe de 1 (pouco) a 5 (muito).</p>' : ''}
  </article>`;
}
function lerEditor() {
  edit.titulo = $('ed-titulo').value.trim();
  edit.descricao = $('ed-descricao').value.trim();
  edit.identificacao = document.querySelector('input[name="ed-ident"]:checked').value;
  edit.umaPorPessoa = $('ed-uma').checked;
  edit.abreEm = $('ed-abre').value; edit.fechaEm = $('ed-fecha').value;
  edit.ativo = $('ed-ativo').checked;
  document.querySelectorAll('.fm-pergunta').forEach(el => {
    const p = edit.perguntas[Number(el.dataset.i)];
    p.tipo = el.querySelector('[data-campo="tipo"]').value;
    p.obrigatoria = el.querySelector('[data-campo="obrigatoria"]').checked;
    p.texto = el.querySelector('[data-campo="texto"]').value.trim();
    const op = el.querySelector('[data-campo="opcoes"]');
    if (op) p.opcoes = op.value.split('\n').map(s => s.trim()).filter(Boolean);
  });
}
function reduzirImagem(arq) {
  return new Promise((ok, falha) => {
    const url = URL.createObjectURL(arq);
    const img = new Image();
    img.onload = () => {
      const max = 1400, esc = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * esc); c.height = Math.round(img.height * esc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let q = 0.85, d = c.toDataURL('image/jpeg', q);
      while (d.length > 850000 && q > 0.4) { q -= 0.1; d = c.toDataURL('image/jpeg', q); }
      ok(d);
    };
    img.onerror = () => { URL.revokeObjectURL(url); falha(new Error('Não consegui abrir essa imagem.')); };
    img.src = url;
  });
}
async function salvar(btn) {
  lerEditor();
  btn.disabled = true;
  try {
    const corpo = { titulo: edit.titulo, descricao: edit.descricao, capa: edit.capa || null, perguntas: edit.perguntas, identificacao: edit.identificacao, umaPorPessoa: edit.umaPorPessoa, abreEm: edit.abreEm || null, fechaEm: edit.fechaEm || null, ativo: edit.ativo };
    const r = edit.id ? await apiFetch(`/formularios/${edit.id}`, { method: 'PUT', body: JSON.stringify(corpo) }) : await apiFetch('/formularios', { method: 'POST', body: JSON.stringify(corpo) });
    toast('Formulário salvo.');
    lista = await apiFetch('/formularios');
    telaLink(r.id);
  } catch (err) { toast(err.message, 'erro'); }
  finally { btn.disabled = false; }
}

// ================= RESPOSTAS =================
let rd = null;       // { formulario, respostas }
let filtro = { curso: '', periodo: '', de: '', ate: '', pergunta: '', valor: '' };
async function telaRespostas(id) {
  $('fm-novo').classList.add('hidden');
  $('fm-tela').innerHTML = '<p class="fm-carregando">Carregando as respostas…</p>';
  try { rd = await apiFetch(`/formularios/${id}/respostas`); }
  catch (err) { $('fm-tela').innerHTML = `<p class="fm-erro">${esc(err.message)}</p>`; return; }
  filtro = { curso: '', periodo: '', de: '', ate: '', pergunta: '', valor: '' };
  desenharRespostas();
}
const valorTexto = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
function filtradas() {
  return rd.respostas.filter(r => {
    if (filtro.curso && (r.pessoa?.curso || '') !== filtro.curso) return false;
    if (filtro.periodo && (r.pessoa?.periodo || '') !== filtro.periodo) return false;
    const dia = String(r.criadoEm || '').slice(0, 10);
    if (filtro.de && dia < filtro.de) return false;
    if (filtro.ate && dia > filtro.ate) return false;
    if (filtro.pergunta && filtro.valor) {
      const v = r.respostas[filtro.pergunta];
      if (Array.isArray(v) ? !v.includes(filtro.valor) : String(v ?? '') !== filtro.valor) return false;
    }
    return true;
  });
}
function opcoesDa(p) {
  if (p.tipo === 'unica' || p.tipo === 'multipla') return p.opcoes;
  if (p.tipo === 'escala') return ['1', '2', '3', '4', '5'];
  if (p.tipo === 'simnao') return ['Sim', 'Não'];
  return null;
}
function resumoPergunta(p, lst) {
  const ops = opcoesDa(p);
  const ident = rd.formulario.identificacao === 'identificado';
  const quem = (r) => (r.pessoa ? `${r.pessoa.nome}${r.pessoa.curso ? ` (${r.pessoa.curso}${r.pessoa.periodo ? ` ${r.pessoa.periodo}` : ''})` : ''}` : '');
  const comResp = lst.filter(r => { const v = r.respostas[p.id]; return v !== undefined && v !== '' && !(Array.isArray(v) && !v.length); });
  if (ops) {
    const porOp = Object.fromEntries(ops.map(o => [o, []]));
    comResp.forEach(r => { const v = r.respostas[p.id]; (Array.isArray(v) ? v : [String(v)]).forEach(o => { if (porOp[o]) porOp[o].push(r); }); });
    const base = p.tipo === 'multipla' ? lst.length : comResp.length;
    const media = p.tipo === 'escala' && comResp.length ? (comResp.reduce((n, r) => n + Number(r.respostas[p.id]), 0) / comResp.length).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : null;
    // nos identificados, cada opção mostra QUEM marcou (ex.: quem vai pra Hidratação)
    return `<div class="fm-barras">${ops.map(o => { const n = porOp[o].length; const pc = base ? Math.round(n / base * 100) : 0;
      return `<div class="fm-barra-l"><span class="fm-barra-rot">${esc(o)}</span><span class="fm-barra-trilho"><i style="width:${pc}%"></i></span><span class="fm-barra-n"><b>${n}</b> · ${pc}%</span></div>
        ${ident && n ? `<details class="fm-nomes"><summary>ver nomes (${n})</summary><ol>${porOp[o].map(r => `<li>${esc(quem(r))}</li>`).join('')}</ol></details>` : ''}`; }).join('')}</div>
      <p class="fm-dica">${comResp.length} ${comResp.length === 1 ? 'resposta' : 'respostas'}${media ? ` · média <b>${media}</b> de 5` : ''}${p.tipo === 'multipla' ? ' · pode marcar mais de uma' : ''}</p>`;
  }
  const max = p.tipo === 'longa' ? 200 : (ident ? 500 : 5);
  const linha = (r) => { const v = r.respostas[p.id]; const t = p.tipo === 'data' ? dataBR(v) : valorTexto(v); return ident ? `<li><b>${esc(r.pessoa?.nome || '')}</b> — ${esc(t)}</li>` : `<li>${esc(t)}</li>`; };
  return `<p class="fm-dica">${comResp.length} ${comResp.length === 1 ? 'resposta' : 'respostas'}${comResp.length > max ? ' · veja todas na tabela abaixo' : ''}</p>
    <ul class="fm-textos">${comResp.slice(0, max).map(linha).join('') || '<li class="fm-dica">Ninguém respondeu.</li>'}</ul>`;
}
function desenharRespostas() {
  const f = rd.formulario, lst = filtradas();
  const ident = f.identificacao === 'identificado';
  const cursos = [...new Set(rd.respostas.map(r => r.pessoa?.curso).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const periodos = [...new Set(rd.respostas.map(r => r.pessoa?.periodo).filter(Boolean))].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const perguntasFiltro = f.perguntas.filter(p => opcoesDa(p));
  const pSel = f.perguntas.find(p => p.id === filtro.pergunta);
  const ultima = rd.respostas.length ? dataHora(rd.respostas[rd.respostas.length - 1].criadoEm) : '';
  const filtrosAtivos = [filtro.curso && `Curso: ${filtro.curso}`, filtro.periodo && `Período: ${filtro.periodo}`, (filtro.de || filtro.ate) && `Data: ${filtro.de ? dataBR(filtro.de) : '…'} a ${filtro.ate ? dataBR(filtro.ate) : '…'}`, pSel && filtro.valor && `"${pSel.texto.slice(0, 40)}" = ${filtro.valor}`].filter(Boolean);
  $('fm-tela').innerHTML = `
    <div class="fm-barra fm-no-print">
      <button type="button" class="btn-secondary" data-acao="lista">← Voltar</button>
      <span class="fm-barra-dir"><button type="button" class="btn-secondary" data-acao="atualizar-resp" data-id="${f.id}">Atualizar</button><button type="button" class="btn-secondary" data-acao="excel">Exportar Excel</button><button type="button" class="btn-primary" data-acao="imprimir">Imprimir relatório</button></span>
    </div>
    <article class="fm-rel">
      <header class="fm-rel-cab">
        <span class="fm-marca"><span class="fm-orb">F<i></i></span><b>ÓRBITA</b><em>FATEC</em></span>
        <img src="/img/fatec-ivp-horizontal.png" alt="Fatec Ivaiporã">
      </header>
      <h2 class="fm-rel-titulo">${esc(f.titulo)}</h2>
      <p class="fm-rel-sub">${SIT_ROT[f.situacao]} · ${ident ? 'identificado' : 'anônimo'}${f.abreEm || f.fechaEm ? ` · ${f.abreEm ? dataBR(f.abreEm) : '…'} a ${f.fechaEm ? dataBR(f.fechaEm) : '…'}` : ''}</p>

      <section class="fm-numeros">
        <div><b>${lst.length}</b><span>${filtrosAtivos.length ? `respostas no filtro (de ${rd.respostas.length})` : (lst.length === 1 ? 'resposta' : 'respostas')}</span></div>
        ${ultima ? `<div><b class="fm-num-peq">${esc(ultima)}</b><span>última resposta</span></div>` : ''}
      </section>

      <section class="fm-filtros fm-no-print" aria-label="Filtros">
        ${ident ? `<label>Curso<select class="select-filter" data-filtro="curso"><option value="">Todos</option>${cursos.map(c => `<option ${filtro.curso === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label>Período<select class="select-filter" data-filtro="periodo"><option value="">Todos</option>${periodos.map(c => `<option ${filtro.periodo === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>` : ''}
        <label>De<input type="date" class="select-filter" data-filtro="de" value="${filtro.de}"></label>
        <label>Até<input type="date" class="select-filter" data-filtro="ate" value="${filtro.ate}"></label>
        ${perguntasFiltro.length ? `<label class="fm-f-larga">Quem respondeu<select class="select-filter" data-filtro="pergunta"><option value="">(qualquer pergunta)</option>${perguntasFiltro.map(p => `<option value="${p.id}" ${filtro.pergunta === p.id ? 'selected' : ''}>${esc(p.texto.slice(0, 60))}</option>`).join('')}</select></label>
        ${pSel ? `<label>Resposta<select class="select-filter" data-filtro="valor"><option value="">Qualquer</option>${opcoesDa(pSel).map(o => `<option ${filtro.valor === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>` : ''}` : ''}
        ${filtrosAtivos.length ? '<button type="button" class="btn-link" data-acao="limpar-filtros">Limpar filtros</button>' : ''}
      </section>
      ${filtrosAtivos.length ? `<p class="fm-filtro-ativo">Filtro: ${esc(filtrosAtivos.join(' · '))}</p>` : ''}

      <h3 class="fm-sec">Resumo por pergunta</h3>
      ${f.perguntas.map((p, i) => `<section class="fm-res-p"><h4><span>${i + 1}.</span> ${esc(p.texto)} <small>${TIPO_ROT[p.tipo]}</small></h4>${resumoPergunta(p, lst)}</section>`).join('')}

      <h3 class="fm-sec">Respostas (${lst.length})</h3>
      <div class="fm-tab-wrap"><table class="fm-tab"><thead><tr><th>#</th><th>Data</th>${ident ? '<th>Nome</th><th>Curso</th><th>Per.</th>' : ''}${f.perguntas.map((p, i) => `<th title="${esc(p.texto)}">${i + 1}. ${esc(p.texto.slice(0, 40))}${p.texto.length > 40 ? '…' : ''}</th>`).join('')}</tr></thead>
        <tbody>${lst.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(dataHora(r.criadoEm))}</td>${ident ? `<td>${esc(r.pessoa?.nome || '')}</td><td>${esc(r.pessoa?.curso || '')}</td><td>${esc(r.pessoa?.periodo || '')}</td>` : ''}${f.perguntas.map(p => `<td>${esc(p.tipo === 'data' ? dataBR(r.respostas[p.id]) : valorTexto(r.respostas[p.id]))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${2 + (ident ? 3 : 0) + f.perguntas.length}" class="fm-dica">Nenhuma resposta${filtrosAtivos.length ? ' com esse filtro' : ' ainda'}.</td></tr>`}</tbody></table></div>
      <p class="fm-rel-rodape">Emitido em ${esc(dataHora(new Date().toISOString()))} pelo Órbita · Formulários${filtrosAtivos.length ? ` · ${esc(filtrosAtivos.join(' · '))}` : ''}.</p>
    </article>`;
}
function exportarExcel() {
  const f = rd.formulario, lst = filtradas(), ident = f.identificacao === 'identificado';
  const cel = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cab = ['Data', ...(ident ? ['Nome', 'Curso', 'Período'] : []), ...f.perguntas.map(p => p.texto)];
  const linhas = lst.map(r => [dataHora(r.criadoEm), ...(ident ? [r.pessoa?.nome, r.pessoa?.curso, r.pessoa?.periodo] : []), ...f.perguntas.map(p => (p.tipo === 'data' ? dataBR(r.respostas[p.id]) : valorTexto(r.respostas[p.id])))]);
  const csv = '﻿' + [cab, ...linhas].map(l => l.map(cel).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${f.titulo.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60) || 'formulario'} - respostas.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}

// ================= EVENTOS =================
function ligarEventos() {
  $('fm-novo').addEventListener('click', () => telaEditor(null));
  $('fm-tela').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-acao]');
    if (!b) return;
    const ac = b.dataset.acao;
    if (ac === 'novo') return telaEditor(null);
    if (ac === 'lista') return telaLista();
    if (ac === 'respostas' || ac === 'atualizar-resp') return telaRespostas(b.dataset.id);
    if (ac === 'link') return telaLink(b.dataset.id);
    if (ac === 'editar') return telaEditor(b.dataset.id);
    if (ac === 'copiar-link') { if (await copiar(b.dataset.url)) toast('Link copiado.'); return; }
    if (ac === 'imprimir-cartaz') {
      document.body.classList.add('fm-so-cartaz');
      const limpar = () => { document.body.classList.remove('fm-so-cartaz'); window.removeEventListener('afterprint', limpar); };
      window.addEventListener('afterprint', limpar);
      return window.print();
    }
    if (ac === 'baixar-qr') { const png = $('fm-qr').dataset.png; if (png) { const a = document.createElement('a'); a.href = png; a.download = 'qrcode-formulario.png'; a.click(); } return; }
    if (ac === 'imprimir') { document.querySelectorAll('.fm-nomes').forEach(d => { d.open = true; }); return window.print(); }
    if (ac === 'excel') return exportarExcel();
    if (ac === 'limpar-filtros') { filtro = { curso: '', periodo: '', de: '', ate: '', pergunta: '', valor: '' }; return desenharRespostas(); }
    // editor
    if (!edit) return;
    if (ac === 'salvar') return salvar(b);
    lerEditor();
    const el = b.closest('.fm-pergunta');
    const i = el ? Number(el.dataset.i) : -1;
    if (ac === 'add-pergunta') edit.perguntas.push({ id: novoId(), tipo: 'curta', texto: '', obrigatoria: false, opcoes: [] });
    if (ac === 'remover' && i >= 0) {
      if (edit.perguntas.length === 1) return toast('O formulário precisa de pelo menos uma pergunta.', 'erro');
      if (!b.dataset.confirma) { b.dataset.confirma = '1'; b.textContent = 'Confirmar'; return; }
      edit.perguntas.splice(i, 1);
    }
    if (ac === 'subir' && i > 0) [edit.perguntas[i - 1], edit.perguntas[i]] = [edit.perguntas[i], edit.perguntas[i - 1]];
    if (ac === 'descer' && i >= 0 && i < edit.perguntas.length - 1) [edit.perguntas[i + 1], edit.perguntas[i]] = [edit.perguntas[i], edit.perguntas[i + 1]];
    if (ac === 'tirar-capa') edit.capa = null;
    if (ac === 'excluir') {
      if (!b.dataset.confirma) { b.dataset.confirma = '1'; b.textContent = `Confirmar exclusão${edit.respostas ? ` (apaga ${edit.respostas} resposta(s))` : ''}`; return; }
      try { const r = await apiFetch(`/formularios/${edit.id}`, { method: 'DELETE' }); toast(r.message); edit = null; return telaLista(); }
      catch (err) { return toast(err.message, 'erro'); }
    }
    desenharEditor();
  });
  $('fm-tela').addEventListener('change', async (e) => {
    if (e.target.id === 'ed-capa' && e.target.files[0]) {
      lerEditor();
      try { edit.capa = await reduzirImagem(e.target.files[0]); desenharEditor(); }
      catch (err) { toast(err.message, 'erro'); }
      return;
    }
    if (e.target.matches('[data-campo="tipo"]')) { lerEditor(); return desenharEditor(); }
    const fl = e.target.dataset.filtro;
    if (fl) {
      filtro[fl] = e.target.value;
      if (fl === 'pergunta') filtro.valor = '';
      desenharRespostas();
    }
  });
}

// ================= LOGIN =================
async function initApp(user, role) {
  appInitialized = true; initializedRole = role;
  setupLayout(user, role, MODULO, async () => { clearCachedAuth(); await signOut(auth); location.href = '../../auth/login.html'; });
  $('auth-guard').classList.add('hidden');
  $('app').classList.remove('hidden');
  ligarEventos();
  telaLista();
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
  if (nivel < 3) { location.href = '../../meu-espaco/index.html'; return; }
  if (!appInitialized || initializedRole !== role) initApp(user, role);
});
