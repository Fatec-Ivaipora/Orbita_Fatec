// Feed diário de matrículas (11/11/2026) — dentro de Contratos (Comercial), relatório pro Fábio.
// Calouros do semestre direto do Edubox (rota /contratos/feed-diario), vagas do edital + margem de 10% e aviso
// de curso chegando no limite. Imprime no padrão dos relatórios (logo do Órbita e da Fatec).
let ctx = null;          // { apiFetch, esc, showToast, semestres }
let dados = null;
let editandoVagas = false;

const $ = (id) => document.getElementById(id);
const hojeISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const dataLonga = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const n = (v) => Number(v || 0).toLocaleString('pt-BR');
const semBR = (s) => String(s || '').replace('.', '/');

function situacaoTexto(c) {
  if (c.situacao === 'sem-vagas') return '';
  if (c.situacao === 'lotado') return c.restam < 0 ? `Acima do limite: +${-c.restam}` : 'Lotado: limite atingido';
  if (c.situacao === 'reta') return c.restam === 1 ? 'Só 1 vaga restante' : `Últimas ${c.restam} vagas`;
  if (c.situacao === 'margem') return `Usando a margem de 10%: restam ${c.restam}`;
  return `Restam ${c.restam} vagas`;
}

export function iniciarFeedDiario(contexto) {
  ctx = contexto;
  $('btn-feed-diario').addEventListener('click', abrir);
  $('fd-voltar').addEventListener('click', fechar);
  $('fd-atualizar').addEventListener('click', carregar);
  $('fd-imprimir').addEventListener('click', imprimirRetrato);
  $('fd-imagem').addEventListener('click', gerarImagem);
  $('fd-data').addEventListener('change', carregar);
  $('fd-semestre').addEventListener('change', carregar);
  $('fd-conteudo').addEventListener('click', (e) => {
    if (e.target.closest('#fd-editar-vagas')) { editandoVagas = true; desenhar(); }
    if (e.target.closest('#fd-cancelar-vagas')) { editandoVagas = false; desenhar(); }
    if (e.target.closest('#fd-salvar-vagas')) salvarVagas(e.target.closest('#fd-salvar-vagas'));
  });
}

// Imprime em RETRATO numa página só (12/11/2026). O tema do Comercial põe @page em paisagem pra todos os
// relatórios; aqui um @page só enquanto imprime vence (vem depois) e sai no afterprint.
function imprimirRetrato() {
  const st = document.createElement('style');
  st.id = 'fd-page-retrato';
  st.textContent = '@page { size: A4 portrait; margin: 9mm 10mm; }';
  document.head.appendChild(st);
  document.body.classList.add('fd-imprimindo');
  const limpar = () => { st.remove(); document.body.classList.remove('fd-imprimindo'); window.removeEventListener('afterprint', limpar); };
  window.addEventListener('afterprint', limpar);
  window.print();
}

// Imagem do feed pra mandar no WhatsApp (12/11/2026): o relatório no layout de celular (cartões), em pé,
// 1080 px de largura. No celular abre o "Compartilhar" (escolhe o WhatsApp); no computador baixa o PNG.
let h2cPromessa = null;
function carregarHtml2canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (!h2cPromessa) h2cPromessa = new Promise((ok, falha) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    sc.onload = () => ok(window.html2canvas);
    sc.onerror = () => { h2cPromessa = null; falha(new Error('Não consegui carregar o gerador de imagem. Confira a internet e tente de novo.')); };
    document.head.appendChild(sc);
  });
  return h2cPromessa;
}
function htmlImagem(d) {
  const esc = ctx.esc;
  const ehHoje = d.data === hojeISO();
  const [a, m, dd] = d.data.split('-');
  const hora = new Date(d.consultadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const doDia = d.cursos.filter(c => c.hoje).sort((x, y) => y.hoje - x.hoje || x.nome.localeCompare(y.nome, 'pt-BR'));
  const alertas = d.cursos.filter(c => ['lotado', 'reta', 'margem'].includes(c.situacao)).sort((x, y) => (x.restam ?? 0) - (y.restam ?? 0));
  const linhas = d.cursos.filter(c => c.total || c.outros || c.vagas);
  const curto = (nome) => nome.replace('Arquitetura e Urbanismo', 'Arquitetura').replace('Medicina Veterinária', 'Med. Veterinária').replace('Ciências Contábeis', 'C. Contábeis');
  return `<div class="fdi">
    <div class="fdi-cab"><span class="fdi-marca"><span class="fdi-orb">F<i></i></span><b>ÓRBITA</b><em>FATEC</em></span><img src="/img/fatec-ivp-horizontal.png" alt="Fatec Ivaiporã"></div>
    <h2>Feed diário de matrículas</h2>
    <p class="fdi-sub">Calouros ${esc(semBR(d.semestre))} · ${dd}/${m}/${a} · Edubox às ${esc(hora)}</p>
    <div class="fdi-hoje"><div class="fdi-hoje-n"><b>${n(d.totais.hoje)}</b><span>${d.totais.hoje === 1 ? 'matrícula' : 'matrículas'}<br>${ehHoje ? 'hoje' : 'no dia'}</span></div>
      <div class="fdi-chips">${doDia.length ? doDia.map(c => `<span>${esc(curto(c.nome))} <b>+${c.hoje}</b></span>`).join('') : '<span class="fdi-nada">Nenhuma matrícula no dia</span>'}</div></div>
    ${alertas.length ? `<div class="fdi-alertas">${alertas.map(c => `<p class="fdi-a-${c.situacao}"><b>${esc(curto(c.nome))}</b> ${esc(situacaoTexto(c).toLowerCase())} <span>${c.total} de ${c.limite}</span></p>`).join('')}</div>` : ''}
    <table class="fdi-tab"><thead><tr><th>Curso</th><th>Matric.</th><th>Edital</th><th>Disp.</th></tr></thead><tbody>
      ${linhas.map(c => `<tr class="fdi-l-${c.situacao}"><td>${esc(curto(c.nome))}</td><td><b>${n(c.total)}</b>${c.hoje ? `<i>+${c.hoje}</i>` : ''}${c.outros ? `<small class="fdi-op">+${c.outros} outros per. = ${n(c.total + c.outros)}</small>` : ''}</td><td>${c.vagas ?? '—'}</td><td><b>${c.limite === null ? '—' : Math.max(0, c.restam)}</b></td></tr>`).join('')}
    </tbody><tfoot><tr><td>Total</td><td colspan="3"><b>${n(d.totais.total)}</b> calouros${d.totais.outros ? ` + <b>${n(d.totais.outros)}</b> outros per. = <b>${n(d.totais.total + d.totais.outros)}</b>` : ''}${d.totais.hoje ? `<i>+${d.totais.hoje}</i>` : ''}</td></tr></tfoot></table>
    <p class="fdi-rod">Disp. = vagas do edital + 10% − calouros do 1º período · Órbita Fatec</p>
  </div>`;
}

async function gerarImagem() {
  if (!dados) return ctx.showToast('Espere o feed carregar.', 'error');
  const btn = $('fd-imagem');
  const rotulo = btn.textContent;
  btn.disabled = true; btn.textContent = 'Gerando imagem…';
  // imagem própria (12/11/2026): 360px de largura x 3 = 1080 px, feita pra caber numa tela de celular e
  // continuar legível depois que o WhatsApp reduz
  const caixa = document.createElement('div');
  caixa.className = 'fdi-caixa';
  caixa.innerHTML = htmlImagem(dados);
  document.body.appendChild(caixa);
  try {
    const html2canvas = await carregarHtml2canvas();
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const canvas = await html2canvas(caixa.firstElementChild, { scale: 3, backgroundColor: '#ffffff', useCORS: true, logging: false });
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const nome = `feed-diario-matriculas-${(dados && dados.data) || hojeISO()}.png`;
    const arquivo = new File([blob], nome, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {
      try { await navigator.share({ files: [arquivo], title: 'Feed diário de matrículas' }); }
      catch (e) { if (e.name !== 'AbortError') throw e; }
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      ctx.showToast('Imagem baixada. É só anexar no WhatsApp.');
    }
  } catch (err) {
    ctx.showToast(err.message || 'Não foi possível gerar a imagem.', 'error');
  } finally {
    caixa.remove();
    btn.disabled = false; btn.textContent = rotulo;
  }
}

function abrir() {
  const sel = $('fd-semestre');
  const lista = (ctx.semestres() || []).filter(s => s >= '2026.2').sort().reverse();
  const atual = lista.includes('2027.1') ? '2027.1' : (lista[0] || '2027.1');
  sel.innerHTML = (lista.length ? lista : ['2027.1']).map(s => `<option value="${s}" ${s === (sel.value || atual) ? 'selected' : ''}>${semBR(s)}</option>`).join('');
  if (!$('fd-data').value) $('fd-data').value = hojeISO();
  $('fd-data').max = hojeISO();
  document.body.classList.add('fd-aberto');
  window.scrollTo(0, 0);
  carregar();
}
function fechar() { document.body.classList.remove('fd-aberto'); editandoVagas = false; }

async function carregar() {
  $('fd-conteudo').innerHTML = '<div class="fd-carregando"><span class="fd-spin" aria-hidden="true"></span>Buscando as matrículas no Edubox…</div>';
  try {
    dados = await ctx.apiFetch(`/contratos/feed-diario?semestre=${encodeURIComponent($('fd-semestre').value)}&data=${encodeURIComponent($('fd-data').value || hojeISO())}`);
    desenhar();
  } catch (err) {
    $('fd-conteudo').innerHTML = `<div class="fd-erro">Não foi possível montar o feed: ${ctx.esc(err.message)}. Tente "Atualizar" em instantes.</div>`;
  }
}

function desenhar() {
  const esc = ctx.esc;
  const d = dados;
  const ehHoje = d.data === hojeISO();
  const quando = ehHoje ? 'hoje' : 'no dia';
  const alertas = d.cursos.filter(c => ['lotado', 'reta', 'margem'].includes(c.situacao))
    .sort((a, b) => (a.restam ?? 0) - (b.restam ?? 0));
  const hora = new Date(d.consultadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const doDia = d.cursos.filter(c => c.hoje).sort((a, b) => b.hoje - a.hoje || a.nome.localeCompare(b.nome, 'pt-BR'));

  const visiveis = d.cursos.filter(c => editandoVagas || c.total || c.outros || c.sairam || c.vagas);
  const disponiveis = (c) => (c.limite === null ? '<span class="fd-zero">—</span>' : c.restam > 0 ? `<b>${n(c.restam)}</b>` : '<b class="fd-esgotou">0</b>');
  const linhas = visiveis.map(c => `
    <tr class="fd-l-${c.situacao}">
      <th scope="row">${esc(c.nome)}</th>
      <td class="num" data-rot="Matriculados"><b>${n(c.total)}</b>${c.outros ? ` <span class="fd-op">calouros + <b>${n(c.outros)}</b> outros per. = <b>${n(c.total + c.outros)}</b></span>` : ''}${c.hoje ? ` <span class="fd-mais">+${c.hoje} ${quando}</span>` : ''}</td>
      <td class="num" data-rot="Vagas do edital">${editandoVagas
        ? `<input type="number" min="0" max="10000" step="1" class="fd-vaga-in" data-cod="${esc(c.codcur)}" value="${c.vagas ?? ''}" aria-label="Vagas do edital de ${esc(c.nome)}">`
        : (c.vagas ?? '<span class="fd-zero">—</span>')}</td>
      <td class="num" data-rot="Disponíveis">${disponiveis(c)}</td>
      <td class="fd-sit">${situacaoTexto(c) ? `<span class="fd-selo fd-s-${c.situacao}">${esc(situacaoTexto(c))}</span>` : ''}</td>
    </tr>`).join('');

  $('fd-conteudo').innerHTML = `
    <article class="fd-folha">
      <header class="fd-cab">
        <div class="fd-marca" aria-label="Órbita Fatec"><span class="fd-orbita" aria-hidden="true"><span>F</span><i></i></span><span class="fd-marca-nome"><b>ÓRBITA</b><em>FATEC</em></span></div>
        <img class="fd-logo" src="/img/fatec-ivp-horizontal.png" alt="Fatec Ivaiporã">
      </header>
      <div class="fd-titulo">
        <h2>Feed diário de matrículas</h2>
        <p>Calouros de ${esc(semBR(d.semestre))} · ${esc(dataLonga(d.data))} · dados do Edubox às ${esc(hora)}</p>
      </div>

      <section class="fd-dia-feed" aria-label="Matrículas ${quando} por curso">
        <div class="fd-dia-total"><b>${n(d.totais.hoje)}</b><span>${d.totais.hoje === 1 ? 'matrícula' : 'matrículas'} ${quando}</span></div>
        <div class="fd-dia-cursos">
          ${doDia.length
            ? `<ul>${doDia.map(c => `<li><span>${esc(c.nome)}</span><b>+${c.hoje}</b></li>`).join('')}</ul>`
            : `<p class="fd-zero">Nenhuma matrícula ${quando}.</p>`}
        </div>
      </section>

      ${alertas.length ? `<section class="fd-alertas" aria-label="Cursos chegando no limite">
        <h3>Atenção às vagas</h3>
        <ul>${alertas.map(c => `<li class="fd-a-${c.situacao}"><b>${esc(c.nome)}</b><span>${esc(situacaoTexto(c))}</span><small>${c.total} matriculados · edital ${c.vagas} + 10% = ${c.limite}</small></li>`).join('')}</ul>
      </section>` : ''}

      <h3 class="fd-sub">Matrículas por curso</h3>
      <div class="fd-tabela-wrap">
        <table class="fd-tabela">
          <thead><tr><th scope="col">Curso</th><th scope="col" class="num">Matriculados</th><th scope="col" class="num">Vagas do edital</th><th scope="col" class="num">Vagas disponíveis</th><th scope="col">Situação</th></tr></thead>
          <tbody>${linhas || '<tr><td colspan="5" class="fd-zero">Nenhum calouro neste semestre ainda.</td></tr>'}</tbody>
          <tfoot><tr class="fd-total"><th scope="row">Total</th><td class="num" colspan="4"><b>${n(d.totais.total)}</b> calouros${d.totais.outros ? ` + <b>${n(d.totais.outros)}</b> outros períodos = <b>${n(d.totais.total + d.totais.outros)}</b> matrículas` : ''}${d.totais.hoje ? ` <span class="fd-mais">+${n(d.totais.hoje)} ${quando}</span>` : ''}</td></tr></tfoot>
        </table>
      </div>
      ${d.podeEditarVagas ? `<div class="fd-vagas-acoes fd-no-print">${editandoVagas
        ? '<button type="button" class="btn-secondary" id="fd-cancelar-vagas">Cancelar</button><button type="button" class="btn-primary" id="fd-salvar-vagas">Salvar vagas</button>'
        : `<button type="button" class="btn-secondary" id="fd-editar-vagas">Editar vagas do edital</button>${d.vagasAtualizadasEm ? `<small>Vagas atualizadas em ${new Date(d.vagasAtualizadasEm).toLocaleDateString('pt-BR')}${d.vagasAtualizadasPor ? ` por ${esc(d.vagasAtualizadasPor)}` : ''}</small>` : ''}`}</div>` : ''}

      <footer class="fd-rodape">
        <p>Calouro = ingresso em ${esc(semBR(d.semestre))} no 1º período. Outros períodos = aluno novo que entrou direto num período acima do 1º. Não conta quem cancelou, trancou, desistiu ou transferiu${d.totais.sairam ? ` (${n(d.totais.sairam)} até agora)` : ''}. Vagas disponíveis contam só os calouros do 1º período, já com a margem de 10% sobre as vagas do edital.</p>
        <p>Emitido em ${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} pelo Órbita · Contratos.</p>
      </footer>
    </article>`;
}

async function salvarVagas(btn) {
  const cursos = {};
  document.querySelectorAll('.fd-vaga-in').forEach(i => { if (i.value !== '') cursos[i.dataset.cod] = Number(i.value); });
  btn.disabled = true;
  try {
    await ctx.apiFetch('/contratos/vagas-mec', { method: 'PUT', body: JSON.stringify({ cursos }) });
    ctx.showToast('Vagas do edital salvas.');
    editandoVagas = false;
    await carregar();
  } catch (err) {
    ctx.showToast(err.message, 'error');
    btn.disabled = false;
  }
}
