// Envios das Matrículas (12/11/2026): fechamento do dia (e-mail "MATRÍCULAS dd/mm" + feed do WhatsApp) e os
// e-mails de trancamento e cancelamento. Nada é enviado daqui: o Gmail abre com tudo preenchido (ou copia o
// texto) e a pessoa confere e envia. Modelos e destinatários = os e-mails que o setor já mandava.
let ctx = null;   // { apiFetch, esc, showToast }
const $ = (id) => document.getElementById(id);

// ---- destinatários (os mesmos dos e-mails de hoje) ----
const PARA_MATRICULAS = [
  'centralcomercial@fatecivaipora.com.br', 'admin@rhemaeducacao.com.br', 'secretaria1@fatecivaipora.com.br',
  'comercial@rhemaeducacao.com.br', 'centralfinanceiro@fatecivaipora.com.br', 'prouni@fatecivaipora.com.br',
  'financeiro2@fatecivaipora.com.br', 'secretariageral@fatecivaipora.com.br', 'mariana.bastos@rhemaneuroeducacao.com.br',
  'fabio@rhemaneuroeducacao.com.br', 'direcaoadministrativa@fatecivaipora.com.br', 'comercial@fatecivaipora.com.br',
  'secretaria3@fatecivaipora.com.br', 'direcaoacademica@fatecivaipora.com.br', 'rh@rhemaneuroeducacao.com.br'
];
// trancamento e cancelamento: + o coordenador do curso do aluno
const PARA_SAIDA = [
  'secretariageral@fatecivaipora.com.br', 'centralcomercial@fatecivaipora.com.br', 'mariana.bastos@rhemaneuroeducacao.com.br',
  'financeiro2@fatecivaipora.com.br', 'financeiro1@fatecivaipora.com.br', 'secretaria2@fatecivaipora.com.br',
  'suporte.ava@fatecivaipora.com.br', 'direcaoadministrativa@fatecivaipora.com.br', 'rh@rhemaneuroeducacao.com.br',
  'fabio@rhemaneuroeducacao.com.br', 'secretaria3@fatecivaipora.com.br', 'direcaoacademica@fatecivaipora.com.br',
  'daisy.grella@rhemaneuroeducacao.com.br'
];

const saudacao = () => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; };
const ddmm = (iso) => { const [, m, d] = String(iso).split('-'); return `${d}/${m}`; };
const semBR = (s) => String(s || '').replace('.', '/');
const real = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percBR = (p) => Number(p || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const dois = (n) => String(n).padStart(2, '0');
function fone(t) {
  const d = String(t || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(t || '').trim();
}
const linkGmail = (para, assunto, corpo) =>
  `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(para.join(','))}&su=${encodeURIComponent(assunto)}&body=${encodeURIComponent(corpo)}`;
async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; }
  catch (e) { const t = document.createElement('textarea'); t.value = texto; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok; }
}

export function iniciarEnvios(contexto) {
  ctx = contexto;
  document.querySelectorAll('.ev-aba').forEach(b => b.addEventListener('click', () => trocarAba(b.dataset.aba)));
  $('ev-semestre').addEventListener('change', () => { if (abaAtual === 'feed') carregarFeed(); });
  $('ev-atualizar').addEventListener('click', carregarFeed);
  const hojeISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  $('ev-dia').value = hojeISO; $('ev-dia').max = hojeISO;
  $('ev-dia').addEventListener('change', () => { if ($('ev-dia').value) carregarFeed(); });
  wireFeed();
  wireSaida();
  carregarSemestres().then(carregarFeed);
}

let abaAtual = 'feed';
function trocarAba(aba) {
  abaAtual = aba;
  document.querySelectorAll('.ev-aba').forEach(b => { const on = b.dataset.aba === aba; b.classList.toggle('ativa', on); b.setAttribute('aria-selected', on); });
  $('ev-painel-feed').classList.toggle('hidden', aba !== 'feed');
  $('ev-painel-saida').classList.toggle('hidden', aba === 'feed');
  $('ev-atualizar').classList.toggle('hidden', aba !== 'feed');
  $('ev-dia-wrap').classList.toggle('hidden', aba !== 'feed');
  if (aba !== 'feed') { delete $('ev-s-assunto').dataset.editado; delete $('ev-s-texto').dataset.editado; prepararSaida(aba); }
}

async function carregarSemestres() {
  const sel = $('ev-semestre');
  try {
    const { semestres } = await ctx.apiFetch('/matriculas/config/semestres');
    const lista = (semestres || []).filter(s => s >= '2026.2').sort().reverse();
    sel.innerHTML = lista.map(s => `<option value="${s}">${semBR(s)}</option>`).join('');
    sel.value = lista.includes('2027.1') ? '2027.1' : (lista[0] || '');
  } catch (e) {
    sel.innerHTML = '<option value="2027.1">2027/1</option>';
  }
}

// =================== FECHAMENTO DO DIA ===================
let feed = null;   // resposta de /envios/feed
const marcados = new Set();

async function carregarFeed() {
  $('ev-feed-lista').innerHTML = '<p class="ev-carregando">Buscando as matrículas no Edubox…</p>';
  $('ev-feed-saidas').classList.add('hidden');
  $('ev-feed-final').classList.add('hidden');
  try {
    feed = await ctx.apiFetch(`/matriculas/envios/feed?semestre=${encodeURIComponent($('ev-semestre').value)}&dia=${encodeURIComponent($('ev-dia').value || '')}`);
    marcados.clear();
    feed.alunos.filter(a => !a.enviadoEm).forEach(a => marcados.add(a.codmat));   // já enviados vêm desmarcados
    desenharFeed();
  } catch (err) {
    $('ev-feed-lista').innerHTML = `<p class="ev-erro">Não foi possível buscar: ${ctx.esc(err.message)}</p>`;
  }
}

function desenharFeed() {
  const esc = ctx.esc;
  if (!feed.alunos.length) {
    $('ev-feed-lista').innerHTML = `<p class="ev-vazio">Nenhuma matrícula para o feed de ${ddmm(feed.hoje)}: não houve matrícula nesse dia e as de ${ddmm(feed.desde)} em diante já saíram em algum feed.</p>`;
    $('ev-feed-saidas').classList.add('hidden');
    $('ev-feed-final').classList.add('hidden');
    return;
  }
  $('ev-feed-lista').innerHTML = `
    <p class="ev-dica">Feed de <b>${ddmm(feed.hoje)}</b>: matrículas desse dia e as de ${ddmm(feed.desde)} (dia anterior) que ainda não saíram em nenhum feed. Quem já foi enviado vem desmarcado. Desmarque quem não deve entrar.</p>
    <table class="ev-tabela"><thead><tr><th><input type="checkbox" id="ev-todos" ${marcados.size === feed.alunos.length ? 'checked' : ''} aria-label="Marcar todos"></th><th>Aluno</th><th>Curso</th><th>Parcelas</th><th>Telefone</th><th>Matrícula</th></tr></thead>
    <tbody>${feed.alunos.map(a => `<tr class="${marcados.has(a.codmat) ? '' : 'ev-desmarcado'}">
      <td><input type="checkbox" class="ev-marca" data-cod="${esc(a.codmat)}" ${marcados.has(a.codmat) ? 'checked' : ''} aria-label="Incluir ${esc(a.nome)}"></td>
      <td><b>${esc(a.nome)}</b>${a.enviadoEm ? ` <span class="ev-tag-enviado">já enviado em ${ddmm(a.enviadoEm)}</span>` : ''}</td>
      <td>${esc(a.curso)} <small>${a.periodo ? `${a.periodo}º` : ''}</small></td>
      <td>${a.parcelas ? `${a.parcelas.qtd}x de R$ ${real(a.parcelas.valor)}${a.parcelas.percentual ? ` <small>(${percBR(a.parcelas.percentual)}%)</small>` : ''}` : '<span class="ev-alerta">sem parcelas no Edubox</span>'}</td>
      <td>${esc(fone(a.telefone)) || '<span class="ev-alerta">sem telefone</span>'}</td>
      <td>${ddmm(a.dataMatricula)}</td></tr>`).join('')}</tbody></table>`;
  montarSaidasFeed();
}

function selecionados() { return feed.alunos.filter(a => marcados.has(a.codmat)); }

function textoEmailMatriculas(lista) {
  const blocos = lista.map(a => {
    const p = a.parcelas;
    const linha3 = p
      ? `${p.qtd}x de R$${real(p.valor)}${p.percentual ? ` - com desconto de ${percBR(p.percentual)}%` : ''}, 1º vencimento para o dia ${dois(p.dia)}/${dois(p.mes)}.`
      : '(parcelas ainda não lançadas no Edubox)';
    return `${a.nome}\n${a.curso}${a.periodo ? ` - ${a.periodo}° PERÍODO` : ''}\n${linha3}`;
  });
  return `${saudacao()},\n\nSegue matrículas realizadas na data de hoje;\n\n${blocos.join('\n\n')}\n`;
}
function textoWhatsapp(lista) {
  return `Feed Diário ${ddmm(feed.hoje)}\n\nMATRÍCULAS REALIZADAS: ${lista.length}\n\n${lista.map(a => `${a.nome}\n${a.curso}\n${fone(a.telefone)}`).join('\n\n')}`;
}

function montarSaidasFeed() {
  const lista = selecionados();
  $('ev-feed-saidas').classList.toggle('hidden', !lista.length);
  $('ev-feed-final').classList.toggle('hidden', !lista.length);
  $('ev-feed-qtd').textContent = lista.length;
  $('ev-email-assunto').value = `MATRÍCULAS ${ddmm(feed.hoje)} - ${semBR(feed.semestre)}`;
  $('ev-email-para').textContent = `${PARA_MATRICULAS.length} destinatários (os mesmos de sempre)`;
  $('ev-email-texto').value = textoEmailMatriculas(lista);
  $('ev-zap-texto').value = textoWhatsapp(lista);
  const btn = $('ev-marcar-enviados');
  btn.textContent = `Marcar ${lista.length} como enviados`;
  delete btn.dataset.confirma;
}

function wireFeed() {
  $('ev-feed-lista').addEventListener('change', (e) => {
    if (e.target.id === 'ev-todos') {
      feed.alunos.filter(a => !e.target.checked || !a.enviadoEm).forEach(a => (e.target.checked ? marcados.add(a.codmat) : marcados.delete(a.codmat)));
      return desenharFeed();
    }
    const c = e.target.closest('.ev-marca');
    if (!c) return;
    c.checked ? marcados.add(c.dataset.cod) : marcados.delete(c.dataset.cod);
    c.closest('tr').classList.toggle('ev-desmarcado', !c.checked);
    montarSaidasFeed();
  });
  $('ev-email-gmail').addEventListener('click', () => {
    window.open(linkGmail(PARA_MATRICULAS, $('ev-email-assunto').value, $('ev-email-texto').value), '_blank', 'noopener');
  });
  $('ev-email-copiar').addEventListener('click', async () => { if (await copiar($('ev-email-texto').value)) ctx.showToast('Texto do e-mail copiado.'); });
  $('ev-zap-copiar').addEventListener('click', async () => { if (await copiar($('ev-zap-texto').value)) ctx.showToast('Mensagem copiada. É só colar no grupo do WhatsApp.'); });
  $('ev-zap-abrir').addEventListener('click', () => window.open(`https://wa.me/?text=${encodeURIComponent($('ev-zap-texto').value)}`, '_blank', 'noopener'));
  $('ev-marcar-enviados').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const lista = selecionados();
    if (!lista.length) return;
    if (!btn.dataset.confirma) { btn.dataset.confirma = '1'; btn.textContent = 'Já enviei o e-mail e o WhatsApp — confirmar'; return; }
    btn.disabled = true;
    try {
      const r = await ctx.apiFetch('/matriculas/envios/feed/enviado', { method: 'POST', body: JSON.stringify({ semestre: feed.semestre, dataFeed: feed.hoje, alunos: lista.map(a => ({ codmat: a.codmat, nome: a.nome })) }) });
      ctx.showToast(r.message || 'Marcados como enviados.');
      await carregarFeed();
    } catch (err) { ctx.showToast(err.message, 'error'); }
    finally { btn.disabled = false; }
  });
}

// =================== TRANCAMENTO / CANCELAMENTO ===================
let coordenadores = null;
let alunoSaida = null;
let buscaTimer = null;

async function prepararSaida(tipo) {
  const tranc = tipo === 'trancamento';
  $('ev-saida-titulo').textContent = tranc ? 'Trancamento de matrícula' : 'Cancelamento de matrícula';
  $('ev-taxa-rotulo').textContent = tranc ? 'Efetuou o pagamento da taxa de trancamento?' : 'Foi cobrada taxa de cancelamento?';
  if (!coordenadores) { try { coordenadores = await ctx.apiFetch('/matriculas/envios/coordenadores'); } catch (e) { coordenadores = {}; } }
  montarSaida();
}

function destinatariosSaida() {
  const coord = alunoSaida && alunoSaida.cursoSlug ? (coordenadores[alunoSaida.cursoSlug] || []) : [];
  return { para: [...PARA_SAIDA, ...coord.filter(e => !PARA_SAIDA.includes(e))], coord };
}

function textoSaida() {
  const tranc = abaAtual === 'trancamento';
  const nome = $('ev-s-nome').value.trim(), curso = $('ev-s-curso').value.trim(), per = $('ev-s-periodo').value.trim(), motivo = $('ev-s-motivo').value.trim();
  const taxa = document.querySelector('input[name="ev-taxa"]:checked')?.value;
  const pend = document.querySelector('input[name="ev-pend"]:checked')?.value;
  const perTxt = per ? (per.includes('°') || per.includes('º') ? per.replace('º', '°') : `${per}°`) : '';
  const nomeTitulo = nome ? nome.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\s(De|Da|Do|Das|Dos|E)\s/g, (x) => x.toLowerCase()) : '';
  const cursoTitulo = curso ? curso.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\s(De|Da|Do|E|Em)\s/g, (x) => x.toLowerCase()) : '';
  let linhaFin;
  if (tranc) {
    linhaFin = `${taxa === 'sim' ? 'Efetuou o pagamento da taxa de trancamento.' : 'Não efetuou o pagamento da taxa de trancamento.'}\n${pend === 'sim' ? 'Possui pendências financeiras.' : 'Não possui pendências financeiras.'}`;
  } else {
    linhaFin = `${taxa === 'sim' ? 'Foi cobrada taxa de cancelamento' : 'Não foi cobrada taxa de cancelamento'}, ${pend === 'sim' ? 'possui pendências financeiras.' : 'não possui pendências financeiras.'}`;
  }
  const abertura = tranc
    ? 'Segue abaixo Trancamento de Matrícula.'
    : `Segue abaixo cancelamento de Matrícula${/^1/.test(per) ? ` ingressante ${semBR($('ev-semestre').value)}` : ''}.`;
  const estefani = tranc ? 'Estefani; excluir DDA´s em anexo.' : 'Estefani; em anexo DDA´s a serem excluídos.';
  return `${saudacao()}!\n${abertura}\n\nAluno(a) - ${nomeTitulo}\nCurso - ${cursoTitulo}\nPeríodo - ${perTxt}\nMotivo - ${motivo}\n${linhaFin}\n\nLisa; desvincular aluno(a) dos sistemas\n\nAna Luiza; retirar pasta física do(a) aluno(a)\n\nPaulinho; excluir aluno(a) dos sistemas\n\n${estefani}\n`;
}

function montarSaida() {
  const { para, coord } = destinatariosSaida();
  if (!$('ev-s-assunto').dataset.editado) $('ev-s-assunto').value = abaAtual === 'trancamento' ? 'TRANCAMENTO DE MATRÍCULA' : 'CANCELAMENTO DE MATRÍCULA';
  $('ev-s-para').innerHTML = `${para.length} destinatários${coord.length ? ` · coordenação do curso: <b>${ctx.esc(coord.join(', '))}</b>` : alunoSaida ? ' · <span class="ev-alerta">coordenador do curso não encontrado</span>' : ''}`;
  // o texto é gerado pelos campos; se a pessoa editou o texto direto, não sobrescreve (botão "Refazer texto" volta ao gerado)
  if (!$('ev-s-texto').dataset.editado) $('ev-s-texto').value = textoSaida();
  $('ev-s-refazer').classList.toggle('hidden', !$('ev-s-texto').dataset.editado);
  const pronto = $('ev-s-nome').value.trim() && $('ev-s-curso').value.trim() && $('ev-s-motivo').value.trim();
  $('ev-s-gmail').disabled = !pronto;
  $('ev-s-falta').textContent = pronto ? '' : 'Preencha aluno, curso e motivo.';
}

function wireSaida() {
  const busca = $('ev-s-busca');
  busca.addEventListener('input', () => {
    clearTimeout(buscaTimer);
    const q = busca.value.trim();
    if (q.length < 3) { $('ev-s-resultados').innerHTML = ''; return; }
    buscaTimer = setTimeout(async () => {
      try {
        const lista = await ctx.apiFetch(`/matriculas/envios/buscar-aluno?semestre=${encodeURIComponent($('ev-semestre').value)}&q=${encodeURIComponent(q)}`);
        $('ev-s-resultados').innerHTML = lista.length
          ? lista.map((a, i) => `<button type="button" class="ev-res" data-i="${i}"><b>${ctx.esc(a.nome)}</b><small>${ctx.esc(a.curso || '')} · ${ctx.esc(a.periodo || '')} · ${ctx.esc(a.situacao || '')}</small></button>`).join('')
          : '<p class="ev-dica">Ninguém com esse nome nas Matrículas deste semestre. Pode preencher à mão.</p>';
        $('ev-s-resultados').__lista = lista;
      } catch (err) { $('ev-s-resultados').innerHTML = `<p class="ev-erro">${ctx.esc(err.message)}</p>`; }
    }, 300);
  });
  $('ev-s-resultados').addEventListener('click', (e) => {
    const b = e.target.closest('.ev-res');
    if (!b) return;
    alunoSaida = $('ev-s-resultados').__lista[Number(b.dataset.i)];
    $('ev-s-nome').value = alunoSaida.nome || '';
    $('ev-s-curso').value = alunoSaida.curso || '';
    $('ev-s-periodo').value = String(alunoSaida.periodo || '').replace('º', '°');
    $('ev-s-resultados').innerHTML = '';
    busca.value = '';
    montarSaida();
    $('ev-s-motivo').focus();
  });
  ['ev-s-nome', 'ev-s-curso', 'ev-s-periodo', 'ev-s-motivo'].forEach(id => $(id).addEventListener('input', montarSaida));
  document.querySelectorAll('input[name="ev-taxa"], input[name="ev-pend"]').forEach(r => r.addEventListener('change', montarSaida));
  $('ev-s-limpar').addEventListener('click', () => {
    alunoSaida = null;
    ['ev-s-nome', 'ev-s-curso', 'ev-s-periodo', 'ev-s-motivo'].forEach(id => { $(id).value = ''; });
    delete $('ev-s-texto').dataset.editado; delete $('ev-s-assunto').dataset.editado;
    montarSaida();
  });
  $('ev-s-gmail').addEventListener('click', () => {
    const { para } = destinatariosSaida();
    window.open(linkGmail(para, $('ev-s-assunto').value, $('ev-s-texto').value), '_blank', 'noopener');
  });
  $('ev-s-texto').addEventListener('input', () => { $('ev-s-texto').dataset.editado = '1'; $('ev-s-refazer').classList.remove('hidden'); });
  $('ev-s-assunto').addEventListener('input', () => { $('ev-s-assunto').dataset.editado = '1'; });
  $('ev-s-refazer').addEventListener('click', () => { delete $('ev-s-texto').dataset.editado; montarSaida(); });
  $('ev-s-copiar').addEventListener('click', async () => { if (await copiar($('ev-s-texto').value)) ctx.showToast('Texto copiado.'); });
}
