// ==========================================
// Contratos › Rota de coleta (27/10/2026)
// Antes de sair da faculdade: escolhe o dia e a cidade, marca os alunos sem assinatura (já vêm marcados
// os que têm coleta naquele dia), "Montar rota" traz o endereço do Edubox e a ordem de visita.
// Na rua: cada aluno abre no Google Maps (pelo ponto salvo no GPS ou pelo endereço) — sem internet se o
// mapa da região estiver baixado no Google Maps. "Baixar rota" salva um arquivo que abre sem internet.
// "Salvar localização daqui" (GPS na porta do aluno) deixa a próxima rota ordenada pela distância.
// ==========================================
const MAX_ALUNOS = 25; // limite do Google pra calcular a melhor ordem
const POR_TRECHO = 4; // Google Maps no celular aceita 3 paradas no meio + o destino num link só

let ctx = null;      // funções e estado emprestados do app.js
let resultado = null; // { data, cidade, saida, paradas }

const $ = (id) => document.getElementById(id);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

// Ponto salvo pelo GPS > ponto que o Google achou ao calcular a rota > endereço escrito (último recurso)
function destinoMaps(p) {
  const pt = p.geo || p.ponto;
  return pt ? `${pt.lat},${pt.lng}` : p.busca;
}
function linkMaps(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destinoMaps(p))}&travelmode=driving`;
}
// Trechos de até 4 paradas, cada um num link (saindo de onde o celular está)
function linksTrechos(paradas) {
  const ok = paradas.filter(p => p.geo || p.ponto || p.busca);
  const trechos = [];
  for (let i = 0; i < ok.length; i += POR_TRECHO) {
    const g = ok.slice(i, i + POR_TRECHO);
    const destino = g[g.length - 1], meio = g.slice(0, -1);
    const q = new URLSearchParams({ api: '1', destination: destinoMaps(destino), travelmode: 'driving' });
    if (meio.length) q.set('waypoints', meio.map(destinoMaps).join('|'));
    trechos.push({ de: i + 1, ate: i + g.length, url: `https://www.google.com/maps/dir/?${q}` });
  }
  return trechos;
}
const resumoTempo = (min) => min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min} min`;
const telLink = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length >= 10 ? `tel:${d}` : null; };

// ---------------- passo 1: escolher dia, cidade e alunos ----------------
function semAssinatura() {
  return ctx.getRegistros().filter(r => r.status === 'sem_assinatura');
}
function cidadesDisponiveis() {
  const m = new Map();
  semAssinatura().forEach(r => { const c = (r.cidade || '').trim() || '(sem cidade)'; m.set(c, (m.get(c) || 0) + 1); });
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
}
function abrir() {
  if (!ctx.getSemestre()) { ctx.toast('Escolha o semestre primeiro.', 'error'); return; }
  resultado = null;
  const data = $('rt-data').value || ctx.hoje();
  $('rt-data').value = data;
  montarCidades();
  renderEscolha();
  $('rt-passo-escolher').classList.remove('hidden');
  $('rt-passo-rota').classList.add('hidden');
  $('modal-rota').classList.remove('hidden');
}
function montarCidades() {
  const data = $('rt-data').value;
  const atual = $('rt-cidade').value;
  const cidades = cidadesDisponiveis();
  // cidade sugerida: a que tem mais coleta marcada nesse dia
  const doDia = new Map();
  semAssinatura().filter(r => r.coletaData === data).forEach(r => { const c = (r.cidade || '').trim() || '(sem cidade)'; doDia.set(c, (doDia.get(c) || 0) + 1); });
  const sugerida = [...doDia.entries()].sort((a, b) => b[1] - a[1])[0];
  $('rt-cidade').innerHTML = '<option value="">Escolha a cidade...</option>' + cidades.map(([c, n]) =>
    `<option value="${ctx.esc(c)}">${ctx.esc(c)} — ${n} sem assinatura${doDia.get(c) ? ` · ${doDia.get(c)} com coleta no dia` : ''}</option>`).join('');
  $('rt-cidade').value = cidades.some(([c]) => c === atual) ? atual : (sugerida ? sugerida[0] : '');
}
function renderEscolha() {
  const data = $('rt-data').value, cidade = $('rt-cidade').value;
  const lista = semAssinatura().filter(r => ((r.cidade || '').trim() || '(sem cidade)') === cidade)
    .sort((a, b) => (b.coletaData === data) - (a.coletaData === data) || (a.coletaHora || '99').localeCompare(b.coletaHora || '99') || (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
  if (!cidade) { $('rt-lista').innerHTML = '<p class="rt-vazio">Escolha a cidade da rota.</p>'; atualizarContagem(); return; }
  $('rt-lista').innerHTML = lista.map(r => {
    const coleta = r.coletaData ? `Coleta ${ctx.fmtData(r.coletaData)}${r.coletaHora ? ' ' + r.coletaHora : ''}${r.coletaResponsavel ? ' · ' + ctx.esc(r.coletaResponsavel.nome.split(' ')[0]) : ''}` : 'Sem coleta marcada';
    return `<label class="rt-aluno">
      <input type="checkbox" value="${ctx.esc(r.id)}" ${r.coletaData === data ? 'checked' : ''}>
      <span><b>${ctx.esc(r.nome)}</b>${r.menor18 ? ' <span class="rt-tag">menor de 18</span>' : ''}<small>${ctx.esc(r.curso || '')} · ${coleta}${r.geo ? ' · 📍 local salvo' : ''}</small></span>
    </label>`;
  }).join('') || '<p class="rt-vazio">Nenhum aluno sem assinatura nessa cidade.</p>';
  atualizarContagem();
}
function marcados() { return [...$('rt-lista').querySelectorAll('input:checked')].map(i => i.value); }
function atualizarContagem() {
  const n = marcados().length;
  $('rt-contagem').textContent = n ? `${n} aluno(s) marcado(s)${n > MAX_ALUNOS ? ` — no máximo ${MAX_ALUNOS} por rota` : ''}` : 'Nenhum aluno marcado';
  $('rt-montar').disabled = !n || n > MAX_ALUNOS;
}

// ---------------- passo 2: rota montada ----------------
async function montar() {
  const ids = marcados();
  const btn = $('rt-montar');
  btn.disabled = true; btn.textContent = 'Montando a rota...';
  try {
    const r = await ctx.apiFetch('/contratos/rota/montar', { method: 'POST', body: JSON.stringify({ semestre: ctx.getSemestre(), ids }) });
    resultado = { data: $('rt-data').value, cidade: $('rt-cidade').value, ...r };
    renderRota();
    $('rt-passo-escolher').classList.add('hidden');
    $('rt-passo-rota').classList.remove('hidden');
  } catch (e) { ctx.toast(e.message, 'error'); }
  finally { btn.textContent = 'Montar rota'; atualizarContagem(); }
}
function cartao(p, i, { offline = false } = {}) {
  const e = ctx.esc;
  const tel = telLink(p.contato), wa = ctx.linkWhatsapp(p.contato);
  const coleta = p.coleta && p.coleta.data === resultado.data ? `Coleta ${p.coleta.hora || 'sem horário'}${p.coleta.local ? ' · ' + e(p.coleta.local) : ''}${p.coleta.responsavel ? ' · ' + e(p.coleta.responsavel) : ''}` : '';
  return `<li class="rt-parada" data-rt-id="${e(p.id)}">
    <div class="rt-num">${i + 1}</div>
    <div class="rt-corpo">
      <div class="rt-nome">${e(p.nome)}${p.menor18 ? ' <span class="rt-tag">menor de 18 · assina o responsável</span>' : ''}</div>
      <div class="rt-info">${e(p.curso)}${coleta ? ' · ' + coleta : ''}</div>
      <div class="rt-end">${p.endereco ? e(p.endereco) : '<span class="rt-alerta">Endereço não encontrado no Edubox — confira com o aluno</span>'}</div>
      ${p.obs ? `<div class="rt-obs">${e(p.obs)}</div>` : ''}
      ${p.kmAnterior != null || p.geo ? `<div class="rt-info">${p.kmAnterior != null ? `🚗 ${String(p.kmAnterior).replace('.', ',')} km${p.minAnterior != null ? ` · ${p.minAnterior} min` : ''} ${i ? 'da parada anterior' : 'da Fatec'}` : ''}${p.geo ? `${p.kmAnterior != null ? ' · ' : ''}📍 local salvo pelo GPS` : ''}</div>` : ''}
      <div class="rt-acoes">
        ${p.geo || p.ponto || p.busca ? `<a class="rt-btn rt-btn-maps" href="${e(linkMaps(p))}" target="_blank" rel="noopener">Ir no Google Maps</a>` : ''}
        ${tel ? `<a class="rt-btn" href="${tel}">Ligar</a>` : ''}
        ${wa ? `<a class="rt-btn" href="${e(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        ${offline ? `<label class="rt-btn rt-visitado"><input type="checkbox" data-visitado="${e(p.id)}"> Visitado</label>`
                  : `<button type="button" class="rt-btn" data-rt-gps="${e(p.id)}">📍 Salvar localização daqui</button>`}
      </div>
    </div>
  </li>`;
}
function renderRota() {
  const { data, cidade, paradas, totais, ordemGoogle, avisoOrdem } = resultado;
  const semEnd = paradas.filter(p => p.semEndereco).length;
  $('rt-titulo-rota').textContent = `Rota de ${ctx.fmtData(data)} · ${cidade} · ${paradas.length} aluno(s)`;
  $('rt-avisos').innerHTML = [
    ordemGoogle && totais ? `<p class="rt-resumo">✅ Melhor ordem calculada pelo Google: saindo da Fatec e voltando, <b>${String(totais.km).replace('.', ',')} km</b> e cerca de <b>${resumoTempo(totais.minutos)}</b> dirigindo (sem contar o tempo em cada casa).</p>` : '',
    avisoOrdem ? `<p class="rt-alerta">${ctx.esc(avisoOrdem)}</p>` : '',
    semEnd ? `<p class="rt-alerta">${semEnd} aluno(s) sem endereço no Edubox (o nome no Contratos não bateu com o cadastro) — ficam no fim da lista.</p>` : ''
  ].join('');
  $('rt-trechos').innerHTML = linksTrechos(paradas).map(t => `<a class="rt-btn rt-btn-maps" href="${ctx.esc(t.url)}" target="_blank" rel="noopener">Google Maps: paradas ${t.de} a ${t.ate}</a>`).join('');
  $('rt-paradas').innerHTML = paradas.map((p, i) => cartao(p, i)).join('');
}
async function salvarGps(btn) {
  if (!navigator.geolocation) { ctx.toast('Este aparelho não tem localização.', 'error'); return; }
  btn.disabled = true; btn.textContent = 'Pegando o GPS...';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      const r = await ctx.apiFetch(`/contratos/${encodeURIComponent(btn.dataset.rtGps)}/localizacao`, { method: 'PUT', body: JSON.stringify({ lat, lng }) });
      const p = resultado.paradas.find(x => x.id === btn.dataset.rtGps);
      if (p) p.geo = r.geo;
      ctx.onGeoSalvo(btn.dataset.rtGps, r.geo);
      btn.textContent = `📍 Local salvo (±${Math.round(accuracy)} m)`;
      ctx.toast('Localização da casa salva. Na próxima rota ela já sai na ordem certa.');
    } catch (e) { ctx.toast(e.message, 'error'); btn.disabled = false; btn.textContent = '📍 Salvar localização daqui'; }
  }, (err) => {
    ctx.toast(err.code === 1 ? 'Permita a localização no navegador para salvar.' : 'Não consegui pegar o GPS. Tente de novo ao ar livre.', 'error');
    btn.disabled = false; btn.textContent = '📍 Salvar localização daqui';
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

// ---------------- arquivo que abre sem internet ----------------
function baixar() {
  const { data, cidade, paradas } = resultado;
  const titulo = `Rota de coleta · ${ctx.fmtData(data)} · ${cidade}`;
  const chave = `rota-${data}-${norm(cidade).replace(/[^A-Z0-9]+/g, '-')}`;
  const trechos = linksTrechos(paradas).map(t => `<a class="rt-btn rt-btn-maps" href="${ctx.esc(t.url)}">Google Maps: paradas ${t.de} a ${t.ate}</a>`).join('');
  const html = `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ctx.esc(titulo)}</title><style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6fb;color:#1d2433}
header{background:#123a7a;color:#fff;padding:16px}header h1{font-size:1.15rem;margin:0 0 4px}header p{margin:0;font-size:.85rem;opacity:.9}
main{padding:12px;max-width:720px;margin:0 auto}.dica{background:#fff7e0;border:1px solid #f0d58a;border-radius:10px;padding:10px 12px;font-size:.85rem;margin-bottom:12px}
.trechos{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}ol{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.rt-parada{display:flex;gap:10px;background:#fff;border:1px solid #dfe5f0;border-radius:12px;padding:12px}.rt-parada.feito{opacity:.55}
.rt-num{flex:0 0 30px;height:30px;border-radius:50%;background:#123a7a;color:#fff;display:grid;place-items:center;font-weight:700}
.rt-corpo{flex:1;min-width:0}.rt-nome{font-weight:700}.rt-info,.rt-obs{font-size:.82rem;color:#5b6475;margin-top:2px}.rt-end{font-size:.9rem;margin-top:4px}
.rt-tag{background:#fde8e8;color:#9b1c1c;border-radius:6px;padding:1px 6px;font-size:.72rem;font-weight:600}.rt-alerta{color:#9b1c1c;font-size:.85rem}
.rt-acoes{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.rt-btn{display:inline-flex;align-items:center;gap:4px;padding:8px 12px;border-radius:8px;border:1px solid #c9d3e6;background:#fff;color:#123a7a;text-decoration:none;font-size:.85rem;font-weight:600}
.rt-btn-maps{background:#1a73e8;border-color:#1a73e8;color:#fff}.rt-visitado input{margin:0}
</style></head><body>
<header><h1>${ctx.esc(titulo)}</h1><p>${paradas.length} aluno(s) · gerada em ${new Date().toLocaleString('pt-BR')} · Órbita Fatec — Comercial</p></header>
<main><div class="dica">Sem internet: o Google Maps só navega se o mapa da região estiver baixado (Google Maps › foto do perfil › <b>Mapas off-line</b> › selecionar a região do Vale do Ivaí). Faça isso no Wi-Fi da faculdade.</div>
<div class="trechos">${trechos}</div><ol>${paradas.map((p, i) => cartao(p, i, { offline: true })).join('')}</ol></main>
<script>
var K=${JSON.stringify(chave)};var v={};try{v=JSON.parse(localStorage.getItem(K)||'{}')}catch(e){}
document.querySelectorAll('[data-visitado]').forEach(function(c){var id=c.getAttribute('data-visitado');c.checked=!!v[id];c.closest('.rt-parada').classList.toggle('feito',c.checked);
c.addEventListener('change',function(){v[id]=c.checked;c.closest('.rt-parada').classList.toggle('feito',c.checked);try{localStorage.setItem(K,JSON.stringify(v))}catch(e){}});});
</script></body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  a.download = `${chave.toLowerCase()}.html`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  ctx.toast('Rota baixada. Abra o arquivo no celular — funciona sem internet.');
}

export function iniciarRotaColeta(funcoes) {
  ctx = funcoes;
  $('btn-rota').addEventListener('click', abrir);
  $('rt-fechar').addEventListener('click', () => $('modal-rota').classList.add('hidden'));
  $('rt-fechar-2').addEventListener('click', () => $('modal-rota').classList.add('hidden'));
  $('rt-data').addEventListener('change', () => { montarCidades(); renderEscolha(); });
  $('rt-cidade').addEventListener('change', renderEscolha);
  $('rt-lista').addEventListener('change', atualizarContagem);
  $('rt-todos').addEventListener('click', () => { $('rt-lista').querySelectorAll('input').forEach(i => { i.checked = true; }); atualizarContagem(); });
  $('rt-nenhum').addEventListener('click', () => { $('rt-lista').querySelectorAll('input').forEach(i => { i.checked = false; }); atualizarContagem(); });
  $('rt-montar').addEventListener('click', montar);
  $('rt-voltar').addEventListener('click', () => { $('rt-passo-rota').classList.add('hidden'); $('rt-passo-escolher').classList.remove('hidden'); });
  $('rt-baixar').addEventListener('click', baixar);
  $('rt-paradas').addEventListener('click', (e) => { const b = e.target.closest('[data-rt-gps]'); if (b && !b.disabled) salvarGps(b); });
}
