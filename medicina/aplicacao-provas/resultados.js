// ==========================================================================================
// Aplicação de Provas › aba RESULTADOS DO AVA (25/11/2026)
// Para cada prova que já aconteceu: quem fez (com a nota), quem não fez (lista da 2ª chamada) e a média,
// lidos no AVA pelo agente do droplet (scripts/ava-banco-med-agente.js). Só coordenação de Medicina e ADM.
// Rotas: src/rotas/aplicacao-provas-med.js (/resultados).
// ==========================================================================================
import { escapeHTML as esc } from "../../core/security.js";

const ETAPA = { b1: '1ª chamada · 1º bim.', b2: '1ª chamada · 2º bim.', sub: '2ª chamada', exame: 'Exame' };
const SITUACAO = { finalizada: 'Fez', nao_fez: 'Não fez', em_andamento: 'Começou e não enviou', nao_enviada: 'Não enviou', outra: 'Outra' };
const dataBr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const nota = (n) => (n === null || n === undefined ? '–' : String(n).replace('.', ','));

export function criarResultados({ api, toast, BASE, dadosAtuais }) {
  let lista = null;         // resumo de todas (sem alunos)
  let aberta = null;        // detalhe da prova aberta
  let carregando = false;
  let alvo = null;          // elemento onde a aba desenha

  async function carregar() {
    if (carregando) return;
    carregando = true;
    try { lista = await api(`${BASE}/resultados?semestre=${encodeURIComponent(dadosAtuais().semestre)}`); }
    catch (e) { lista = { erro: e.message }; }
    finally { carregando = false; desenhar(); }
  }

  function provasPassadas() {
    const hoje = new Date().toLocaleDateString('sv-SE');
    return (dadosAtuais().provas || []).filter(p => p.tipo === 'prova' && p.data && p.data <= hoje)
      .sort((a, b) => b.data.localeCompare(a.data) || String(a.turma).localeCompare(String(b.turma)));
  }

  function linhaProva(p, r) {
    let situacao;
    if (!r) situacao = '<span class="ar-s ar-s-espera">Ainda não lido</span>';
    else if (r.status === 'ok') situacao = `<span class="ar-s ar-s-ok"><b>${r.contagem.fizeram}</b> ${r.contagem.fizeram === 1 ? 'fez' : 'fizeram'} · <b>${r.contagem.naoFizeram}</b> não ${r.contagem.naoFizeram === 1 ? 'fez' : 'fizeram'}${r.contagem.outros ? ` · ${r.contagem.outros} não enviaram` : ''}</span><span class="ar-media">média ${nota(r.media)} / ${nota(r.notaMax)}</span>`;
    else if (r.status === 'aberta') situacao = '<span class="ar-s ar-s-espera">Questionário ainda aberto</span>';
    else situacao = `<span class="ar-s ar-s-alerta">${esc(r.erro || 'não consegui ler')}</span>`;
    const botao = r && r.status === 'ok' ? `<button type="button" class="ar-btn" data-ar-abrir="${esc(p.id)}">Ver alunos</button>`
      : `<button type="button" class="ar-btn ar-btn-sec" data-ar-ligar="${esc(p.id)}">Ligar ao questionário</button>`;
    return `<tr>
      <td data-r="Data"><b>${dataBr(p.data)}</b></td>
      <td data-r="Turma">${esc(p.turma)}</td>
      <td data-r="Prova">${esc(p.disciplina)}<small>${ETAPA[p.etapa] || esc(p.etapa)}${r && r.quiz ? ` · ${esc(r.quiz)}` : ''}</small>${r && r.aviso ? `<small class="ar-aviso">${esc(r.aviso)}</small>` : ''}</td>
      <td data-r="Resultado">${situacao}${r && r.lidoEm ? `<small>lido ${quando(r.lidoEm)}</small>` : ''}</td>
      <td data-r="">${botao}</td>
    </tr>`;
  }

  function desenharLista() {
    if (!lista) return '<div class="ap-vazio">Carregando os resultados do AVA…</div>';
    if (lista.erro) return `<div class="ap-vazio">${esc(lista.erro)}</div>`;
    const porProva = new Map((lista.resultados || []).map(r => [r.provaId || r.id, r]));
    const provas = provasPassadas();
    const vivo = lista.agente && lista.agente.vivoEm && Date.now() - new Date(lista.agente.vivoEm).getTime() < 15 * 60000;
    return `<div class="ar">
      <div class="ar-topo">
        <p>Quem fez cada prova no AVA, a nota e quem não fez (lista da 2ª chamada). O AVA é lido sozinho depois que o questionário fecha${vivo ? '' : ' — <b>a leitura automática está fora do ar</b>, avise o Suporte AVA'}.</p>
        <button type="button" class="ar-btn" data-ar-agora>Ler agora no AVA</button>
      </div>
      ${provas.length ? `<div class="ar-tabela-caixa"><table class="ar-tabela"><thead><tr><th>Data</th><th>Turma</th><th>Prova</th><th>Resultado</th><th></th></tr></thead>
        <tbody>${provas.map(p => linhaProva(p, porProva.get(p.id))).join('')}</tbody></table></div>` : '<div class="ap-vazio">Nenhuma prova aconteceu ainda neste semestre.</div>'}
    </div>`;
  }

  function desenharDetalhe() {
    const r = aberta;
    const fizeram = r.alunos.filter(a => a.situacao === 'finalizada');
    const outros = r.alunos.filter(a => a.situacao !== 'finalizada');
    const tabela = (alunos, comNota) => `<div class="ar-tabela-caixa"><table class="ar-tabela"><thead><tr><th>Aluno</th><th>RA</th>${comNota ? '<th>Nota</th><th>Duração</th>' : '<th>Situação</th>'}</tr></thead><tbody>
      ${alunos.map(a => `<tr><td data-r="Aluno">${esc(a.nome)}${a.tentativas > 1 ? ` <small>(${a.tentativas} tentativas)</small>` : ''}</td><td data-r="RA">${esc(a.ra || '') || '<span class="ap-falta">sem RA</span>'}</td>
        ${comNota ? `<td data-r="Nota"><b>${nota(a.nota)}</b></td><td data-r="Duração">${esc(a.duracao || '')}</td>` : `<td data-r="Situação">${SITUACAO[a.situacao] || esc(a.situacao)}</td>`}</tr>`).join('')}
    </tbody></table></div>`;
    return `<div class="ar">
      <button type="button" class="ar-voltar" data-ar-voltar>← Todas as provas</button>
      <h2 class="ar-tit">${esc(r.disciplina)} · ${esc(r.turma)} · ${ETAPA[r.etapa] || esc(r.etapa)} · ${dataBr(r.data)}</h2>
      <p class="ar-sub">${esc(r.curso)} › ${esc(r.quiz)} · lido no AVA em ${quando(r.lidoEm)}${r.semRa ? ` · ${esc(r.semRa)}` : ''}</p>
      <div class="ar-numeros"><span><b>${fizeram.length}</b> fizeram</span><span><b>${outros.length}</b> não fizeram</span><span>média <b>${nota(r.media)}</b> de ${nota(r.notaMax)}</span></div>
      <h3>Não fizeram — 2ª chamada (${outros.length})</h3>
      ${outros.length ? `${tabela(outros, false)}<button type="button" class="ar-btn ar-btn-sec" data-ar-copiar>Copiar a lista</button>` : '<p class="ap-vazio">Todos fizeram a prova.</p>'}
      <h3>Fizeram (${fizeram.length}) · nota de 0 a ${nota(r.notaMax)}</h3>
      ${tabela(fizeram, true)}
    </div>`;
  }

  function desenhar() { if (alvo) alvo.innerHTML = aberta ? desenharDetalhe() : desenharLista(); }

  async function clique(e) {
    const b = e.target.closest('button');
    if (!b || !alvo || !alvo.contains(b)) return;
    if (b.hasAttribute('data-ar-voltar')) { aberta = null; desenhar(); return; }
    if (b.dataset.arAbrir) {
      b.disabled = true; b.textContent = 'Abrindo…';
      try { aberta = await api(`${BASE}/resultados/${encodeURIComponent(b.dataset.arAbrir)}`); desenhar(); window.scrollTo({ top: 0 }); }
      catch (err) { toast(err.message, 'erro'); b.disabled = false; b.textContent = 'Ver alunos'; }
      return;
    }
    if (b.hasAttribute('data-ar-agora')) {
      b.disabled = true;
      try { const r = await api(`${BASE}/resultados/agora`, { method: 'POST' }); toast(r.message); setTimeout(carregar, 60000); }
      catch (err) { toast(err.message, 'erro'); } finally { b.disabled = false; }
      return;
    }
    if (b.hasAttribute('data-ar-copiar')) {
      const t = aberta.alunos.filter(a => a.situacao !== 'finalizada').map(a => `${a.nome}${a.ra ? `\t${a.ra}` : ''}`).join('\n');
      try { await navigator.clipboard.writeText(t); toast('Lista copiada.'); } catch { toast('Não consegui copiar.', 'erro'); }
      return;
    }
    if (b.dataset.arLigar) {
      const v = window.prompt('Cole o link (ou o número id=) do questionário desta prova no AVA. Deixe vazio para o Órbita voltar a procurar sozinho.');
      if (v === null) return;
      try { const r = await api(`${BASE}/provas/${encodeURIComponent(b.dataset.arLigar)}/ava`, { method: 'PUT', body: JSON.stringify({ cmid: v }) }); toast(`${r.message} Clique em "Ler agora no AVA".`); }
      catch (err) { toast(err.message, 'erro'); }
    }
  }
  document.addEventListener('click', clique);

  return {
    render(el) { alvo = el; desenhar(); if (!lista && !carregando) carregar(); },
    sair() { alvo = null; }
  };
}
