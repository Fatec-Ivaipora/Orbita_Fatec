// ==========================================================================================
// Aplicação de Provas › aba RESULTADOS DO AVA (25/11/2026; tela nova em 26/11/2026)
// Para cada prova que já aconteceu: quem fez (com a nota), quem não fez (lista da 2ª chamada) e a média,
// lidos no AVA pelo agente do droplet (scripts/ava-banco-med-agente.js). Só coordenação de Medicina e ADM.
// 26/11: no molde da tela de resultado da Correção de Provas — números no topo, distribuição das notas, abas
// Alunos / 2ª chamada / Questões, ANULAR questão (o servidor reconta as notas) e "Arquivo para o Edubox"
// (Nome;Nota). A nota final é REDONDA, pela regra matemática: 24,4 → 24 e 24,5 → 25.
// Rotas: src/rotas/aplicacao-provas-med.js (/resultados, /resultados/:id, /resultados/:id/anuladas).
// ==========================================================================================
import { escapeHTML as esc } from "../../core/security.js";

const ETAPA = { b1: '1ª chamada · 1º bimestre', b2: '1ª chamada · 2º bimestre', sub: '2ª chamada', exame: 'Exame' };
const ETAPA_CURTA = { b1: '1º bim.', b2: '2º bim.', sub: '2ª chamada', exame: 'Exame' };
const SITUACAO = { finalizada: 'Fez', nao_fez: 'Não fez', em_andamento: 'Começou e não enviou', nao_enviada: 'Não enviou', outra: 'Outra' };
const dataBr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const diaSemana = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '') : '');
const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const dec = (n, c = 2) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: c }));
// regra matemática: a partir de ,5 sobe (24,5 → 25); o 1e-9 evita 24,4999… de conta com vírgula flutuante
const redonda = (n) => (n === null || n === undefined ? null : Math.round(Number(n) + 1e-9));
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

const IC = {
  abrir: '<svg class="ap-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
  voltar: '<svg class="ap-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m6 6-6-6 6-6"/></svg>',
  ler: '<svg class="ap-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  ligar: '<svg class="ap-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  baixar: '<svg class="ap-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/></svg>',
  copiar: '<svg class="ap-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  anular: '<svg class="ap-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m6.5 6.5 11 11"/></svg>',
  desfazer: '<svg class="ap-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  dispensa: '<svg class="ap-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 11-7.4M16 19l2 2 4-4"/></svg>'
};

export function criarResultados({ api, toast, BASE, dadosAtuais }) {
  let lista = null;         // resumo de todas (sem alunos)
  let aberta = null;        // detalhe da prova aberta
  let aba = 'alunos';       // aba do detalhe
  let busca = '';
  let ordem = 'nome';       // alunos: 'nome' | 'nota'
  let carregando = false;
  let alvo = null;          // elemento onde a aba desenha

  async function carregar() {
    if (carregando) return;
    carregando = true;
    try { lista = await api(`${BASE}/resultados?semestre=${encodeURIComponent(dadosAtuais().semestre)}`); }
    catch (e) { lista = { erro: e.message }; }
    finally { carregando = false; desenhar(); }
  }
  async function recarregarAberta() {
    if (!aberta) return;
    aberta = await api(`${BASE}/resultados/${encodeURIComponent(aberta.id)}`);
    lista = null; carregar();
  }

  function provasPassadas() {
    const hoje = new Date().toLocaleDateString('sv-SE');
    return (dadosAtuais().provas || []).filter(p => p.tipo === 'prova' && p.data && p.data <= hoje)
      .sort((a, b) => b.data.localeCompare(a.data) || String(a.turma).localeCompare(String(b.turma)));
  }
  const kpi = (cls, rot, val, dica) => `<div class="kpi-card ${cls}"><div class="kpi-label">${rot}</div><div class="kpi-value ar-num">${val}</div><div class="kpi-hint">${dica}</div></div>`;

  // ---------------- lista de provas ----------------
  function linhaProva(p, r) {
    let res, acao;
    if (r && r.status === 'ok') {
      const c = r.contagem || {};
      res = `<span class="ar-pill ar-pill-ok">Lido</span>${(r.anuladas || []).length ? ` <span class="ar-pill ar-pill-anul">${plural(r.anuladas.length, 'questão anulada', 'questões anuladas')}</span>` : ''}
        <div class="ar-res-linha"><span><b>${c.fizeram}</b> ${c.fizeram === 1 ? 'fez' : 'fizeram'}</span><span><b>${c.naoFizeram}</b> não ${c.naoFizeram === 1 ? 'fez' : 'fizeram'}</span><span>média <b>${dec(r.media, 1)}</b> de ${dec(r.notaMax)}</span></div>`;
      acao = `<button type="button" class="ap-btn ap-btn-pri" data-ar-abrir="${esc(p.id)}">Ver resultado${IC.abrir}</button>`;
    } else {
      if (!r) res = '<span class="ar-pill ar-pill-espera">Ainda não lido</span>';
      else if (r.status === 'aberta') res = '<span class="ar-pill ar-pill-espera">Questionário ainda aberto</span><small>o AVA é lido quando o questionário fechar</small>';
      else res = `<span class="ar-pill ar-pill-alerta">Precisa de atenção</span><span class="ar-erro">${esc(r.erro || 'não consegui ler no AVA')}</span>`;
      acao = `<button type="button" class="ap-btn" data-ar-ligar="${esc(p.id)}">${IC.ligar}Ligar ao questionário</button>`;
    }
    return `<tr>
      <td class="ar-data"><b>${dataBr(p.data).slice(0, 5)}</b><small>${diaSemana(p.data)}</small></td>
      <td><span class="ar-turma">${esc(p.turma)}</span></td>
      <td class="ar-prova"><b>${esc(p.disciplina)}</b><small>${ETAPA[p.etapa] || esc(p.etapa)}${r && r.quiz ? ` · ${esc(r.quiz)}` : ''}</small>${r && r.aviso ? `<span class="ar-erro">${esc(r.aviso)}</span>` : ''}</td>
      <td>${res}${r && r.lidoEm ? `<small>lido em ${quando(r.lidoEm)}</small>` : ''}</td>
      <td class="ar-acao">${acao}</td>
    </tr>`;
  }

  function desenharLista() {
    if (!lista) return '<div class="ap-vazio">Carregando os resultados do AVA…</div>';
    if (lista.erro) return `<div class="ap-vazio">${esc(lista.erro)}</div>`;
    const porProva = new Map((lista.resultados || []).map(r => [r.provaId || r.id, r]));
    const provas = provasPassadas();
    const vivo = lista.agente && lista.agente.vivoEm && Date.now() - new Date(lista.agente.vivoEm).getTime() < 15 * 60000;
    const lidas = provas.filter(p => (porProva.get(p.id) || {}).status === 'ok').length;
    const atencao = provas.filter(p => { const r = porProva.get(p.id); return r && !['ok', 'aberta'].includes(r.status); }).length;
    const naoFizeram = provas.reduce((s, p) => { const r = porProva.get(p.id); return s + (r && r.status === 'ok' ? (r.contagem || {}).naoFizeram || 0 : 0); }, 0);
    return `<div class="ar">
      <div class="ar-faixa">
        <p>Quem fez cada prova no AVA, a nota e quem não fez (lista da 2ª chamada). O AVA é lido sozinho depois que o questionário fecha.
          <span class="ar-agente ${vivo ? '' : 'fora'}">${vivo ? 'Leitura automática funcionando' : 'Leitura automática fora do ar — avise o Suporte AVA'}</span></p>
        <button type="button" class="ap-btn" data-ar-agora>${IC.ler}Ler agora no AVA</button>
      </div>
      <div class="ar-kpis">
        ${kpi('', 'Provas lidas', `${lidas}<small>de ${provas.length}</small>`, 'provas que já aconteceram neste semestre')}
        ${kpi('kpi-perda', 'Alunos para a 2ª chamada', naoFizeram, 'somando as provas já lidas')}
        ${kpi(atencao ? 'kpi-alerta' : 'kpi-verde', 'Precisam de atenção', atencao, atencao ? 'ligue ao questionário do AVA' : 'nenhuma prova com problema')}
      </div>
      ${provas.length ? `<div class="ar-caixa"><div class="ar-tab-wrap"><table class="ar-tab"><thead><tr><th>Data</th><th>Turma</th><th>Prova</th><th>Resultado</th><th class="dir">Ação</th></tr></thead>
        <tbody>${provas.map(p => linhaProva(p, porProva.get(p.id))).join('')}</tbody></table></div></div>` : '<div class="ap-vazio">Nenhuma prova aconteceu ainda neste semestre.</div>'}
    </div>`;
  }

  // ---------------- detalhe de uma prova ----------------
  function distribuicao(fizeram, notaMax) {
    const n = 10;
    const faixas = Array.from({ length: n }, () => 0);
    fizeram.forEach(a => { const i = Math.min(n - 1, Math.floor((Number(a.nota) || 0) / notaMax * n)); faixas[Math.max(0, i)]++; });
    const max = Math.max(1, ...faixas);
    const rot = (i) => dec(Math.round(notaMax / n * i * 10) / 10, 1);
    return `<div class="ar-caixa">
      <div class="ar-caixa-cab"><h3>Distribuição das notas <small>nota de 0 a ${dec(notaMax)}</small></h3>
        <div class="ar-legenda"><span><i style="background:#004F9F"></i>metade ou mais</span><span><i style="background:#E3A39C"></i>abaixo da metade</span></div></div>
      <div class="ar-hist" style="--n:${n}" role="img" aria-label="Quantos alunos em cada faixa de nota">
        ${faixas.map((q, i) => `<div class="ar-hist-col" title="${rot(i)} a ${rot(i + 1)}: ${plural(q, 'aluno', 'alunos')}"><span class="ar-hist-n">${q || ''}</span><div class="ar-hist-barra ${q ? (i < n / 2 ? 'baixa' : '') : 'vazia'}" style="height:${q / max * 100}%"></div></div>`).join('')}
      </div>
      <div class="ar-hist-eixo" style="--n:${n}">${faixas.map((_, i) => `<span>${rot(i)}–${rot(i + 1)}</span>`).join('')}</div>
    </div>`;
  }

  function celulaNota(a, notaMax) {
    const final = redonda(a.nota);
    const recontada = a.notaAva !== undefined && a.notaAva !== a.nota;
    return `<span class="ar-nota ${final !== null && final < notaMax / 2 ? 'baixa' : ''}">${final === null ? '–' : final}<small>/ ${dec(notaMax)}</small></span>
      <small class="ar-ava">${recontada ? `<s>AVA ${dec(a.notaAva)}</s><b>recontada ${dec(a.nota)}</b>` : `AVA ${dec(a.nota)}`}</small>`;
  }

  function abaAlunos(r, fizeram) {
    const termo = busca.trim().toLowerCase();
    const lista = fizeram.filter(a => !termo || a.nome.toLowerCase().includes(termo) || String(a.ra || '').includes(termo))
      .sort((a, b) => ordem === 'nota' ? (b.nota || 0) - (a.nota || 0) || a.nome.localeCompare(b.nome, 'pt-BR') : a.nome.localeCompare(b.nome, 'pt-BR'));
    const th = (k, rot, cls = '') => `<th class="${cls}"><button type="button" class="ar-th-ord" data-ar-ordem="${k}" ${ordem === k ? `aria-sort="${k === 'nota' ? 'descending' : 'ascending'}"` : ''}>${rot}${ordem === k ? ' ↓' : ''}</button></th>`;
    return `<div class="ar-ferr"><input type="search" class="ar-busca" data-ar-busca placeholder="Procurar aluno pelo nome ou RA" value="${esc(busca)}" aria-label="Procurar aluno">
        <p>Nota final redonda pela regra matemática (24,4 → 24 · 24,5 → 25). Embaixo, a nota com casas que veio do AVA.</p></div>
      <div class="ar-tab-wrap"><table class="ar-tab"><thead><tr>${th('nome', 'Aluno')}<th>RA</th>${th('nota', 'Nota final', 'dir')}<th class="dir">Tempo</th></tr></thead><tbody>
      ${lista.map(a => `<tr><td><b>${esc(a.nome)}</b>${a.tentativas > 1 ? `<small>${a.tentativas} tentativas (vale a melhor)</small>` : ''}</td>
        <td>${esc(a.ra || '') || '<span class="ap-falta">sem RA</span>'}</td>
        <td class="dir">${celulaNota(a, r.notaMax)}</td><td class="dir ar-num">${esc(a.duracao || '–')}</td></tr>`).join('') || '<tr><td colspan="4" class="ap-nada">Ninguém com esse nome.</td></tr>'}
      </tbody></table></div>`;
  }

  // 2ª chamada: quem ficou sem nota. "Dispensado" (aluno que não precisa fazer a prova) sai da lista.
  function abaSegunda(outros) {
    const vao = outros.filter(a => !a.dispensado), disp = outros.filter(a => a.dispensado);
    if (!outros.length) return '<div class="ap-vazio" style="margin:1rem">Todos fizeram a prova. Não há 2ª chamada.</div>';
    const linha = (a, dispensado) => `<tr><td><b>${esc(a.nome)}</b></td><td>${esc(a.ra || '') || '<span class="ap-falta">sem RA</span>'}</td><td>${dispensado ? '<span class="ar-pill ar-pill-espera">Dispensado</span>' : SITUACAO[a.situacao] || esc(a.situacao)}</td>
      <td class="ar-acao">${dispensado
        ? `<button type="button" class="ap-btn" data-ar-dispensa="${esc(a.nome)}" data-ar-valor="0">${IC.desfazer}Voltar para a 2ª chamada</button>`
        : `<button type="button" class="ap-btn" data-ar-dispensa="${esc(a.nome)}" data-ar-valor="1">${IC.dispensa}Dispensado</button>`}</td></tr>`;
    return `<div class="ar-ferr"><p>${vao.length ? `${plural(vao.length, 'aluno vai', 'alunos vão')} para a 2ª chamada.` : 'Ninguém vai para a 2ª chamada.'} Se o aluno não precisa fazer a prova (dispensa), clique em <b>Dispensado</b>: ele sai da lista.</p>
        ${vao.length ? `<button type="button" class="ap-btn" data-ar-copiar>${IC.copiar}Copiar a lista</button>` : ''}</div>
      ${vao.length ? `<div class="ar-tab-wrap"><table class="ar-tab"><thead><tr><th>Aluno</th><th>RA</th><th>Situação no AVA</th><th class="dir">Ação</th></tr></thead><tbody>
        ${vao.map(a => linha(a, false)).join('')}</tbody></table></div>` : ''}
      ${disp.length ? `<div class="ar-ferr" style="border-top:1px solid var(--orb-linha)"><p><b>Dispensados (${disp.length})</b> — não fazem a prova e não entram na 2ª chamada.</p></div>
        <div class="ar-tab-wrap"><table class="ar-tab"><tbody>${disp.map(a => linha(a, true)).join('')}</tbody></table></div>` : ''}`;
  }

  function abaQuestoes(r) {
    const qs = r.porQuestao || [];
    if (!qs.length) return `<div class="ar-aviso" style="margin:1rem">
        <b>Para anular uma questão, o Órbita precisa da nota de cada questão de cada aluno</b>, e esta leitura do AVA foi feita antes de o Órbita guardar isso.
        Clique em <b>Ler de novo no AVA</b>: em alguns minutos as questões aparecem aqui, cada uma com o botão <b>Anular</b>, e as notas são recontadas na hora.
        <div style="margin-top:0.7rem"><button type="button" class="ap-btn ap-btn-pri" data-ar-agora>${IC.ler}Ler de novo no AVA</button></div></div>`;
    return `<div class="ar-ferr"><p>Anular dá a todos que fizeram a prova o valor cheio da questão, e as notas são recontadas na hora. Questões em vermelho: menos da metade acertou.</p></div>
      ${r.podeAnular ? '' : '<div class="ar-aviso" style="margin:0 1rem 0.75rem">Alguns alunos vieram sem a nota de cada questão nesta leitura: leia de novo no AVA antes de anular.</div>'}
      <div class="ar-tab-wrap"><table class="ar-tab"><thead><tr><th>Questão</th><th class="dir">Valor</th><th>Acerto da turma</th><th class="dir">Ação</th></tr></thead><tbody>
      ${qs.map(q => {
        const p = q.acerto === null ? null : q.acerto;
        return `<tr class="${q.anulada ? 'anulada' : p !== null && p < 0.5 ? 'ruim' : ''}">
          <td><span class="ar-q-n">${q.n}</span>${q.anulada ? ' <span class="ar-pill ar-pill-anul">anulada</span>' : ''}</td>
          <td class="dir ar-num">${dec(q.max)}</td>
          <td><div class="ar-barra"><span style="width:${(p || 0) * 100}%"></span></div><small>${p === null ? 'sem respostas' : `${dec(p * 100, 0)}% de acerto · ${plural(q.respostas, 'resposta', 'respostas')}`}</small></td>
          <td class="ar-acao">${q.anulada
            ? `<button type="button" class="ap-btn" data-ar-desanular="${q.n}">${IC.desfazer}Desfazer</button>`
            : `<button type="button" class="ap-btn ap-btn-perigo" data-ar-anular="${q.n}" ${r.podeAnular ? '' : 'disabled'}>${IC.anular}Anular</button>`}</td>
        </tr>`;
      }).join('')}
      </tbody></table></div>`;
  }

  function desenharDetalhe() {
    const r = aberta;
    const fizeram = r.alunos.filter(a => a.situacao === 'finalizada');
    const outros = r.alunos.filter(a => a.situacao !== 'finalizada');
    const segunda = outros.filter(a => !a.dispensado);
    const notas = fizeram.map(a => a.nota).filter(n => n !== null && n !== undefined);
    const maior = notas.length ? Math.max(...notas) : null, menor = notas.length ? Math.min(...notas) : null;
    const anul = r.anuladas || [];
    const corpo = aba === 'segunda' ? abaSegunda(outros) : aba === 'questoes' ? abaQuestoes(r) : abaAlunos(r, fizeram);
    const tab = (k, rot, n) => `<button type="button" role="tab" class="ar-aba" data-ar-aba="${k}" aria-selected="${aba === k}">${rot}<span>${n}</span></button>`;
    return `<div class="ar">
      <button type="button" class="ar-link" data-ar-voltar>${IC.voltar}Todas as provas</button>
      <div class="ar-cab">
        <div><h2>${esc(r.disciplina)} · ${esc(r.turma)}</h2>
          <p>${ETAPA[r.etapa] || esc(r.etapa)} · ${dataBr(r.data)} · ${esc(r.quiz || '')}<br>${esc(r.curso || '')} · lido no AVA em ${quando(r.lidoEm)}</p></div>
        <div class="ar-cab-acoes">
          <button type="button" class="ap-btn" data-ar-agora>${IC.ler}Ler de novo no AVA</button>
          <button type="button" class="ap-btn" data-ar-aba="questoes">${IC.anular}Anular questão</button>
          <button type="button" class="ap-btn ap-btn-pri" data-ar-edubox>${IC.baixar}Arquivo para o Edubox</button>
        </div>
      </div>
      ${anul.length ? `<div class="ar-aviso anul"><b>${anul.length === 1 ? `Questão ${anul[0]} anulada` : `Questões ${anul.join(', ')} anuladas`}</b>${r.anulacao && r.anulacao.por ? ` por ${esc(r.anulacao.por)} em ${quando(r.anulacao.em)}` : ''}. As notas abaixo já estão recontadas: quem fez a prova ganhou o valor cheio ${anul.length === 1 ? 'dessa questão' : 'dessas questões'}.</div>` : ''}
      ${r.semRa ? `<div class="ar-aviso">${esc(r.semRa)}</div>` : ''}
      <div class="ar-kpis">
        ${kpi('kpi-verde', 'Fizeram a prova', `${fizeram.length}<small>de ${r.alunos.length}</small>`, r.alunos.length ? `${dec(fizeram.length / r.alunos.length * 100, 0)}% dos alunos do curso no AVA` : '')}
        ${kpi('', 'Média da turma', `${dec(r.media, 1)}<small>de ${dec(r.notaMax)}</small>`, anul.length && r.mediaAva !== r.media ? `era ${dec(r.mediaAva, 1)} antes de anular` : 'só de quem fez a prova')}
        ${kpi('', 'Maior · menor', notas.length ? `${redonda(maior)} · ${redonda(menor)}` : '–', 'nota final, redonda')}
        ${kpi('kpi-perda', 'Não fizeram', segunda.length, `${segunda.length ? 'vão para a 2ª chamada' : 'ninguém para a 2ª chamada'}${outros.length - segunda.length ? ` · ${plural(outros.length - segunda.length, 'dispensado', 'dispensados')}` : ''}`)}
      </div>
      ${notas.length ? distribuicao(fizeram, r.notaMax || 10) : ''}
      <div class="ar-caixa">
        <div class="ar-abas" role="tablist" aria-label="Resultado da prova">${tab('alunos', 'Fizeram', fizeram.length)}${tab('segunda', '2ª chamada', segunda.length)}${tab('questoes', 'Anular questão', (r.porQuestao || []).length || '–')}</div>
        <div class="ar-aba-corpo" role="tabpanel">${corpo}</div>
      </div>
    </div>`;
  }

  function desenhar() { if (alvo) alvo.innerHTML = aberta ? desenharDetalhe() : desenharLista(); }

  // ---------------- Arquivo para o Edubox (mesmo modelo da Correção de Provas: Nome;Nota) ----------------
  function dialogoEdubox() {
    const r = aberta;
    const fizeram = r.alunos.filter(a => a.situacao === 'finalizada');
    const outros = r.alunos.filter(a => a.situacao !== 'finalizada' && !a.dispensado); // dispensado nunca entra com 0
    const ex = fizeram.slice(0, 2).map(a => `${a.nome};${redonda(a.nota)}`).join('\n');
    const fundo = document.createElement('div');
    fundo.className = 'ap-modal-fundo';
    fundo.innerHTML = `<div class="ap-modal" role="dialog" aria-modal="true" aria-labelledby="ar-ed-tit">
      <header><h2 id="ar-ed-tit">Arquivo para o Edubox</h2><button type="button" class="ap-x" data-fechar aria-label="Fechar">✕</button></header>
      <div class="ap-modal-corpo">
        <p class="ap-nota" style="font-size:0.9rem;color:var(--orb-tinta2)">Uma linha por aluno, <b>Nome;Nota</b>, igual ao arquivo da Correção de Provas. A nota sai <b>redonda</b>, pela regra matemática (24,4 → 24 · 24,5 → 25), na escala da prova (0 a ${dec(r.notaMax)})${(r.anuladas || []).length ? ', já com as questões anuladas' : ''}.</p>
        <div class="ar-exemplo">Nome;Nota\n${esc(ex)}${fizeram.length > 2 ? '\n…' : ''}</div>
        <div class="ar-modal-lista">
          <p style="margin:0">${plural(fizeram.length, 'aluno fez', 'alunos fizeram')} a prova e ${fizeram.length === 1 ? 'entra' : 'entram'} no arquivo.</p>
          ${outros.length ? `<label class="ar-check"><input type="checkbox" id="ar-ed-zero"> <span>Incluir também ${plural(outros.length, 'aluno que não fez', 'alunos que não fizeram')}, com nota 0.<br><small style="color:var(--orb-mudo)">Deixe desmarcado se ${outros.length === 1 ? 'ele vai' : 'eles vão'} fazer a 2ª chamada.</small></span></label>` : ''}
        </div>
      </div>
      <footer><span class="ap-esp"></span><button type="button" class="ap-btn" data-fechar>Cancelar</button><button type="button" class="ap-btn ap-btn-pri" data-ar-baixar>${IC.baixar}Baixar arquivo</button></footer>
    </div>`;
    document.body.appendChild(fundo);
    const fechar = () => fundo.remove();
    fundo.addEventListener('click', (e) => {
      if (e.target === fundo || e.target.closest('[data-fechar]')) { fechar(); return; }
      if (e.target.closest('[data-ar-baixar]')) {
        const zero = !!(fundo.querySelector('#ar-ed-zero') || {}).checked;
        baixarCsv(zero); fechar();
      }
    });
    fundo.querySelector('[data-ar-baixar]').focus();
  }
  function baixarCsv(incluirZero) {
    const r = aberta;
    const alunos = r.alunos.filter(a => a.situacao === 'finalizada' || (incluirZero && !a.dispensado)).slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    const linhas = ['Nome;Nota', ...alunos.map(a => `${String(a.nome).replace(/;/g, ' ')};${a.situacao === 'finalizada' ? redonda(a.nota) ?? 0 : 0}`)];
    const blob = new Blob(['﻿' + linhas.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const nome = ['Notas AVA', r.disciplina, r.turma, ETAPA_CURTA[r.etapa] || r.etapa, r.semestre].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]+/g, ' ');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = `${nome}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`Arquivo baixado: ${plural(alunos.length, 'aluno', 'alunos')}.`);
  }

  async function mudarAnuladas(nova, b) {
    b.disabled = true;
    try {
      const r = await api(`${BASE}/resultados/${encodeURIComponent(aberta.id)}/anuladas`, { method: 'PUT', body: JSON.stringify({ questoes: nova }) });
      toast(r.message);
      await recarregarAberta(); desenhar();
    } catch (err) { toast(err.message, 'erro'); b.disabled = false; }
  }

  async function clique(e) {
    const b = e.target.closest('button');
    if (!b || !alvo || !alvo.contains(b)) return;
    if (b.hasAttribute('data-ar-voltar')) { aberta = null; busca = ''; desenhar(); return; }
    if (b.dataset.arAba) { aba = b.dataset.arAba; desenhar(); return; }
    if (b.dataset.arOrdem) { ordem = b.dataset.arOrdem; desenhar(); return; }
    if (b.dataset.arAbrir) {
      b.disabled = true; b.textContent = 'Abrindo…';
      try { aberta = await api(`${BASE}/resultados/${encodeURIComponent(b.dataset.arAbrir)}`); aba = 'alunos'; busca = ''; desenhar(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (err) { toast(err.message, 'erro'); b.disabled = false; b.textContent = 'Ver resultado'; }
      return;
    }
    if (b.hasAttribute('data-ar-agora')) {
      b.disabled = true;
      try { const r = await api(`${BASE}/resultados/agora`, { method: 'POST' }); toast(r.message); setTimeout(() => { if (aberta) recarregarAberta().then(desenhar).catch(() => {}); else carregar(); }, 60000); }
      catch (err) { toast(err.message, 'erro'); } finally { b.disabled = false; }
      return;
    }
    if (b.hasAttribute('data-ar-edubox')) { dialogoEdubox(); return; }
    if (b.hasAttribute('data-ar-copiar')) {
      const t = aberta.alunos.filter(a => a.situacao !== 'finalizada' && !a.dispensado).map(a => `${a.nome}${a.ra ? `\t${a.ra}` : ''}`).join('\n');
      try { await navigator.clipboard.writeText(t); toast('Lista da 2ª chamada copiada.'); } catch { toast('Não consegui copiar.', 'erro'); }
      return;
    }
    if (b.dataset.arAnular) {
      const n = Number(b.dataset.arAnular);
      if (!window.confirm(`Anular a questão ${n}? Todos que fizeram a prova ganham o valor dela e as notas são recontadas. Dá para desfazer depois.`)) return;
      mudarAnuladas([...(aberta.anuladas || []), n], b); return;
    }
    if (b.dataset.arDispensa) {
      b.disabled = true;
      try {
        const r = await api(`${BASE}/resultados/${encodeURIComponent(aberta.id)}/dispensado`, { method: 'PUT', body: JSON.stringify({ nome: b.dataset.arDispensa, dispensado: b.dataset.arValor === '1' }) });
        toast(r.message); await recarregarAberta(); desenhar();
      } catch (err) { toast(err.message, 'erro'); b.disabled = false; }
      return;
    }
    if (b.dataset.arDesanular) {
      const n = Number(b.dataset.arDesanular);
      mudarAnuladas((aberta.anuladas || []).filter(x => x !== n), b); return;
    }
    if (b.dataset.arLigar) {
      const v = window.prompt('Cole o link (ou o número id=) do questionário desta prova no AVA. Deixe vazio para o Órbita voltar a procurar sozinho.');
      if (v === null) return;
      try { const r = await api(`${BASE}/provas/${encodeURIComponent(b.dataset.arLigar)}/ava`, { method: 'PUT', body: JSON.stringify({ cmid: v }) }); toast(`${r.message} Clique em "Ler agora no AVA".`); }
      catch (err) { toast(err.message, 'erro'); }
    }
  }
  function digitar(e) {
    if (!alvo || !e.target.matches('[data-ar-busca]')) return;
    busca = e.target.value;
    const pos = e.target.selectionStart;
    desenhar();
    const campo = alvo.querySelector('[data-ar-busca]');
    if (campo) { campo.focus(); campo.setSelectionRange(pos, pos); }
  }
  document.addEventListener('click', clique);
  document.addEventListener('input', digitar);

  return {
    render(el) { alvo = el; desenhar(); if (!lista && !carregando) carregar(); },
    sair() { alvo = null; }
  };
}
