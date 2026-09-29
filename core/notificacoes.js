// ==========================================================================
// Notificações do Órbita (nível 1 — enquanto o Órbita está aberto, em
// qualquer tela; pedido 29/09):
//  - Ao entrar: "📢 Você tem N aviso(s) novo(s)" (Quadro de Avisos do setor).
//  - Lembrete 30 e 10 min antes das atividades da pessoa (agenda do Meu
//    Espaço), no Órbita e como notificação do sistema (Windows/celular) se a
//    pessoa permitir — funciona com a aba minimizada, não com o navegador
//    fechado (isso seria push de verdade / FCM, fora deste escopo).
// Economia de leitura: busca avisos+atividades ao entrar e a cada 15 min, e
// divide o resultado entre abas abertas (cache no localStorage); os
// lembretes são conferidos a cada 30s em cima do que já foi baixado.
// ==========================================================================
import { getApps } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

const API_BASE = (location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.'))
  ? `http://${location.hostname}:3000/api`
  : '/api';

const MINUTOS_ANTES = [30, 10];
const RECARREGAR_MS = 15 * 60 * 1000;   // busca no servidor
const CACHE_FRESCO_MS = 10 * 60 * 1000; // outra aba buscou há pouco? usa o dela
const CONFERIR_MS = 30 * 1000;          // confere lembretes (sem ler o banco)

const K_CACHE = 'orbita_notif_cache';
const K_SISTEMA = 'orbita_notif_sistema_enviadas'; // notificação do Windows: 1x por item
const K_FECHADOS = 'orbita_notif_fechadas';         // lembrete fechado no × (não volta)
const K_PERM_DISPENSADA = 'orbita_notif_perm_dispensada';
const K_AVISOS_SESSAO = 'orbita_avisos_dispensados'; // aviso fechado no × (só até sair)
const K_ADIADOS = 'orbita_lembretes_adiados';        // "lembrar de novo" sem mudar o horário
const MAX_AVISOS_SEPARADOS = 3;

// Cargos que não usam Meu Espaço (só Banco de Questões) — nada a avisar.
const CARGOS_SEM_MEU_ESPACO = ['coord_medicina', 'professor_medicina'];

let iniciado = false;
let meuUid = null;
let atividades = [];
let pegarToken = null;

const ler = (store, k, padrao) => { try { return JSON.parse(store.getItem(k)) ?? padrao; } catch (e) { return padrao; } };
const gravar = (store, k, v) => { try { store.setItem(k, JSON.stringify(v)); } catch (e) {} };
const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };

export function iniciarNotificacoes(role) {
  if (iniciado || CARGOS_SEM_MEU_ESPACO.includes(role)) return;
  iniciado = true;
  injetarEstilo();
  const app = getApps()[0];
  if (!app) return;
  const auth = getAuth(app);
  auth.authStateReady().then(async () => {
    if (!auth.currentUser) return;
    meuUid = auth.currentUser.uid;
    const token = () => auth.currentUser.getIdToken();
    pegarToken = token;
    await atualizar(token);
    oferecerPermissao();
    setInterval(() => atualizar(token), RECARREGAR_MS);
    setInterval(conferirLembretes, CONFERIR_MS);
  });
}

async function apiGet(endpoint, token) {
  const res = await fetch(`${API_BASE}${endpoint}`, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}

async function atualizar(token) {
  let dados = ler(localStorage, K_CACHE, null);
  if (!dados || dados.uid !== meuUid || Date.now() - dados.ts > CACHE_FRESCO_MS) {
    const [avisos, ats] = await Promise.all([
      apiGet('/processos/avisos', token).catch(() => []),
      apiGet('/processos/atividades', token).catch(() => null)
    ]);
    if (ats === null) return; // sem conexão/token: tenta na próxima rodada
    dados = { uid: meuUid, ts: Date.now(), avisos, atividades: ats };
    gravar(localStorage, K_CACHE, dados);
  }
  atividades = dados.atividades || [];
  avisarAvisosNovos(dados.avisos || []);
  conferirLembretes();
}

// ---------- Avisos não lidos do Quadro de Avisos ----------
// Cada aviso aparece com "✓ Li" (mesmo "Li" do mural — o autor vê quem leu)
// e fica aparecendo em toda tela até a pessoa marcar Li, ou fechar no ×
// (aí some só até sair do Órbita).
function avisarAvisosNovos(avisos) {
  const dispensados = new Set(ler(sessionStorage, K_AVISOS_SESSAO, []));
  const pendentes = avisos.filter(a => !a.jaLi && a.autorUid !== meuUid && !dispensados.has(a.id));
  pendentes.slice(0, MAX_AVISOS_SEPARADOS).forEach(a => mostrar({
    titulo: `📢 Aviso de ${nomeCurto(a.autorNome)}`,
    texto: (a.texto || '').slice(0, 200),
    acao: 'Ver no mural',
    link: '/meu-espaco/index.html#avisos-section',
    tag: `aviso|${a.id}`,
    classe: 'notif-aviso',
    avisoId: a.id,
    aoFechar: () => { dispensados.add(a.id); gravar(sessionStorage, K_AVISOS_SESSAO, [...dispensados]); }
  }));
  const resto = pendentes.length - MAX_AVISOS_SEPARADOS;
  if (resto > 0) {
    mostrar({ titulo: `📢 Mais ${resto} aviso(s) não lido(s)`, texto: 'Veja todos no Quadro de Avisos do Meu Espaço.', acao: 'Abrir mural', link: '/meu-espaco/index.html#avisos-section', tag: 'avisos-resto', classe: 'notif-aviso' });
  }
}

function nomeCurto(nome) {
  const p = (nome || 'Alguém').trim().split(/\s+/)[0];
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

// Chamado pelo mural do Meu Espaço quando a pessoa marca "Li"/"Tirar da
// tela" por lá: some a notificação e o cache não mostra de novo.
export function avisoResolvidoNoMural(avisoId) {
  const cache = ler(localStorage, K_CACHE, null);
  if (cache && Array.isArray(cache.avisos)) {
    cache.avisos = cache.avisos.map(a => a.id === avisoId ? { ...a, jaLi: true } : a);
    gravar(localStorage, K_CACHE, cache);
  }
  document.querySelector(`#orbita-notificacoes [data-tag="${CSS.escape('aviso|' + avisoId)}"]`)?.remove();
}

async function marcarLido(avisoId, el) {
  const btn = el.querySelector('.orbita-notif-li');
  if (btn) { btn.disabled = true; btn.textContent = '✓ Lido'; }
  try {
    const res = await fetch(`${API_BASE}/processos/avisos/${avisoId}/lido`, { method: 'PATCH', headers: { Authorization: `Bearer ${await pegarToken()}` } });
    if (!res.ok) throw new Error(res.status);
    // Atualiza o cache compartilhado pra outras telas/abas não mostrarem de novo.
    const cache = ler(localStorage, K_CACHE, null);
    if (cache && Array.isArray(cache.avisos)) {
      cache.avisos = cache.avisos.map(a => a.id === avisoId ? { ...a, jaLi: true } : a);
      gravar(localStorage, K_CACHE, cache);
    }
    el.remove();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Li'; }
  }
}

// ---------- Lembretes de atividade ----------
function responsaveisDe(a) {
  if (a.uid) return [a.uid];
  return Array.isArray(a.atribuidos) ? a.atribuidos : [];
}

// Só o que é da pessoa: dela, coletiva em que está, compromisso do setor em
// que é a responsável, e atividade do setor "de todo mundo". Delegado pra
// outro e horário fixo (lab bloqueado) não geram lembrete.
function ehMinha(a) {
  if (a.fixo || a.status === 'concluido' || !a.prazo) return false;
  const resp = responsaveisDe(a);
  if (resp.includes(meuUid)) return true;
  return !!a.doSetor && resp.length === 0;
}

// Lembrete fica na tela (em toda página) até ser fechado no ×, marcado como
// feito, adiado, ou chegar o horário; o de 10 min substitui o de 30.
// "Lembrar de novo" (adiar só o lembrete) faz ele voltar na hora escolhida,
// mesmo depois do horário da atividade (até 2h depois).
function conferirLembretes() {
  if (!meuUid) return;
  const agora = Date.now();
  const fechados = ler(localStorage, K_FECHADOS, {});
  Object.keys(fechados).forEach(k => { if (fechados[k] < agora) delete fechados[k]; });
  gravar(localStorage, K_FECHADOS, fechados);
  const adiados = ler(localStorage, K_ADIADOS, {});
  Object.keys(adiados).forEach(k => { if (adiados[k].expira < agora) delete adiados[k]; });
  gravar(localStorage, K_ADIADOS, adiados);
  const ativos = new Set();
  atividades.filter(ehMinha).forEach(a => {
    const prazo = new Date(a.prazo).getTime();
    const hora = new Date(a.prazo).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const adiado = adiados[`${a.id}|${a.prazo}`];
    let chave, titulo, classe;
    if (adiado) {
      if (agora < adiado.ate) return; // ainda não é hora de lembrar de novo
      chave = `${a.id}|${a.prazo}|adiado${adiado.ate}`;
      const diff = Math.round((prazo - agora) / 60000);
      titulo = diff > 0 ? `⏰ Lembrete: em ${diff} min (${hora})` : `⏰ Lembrete: era às ${hora}`;
      classe = 'notif-urgente';
    } else {
      if (agora >= prazo) return;
      const min = MINUTOS_ANTES.slice().sort((x, y) => x - y).find(m => agora >= prazo - m * 60000);
      if (!min) return; // ainda falta mais de 30 min
      chave = `${a.id}|${a.prazo}|${min}`;
      titulo = `⏰ Em ${Math.max(1, Math.round((prazo - agora) / 60000))} min (${hora})`;
      classe = min <= 10 ? 'notif-urgente' : 'notif-lembrete';
    }
    ativos.add(chave);
    if (fechados[chave]) return;
    const existente = container().querySelector(`[data-tag="${CSS.escape(chave)}"]`);
    if (existente) { existente.querySelector('.orbita-notif-titulo').textContent = titulo; return; }
    mostrar({
      titulo,
      texto: a.titulo,
      acao: 'Abrir agenda',
      link: '/meu-espaco/index.html',
      tag: chave,
      classe,
      atividade: a,
      aoFechar: () => { const f = ler(localStorage, K_FECHADOS, {}); f[chave] = Math.max(prazo, agora) + 2 * 3600000; gravar(localStorage, K_FECHADOS, f); }
    });
  });
  // Tira da tela lembrete que venceu ou foi trocado pelo de 10 min.
  container().querySelectorAll('.orbita-notif[data-tag*="|"]').forEach(el => {
    if (!el.dataset.tag.startsWith('aviso|') && !ativos.has(el.dataset.tag)) el.remove();
  });
}

// ---------- Exibição (no Órbita + notificação do sistema) ----------
function container() {
  let c = document.getElementById('orbita-notificacoes');
  if (!c) {
    c = document.createElement('div');
    c.id = 'orbita-notificacoes';
    document.body.appendChild(c);
  }
  return c;
}

// ---------- Ações do lembrete: "✓ Feita" e "Adiar" (sem abrir o Meu Espaço) ----------
function ehCompromissoDoSetor(a) {
  return !!a.doSetor && !a.fixo && responsaveisDe(a).length > 0;
}

// Só muda o HORÁRIO da atividade quem a criou (e não é compromisso vindo de
// módulo, que é remarcado no próprio módulo). Atividade atribuída por outra
// pessoa não pode ser adiada por quem recebeu (regra do Meu Espaço) — aí o
// "Adiar" só lembra de novo mais tarde.
function podeRemarcar(a) {
  return a.criadoPor === meuUid && !ehCompromissoDoSetor(a) && !a.doSetor;
}

async function apiEnviar(metodo, endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await pegarToken()}` },
    body: JSON.stringify(body)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}

// Atualiza o cache (outras telas/abas) e avisa a tela aberta (Meu Espaço
// recarrega o quadro).
function atividadeMudou(id, mudancas) {
  atividades = atividades.map(a => a.id === id ? { ...a, ...mudancas } : a);
  const cache = ler(localStorage, K_CACHE, null);
  if (cache && Array.isArray(cache.atividades)) {
    cache.atividades = cache.atividades.map(a => a.id === id ? { ...a, ...mudancas } : a);
    gravar(localStorage, K_CACHE, cache);
  }
  window.dispatchEvent(new CustomEvent('orbita:atividades-alteradas', { detail: { id } }));
  conferirLembretes();
}

function mensagemNoCard(el, texto, erro = false) {
  let m = el.querySelector('.orbita-notif-msg');
  if (!m) { m = document.createElement('div'); m.className = 'orbita-notif-msg'; el.appendChild(m); }
  m.textContent = texto;
  m.classList.toggle('erro', erro);
}

async function marcarFeita(a, el) {
  el.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    await apiEnviar('PUT', `/processos/atividades/${a.id}/status`, { status: 'concluido' });
    el.remove();
    atividadeMudou(a.id, { status: 'concluido' });
  } catch (e) {
    el.querySelectorAll('button').forEach(b => { b.disabled = false; });
    mensagemNoCard(el, e.message, true);
  }
}

function isoLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function abrirAdiar(a, el) {
  let painel = el.querySelector('.orbita-notif-adiar');
  if (painel) { painel.remove(); return; }
  const remarca = podeRemarcar(a);
  const prazoAtual = new Date(a.prazo);
  const base = Math.max(Date.now(), prazoAtual.getTime());
  const amanha = new Date(prazoAtual); amanha.setDate(amanha.getDate() + 1);
  const opcoes = remarca
    ? [['+15 min', new Date(prazoAtual.getTime() + 15 * 60000)], ['+30 min', new Date(prazoAtual.getTime() + 30 * 60000)], ['+1 h', new Date(prazoAtual.getTime() + 3600000)], ['Amanhã', amanha]]
    : [['15 min', new Date(Date.now() + 15 * 60000)], ['30 min', new Date(Date.now() + 30 * 60000)], ['1 h', new Date(Date.now() + 3600000)]];
  painel = document.createElement('div');
  painel.className = 'orbita-notif-adiar';
  painel.innerHTML = `
    <div class="orbita-notif-adiar-titulo">${remarca ? 'Mudar o horário da atividade para:' : 'Lembrar de novo em:'}</div>
    <div class="orbita-notif-adiar-opcoes">
      ${opcoes.map(([rot], i) => `<button type="button" data-i="${i}">${rot}</button>`).join('')}
    </div>
    ${remarca ? `<div class="orbita-notif-adiar-livre"><input type="datetime-local" value="${isoLocalInput(new Date(base + 3600000))}"><button type="button" class="orbita-notif-adiar-ok">OK</button></div>` : '<div class="orbita-notif-adiar-obs">O horário da atividade não muda (foi atribuída por outra pessoa ou vem de um módulo).</div>'}`;
  el.appendChild(painel);
  const aplicar = async (quando) => {
    if (!(quando instanceof Date) || isNaN(quando)) return;
    if (!remarca) {
      const adiados = ler(localStorage, K_ADIADOS, {});
      adiados[`${a.id}|${a.prazo}`] = { ate: quando.getTime(), expira: Math.max(quando.getTime(), prazoAtual.getTime()) + 2 * 3600000 };
      gravar(localStorage, K_ADIADOS, adiados);
      el.remove();
      conferirLembretes();
      return;
    }
    painel.querySelectorAll('button, input').forEach(b => { b.disabled = true; });
    try {
      const novoPrazo = quando.toISOString();
      await apiEnviar('PUT', `/processos/atividades/${a.id}`, { prazo: novoPrazo });
      el.remove();
      atividadeMudou(a.id, { prazo: novoPrazo });
    } catch (e) {
      painel.querySelectorAll('button, input').forEach(b => { b.disabled = false; });
      mensagemNoCard(el, e.message, true);
    }
  };
  painel.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => aplicar(opcoes[Number(b.dataset.i)][1]); });
  const ok = painel.querySelector('.orbita-notif-adiar-ok');
  if (ok) ok.onclick = () => aplicar(new Date(painel.querySelector('input').value));
}

// Meu Espaço chama quando a pessoa mexe numa atividade por lá (concluiu,
// arrastou, editou) — busca de novo pra o lembrete não ficar desatualizado.
export function recarregarNotificacoes() {
  try { localStorage.removeItem(K_CACHE); } catch (e) {}
  if (pegarToken) atualizar(pegarToken);
}

function mostrar({ titulo, texto, acao, link, tag, classe, avisoId, aoFechar, atividade }) {
  const c = container();
  if (c.querySelector(`[data-tag="${CSS.escape(tag)}"]`)) return;
  const el = document.createElement('div');
  el.className = `orbita-notif ${classe || ''}`;
  el.dataset.tag = tag;
  el.innerHTML = `
    <button type="button" class="orbita-notif-fechar" title="Fechar">×</button>
    <div class="orbita-notif-titulo">${esc(titulo)}</div>
    <div class="orbita-notif-texto">${esc(texto)}</div>
    <div class="orbita-notif-rodape">
      ${avisoId ? '<button type="button" class="orbita-notif-li" title="Marcar como lido (igual ao mural)">✓ Li</button>' : ''}
      ${atividade ? '<button type="button" class="orbita-notif-li orbita-notif-feita" title="Marcar a atividade como concluída">✓ Feita</button><button type="button" class="orbita-notif-btn-adiar" title="Adiar">⏰ Adiar</button>' : ''}
      ${acao ? `<a class="orbita-notif-acao" href="${link}">${esc(acao)} →</a>` : ''}
    </div>`;
  el.querySelector('.orbita-notif-fechar').onclick = () => { if (aoFechar) aoFechar(); el.remove(); };
  if (avisoId) el.querySelector('.orbita-notif-li').onclick = () => marcarLido(avisoId, el);
  if (atividade) {
    el.querySelector('.orbita-notif-feita').onclick = () => marcarFeita(atividade, el);
    el.querySelector('.orbita-notif-btn-adiar').onclick = () => abrirAdiar(atividade, el);
  }
  c.prepend(el);
  // no máximo 5 na tela
  [...c.querySelectorAll('.orbita-notif:not(.notif-permissao)')].slice(5).forEach(x => x.remove());

  // Notificação do sistema (Windows/celular): uma vez por item, e só quando
  // a pessoa não está olhando a aba do Órbita.
  const enviadas = ler(localStorage, K_SISTEMA, {});
  if (!enviadas[tag] && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    enviadas[tag] = Date.now() + 2 * 86400000;
    Object.keys(enviadas).forEach(k => { if (enviadas[k] < Date.now()) delete enviadas[k]; });
    gravar(localStorage, K_SISTEMA, enviadas);
    try {
      const n = new Notification(titulo, { body: texto, icon: '/img/favicon.png', tag });
      n.onclick = () => { window.focus(); if (link) location.href = link; n.close(); };
    } catch (e) {}
  }
}

// Pede permissão com um convite no Órbita (o navegador bloqueia pedido
// "do nada"); "Agora não" fica lembrado.
function oferecerPermissao() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  if (localStorage.getItem(K_PERM_DISPENSADA) === '1') return;
  const c = container();
  if (c.querySelector('[data-tag="permissao"]')) return;
  const el = document.createElement('div');
  el.className = 'orbita-notif notif-permissao';
  el.dataset.tag = 'permissao';
  el.innerHTML = `
    <div class="orbita-notif-titulo">🔔 Quer ser avisado das suas atividades?</div>
    <div class="orbita-notif-texto">O Órbita avisa 30 e 10 minutos antes, mesmo com a aba minimizada.</div>
    <div class="orbita-notif-botoes">
      <button type="button" class="orbita-notif-sim">Ativar</button>
      <button type="button" class="orbita-notif-nao">Agora não</button>
    </div>`;
  el.querySelector('.orbita-notif-sim').onclick = async () => {
    el.remove();
    try { await Notification.requestPermission(); } catch (e) {}
  };
  el.querySelector('.orbita-notif-nao').onclick = () => {
    localStorage.setItem(K_PERM_DISPENSADA, '1');
    el.remove();
  };
  c.appendChild(el);
}

function injetarEstilo() {
  if (document.getElementById('orbita-notif-estilo')) return;
  const s = document.createElement('style');
  s.id = 'orbita-notif-estilo';
  s.textContent = `
    #orbita-notificacoes { position: fixed; top: 1rem; right: 1rem; z-index: 11000; display: flex; flex-direction: column; gap: 0.6rem; width: min(360px, calc(100vw - 2rem)); pointer-events: none; }
    .orbita-notif { pointer-events: auto; position: relative; background: #fff; border-radius: 14px; padding: 0.9rem 2.2rem 0.9rem 1rem; box-shadow: 0 12px 32px rgba(15, 30, 60, 0.22); border-left: 5px solid #0F4EB8; font-family: inherit; animation: orbitaNotifEntra 0.25s ease-out; }
    .orbita-notif.notif-aviso { border-left-color: #EB7025; }
    .orbita-notif.notif-lembrete { border-left-color: #0F4EB8; }
    .orbita-notif.notif-urgente { border-left-color: #EF4444; background: #fff7f7; }
    .orbita-notif.notif-permissao { border-left-color: #10B981; }
    .orbita-notif-titulo { font-weight: 800; color: #0b1f33; font-size: 0.92rem; margin-bottom: 0.25rem; }
    .orbita-notif-texto { color: #475569; font-size: 0.84rem; white-space: pre-line; line-height: 1.4; }
    .orbita-notif-rodape { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.5rem; }
    .orbita-notif-rodape:empty { display: none; }
    .orbita-notif-li { border: 1px solid #10B981; background: #ecfdf5; color: #047857; border-radius: 20px; padding: 0.25rem 0.75rem; font-weight: 800; font-size: 0.78rem; cursor: pointer; font-family: inherit; }
    .orbita-notif-li:hover { background: #10B981; color: #fff; }
    .orbita-notif-li:disabled { opacity: 0.7; cursor: default; }
    .orbita-notif-acao { display: inline-block; font-size: 0.8rem; font-weight: 800; color: #0F4EB8; text-decoration: none; }
    .orbita-notif-rodape { flex-wrap: wrap; }
    .orbita-notif-btn-adiar { border: 1px solid #cbd5e1; background: #fff; color: #334155; border-radius: 20px; padding: 0.25rem 0.75rem; font-weight: 800; font-size: 0.78rem; cursor: pointer; font-family: inherit; }
    .orbita-notif-btn-adiar:hover { border-color: #0F4EB8; color: #0F4EB8; }
    .orbita-notif-adiar { margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px dashed #e2e8f0; }
    .orbita-notif-adiar-titulo { font-size: 0.75rem; font-weight: 800; color: #475569; margin-bottom: 0.4rem; }
    .orbita-notif-adiar-opcoes { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .orbita-notif-adiar-opcoes button, .orbita-notif-adiar-ok { border: 1px solid #bfdbfe; background: #eff6ff; color: #0F4EB8; border-radius: 8px; padding: 0.3rem 0.6rem; font-weight: 800; font-size: 0.76rem; cursor: pointer; font-family: inherit; }
    .orbita-notif-adiar-opcoes button:hover, .orbita-notif-adiar-ok:hover { background: #0F4EB8; color: #fff; }
    .orbita-notif-adiar-livre { display: flex; gap: 0.35rem; margin-top: 0.45rem; }
    .orbita-notif-adiar-livre input { flex: 1; min-width: 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.25rem 0.4rem; font-family: inherit; font-size: 0.78rem; }
    .orbita-notif-adiar-obs { font-size: 0.72rem; color: #64748b; margin-top: 0.45rem; }
    .orbita-notif-msg { margin-top: 0.45rem; font-size: 0.75rem; font-weight: 700; color: #047857; }
    .orbita-notif-msg.erro { color: #b91c1c; }
    .orbita-notif-acao:hover { text-decoration: underline; }
    .orbita-notif-fechar { position: absolute; top: 0.4rem; right: 0.55rem; border: none; background: none; font-size: 1.2rem; color: #94a3b8; cursor: pointer; line-height: 1; }
    .orbita-notif-botoes { display: flex; gap: 0.5rem; margin-top: 0.65rem; }
    .orbita-notif-botoes button { border: 1px solid #e2e8f0; background: #fff; border-radius: 8px; padding: 0.4rem 0.8rem; font-weight: 700; font-size: 0.8rem; cursor: pointer; font-family: inherit; }
    .orbita-notif-sim { background: #10B981 !important; border-color: #10B981 !important; color: #fff; }
    @keyframes orbitaNotifEntra { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
    @media print { #orbita-notificacoes { display: none !important; } }
  `;
  document.head.appendChild(s);
}
