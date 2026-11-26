// Portfólio Reflexivo — "Como usar" (23/11/2026). Tutorial dentro do módulo (botão no cabeçalho, #ajuda).
// A parte da coordenação só aparece para quem configura as turmas (coordenação/ADM/CADAM).
// Se mudar o fluxo da tela (app.js) ou a matriz (matriz.js), atualizar aqui também.

const cam = (t) => `<span class="pf-tut-cam">${t}</span>`;

const COORDENACAO = `
<section class="pf-tut-bloco" id="tut-coordenacao">
  <span class="pf-tut-quem">Coordenação de Medicina · uma vez por semestre</span>
  <h2>Preparar as turmas</h2>
  <ol class="pf-tut-passos">
    <li><div><h3>Liberar o módulo no menu</h3>
      <p>Em ${cam('Usuários → Gerência de Acessos')}, dê nível de acesso ao módulo <b>Portfólio Reflexivo</b> para os cargos Coordenação Medicina e Professor Medicina. Sem isso, o módulo não aparece no menu.</p></div></li>
    <li><div><h3>Revisar cada turma</h3>
      <p>Na lista de turmas, clique em <b>Configurar</b>. Em 2026.2, a T3 (2º período), a T2 (4º) e a T1 (5º) já vêm preenchidas com o texto dos documentos da coordenação. Confira:</p>
      <ul><li><b>Objetivos específicos</b>, um por linha. Eles são contados no Critério 3.</li><li>Questão norteadora, tema e instruções específicas da turma.</li></ul></div></li>
    <li><div><h3>Escolher os professores corretores</h3>
      <p>Na mesma tela, marque quem corrige aquela turma e clique em <b>Salvar turma</b>. Cada professor só enxerga as turmas em que foi marcado. A coordenação vê todas.</p></div></li>
  </ol>
  <p class="pf-tut-nota">Semestre novo: escolha o semestre no topo e use <b>Copiar turmas de outro semestre</b>. Os objetivos e as instruções vêm junto; os corretores ficam em branco para você escolher de novo.</p>
  <p class="pf-tut-nota pf-tut-alerta"><b>Os critérios não mudam por turma.</b> Os 4 critérios, os níveis e os pontos são fixos e iguais para todos. Por turma muda só o bloco específico: objetivos, questão norteadora e instruções.</p>
</section>`;

const PROFESSOR = `
<section class="pf-tut-bloco" id="tut-professor">
  <span class="pf-tut-quem">Professor corretor · a cada portfólio</span>
  <h2>Corrigir os portfólios da turma</h2>
  <ol class="pf-tut-passos">
    <li><div><h3>Criar a atividade</h3>
      <p>No card da sua turma, clique em <b>+ Atividade</b> e dê um nome, por exemplo "Portfólio 1". Se ela já existe, é só abrir.</p></div></li>
    <li><div><h3>Baixar as entregas no AVA</h3>
      <p>No AVA, abra a Tarefa do portfólio → ${cam('Ver todos os envios')} → ${cam('Ação de avaliação')} → <b>Baixar todas as tarefas enviadas</b>. Vem um arquivo .zip com os trabalhos de todos os alunos.</p></div></li>
    <li><div><h3>Importar o ZIP no Órbita</h3>
      <p>Na atividade, clique em <b>Importar ZIP do AVA</b> e escolha o arquivo. Não precisa descompactar. O Órbita reconhece cada aluno pelo nome e pelo número de participante do AVA.</p>
      <ul><li>O Órbita lê <b>PDF, Word (.docx), LibreOffice (.odt), PowerPoint (.pptx e .odp), .txt e .rtf</b>. Foto do trabalho (.jpg, .png) aparece na tela, mas sem texto.</li>
        <li>"Sem texto" indica que o arquivo foi escaneado ou é uma foto. Corrija pelo arquivo original.</li>
        <li>"Arquivo sem leitura" indica um formato que o Órbita não abre (por exemplo, o .doc antigo). Baixe para abrir e, se for o caso, peça ao aluno em .docx ou PDF.</li></ul></div></li>
    <li><div><h3>Corrigir pela matriz</h3>
      <p>Clique no aluno. O trabalho fica à esquerda e a matriz à direita. Em cada critério:</p>
      <ul><li><b>C1 e C4:</b> escolha o nível. Cada opção mostra o descritor e quando aplicar.</li>
        <li><b>C2:</b> marque se a análise é consistente, superficial ou ausente, e se o texto identifica necessidades e propõe ações. O nível sai dessas marcações.</li>
        <li><b>C3:</b> marque os objetivos da turma que o portfólio menciona, discute e atinge. O nível sai da proporção.</li>
        <li>Em todos os critérios, escreva a <b>evidência</b>: o trecho entre aspas ou a página. É obrigatória.</li></ul>
      <p>A nota aparece na barra de baixo, somada automaticamente. Ninguém digita nota.</p></div></li>
    <li><div><h3>Feedback, conformidade e condições especiais</h3>
      <p>Preencha os três campos de feedback (pontos fortes, a desenvolver e recomendação prática). Em seguida registre a capa, a formatação e se houve entrega por outro canal; isso não altera a nota. Atraso de até 48h e plágio só entram na nota se você marcar.</p></div></li>
    <li><div><h3>Salvar ou finalizar</h3>
      <p><b>Salvar rascunho</b> guarda a correção mesmo incompleta. <b>Finalizar</b> só funciona com os 4 níveis, as 4 evidências e o feedback preenchidos; depois ele já abre o próximo aluno pendente. Uma correção finalizada pode ser reaberta: é só alterar e salvar de novo.</p></div></li>
    <li><div><h3>Conferir a similaridade</h3>
      <p>A aba <b>Similaridade</b> compara todos os portfólios da atividade e mostra os trechos longos iguais entre dois alunos, com gravidade baixa, média ou alta. Referências e o que quase todos copiaram do plano de ensino não contam. Quem decide se é plágio é você.</p></div></li>
    <li><div><h3>Devolver as notas ao AVA</h3>
      <p>Na Tarefa do AVA: ${cam('Ação de avaliação')} → <b>Baixar planilha de avaliação</b>. No Órbita, aba <b>Quadro-resumo e AVA</b> → <b>Preencher planilha de avaliação do AVA</b> e escolha esse arquivo. Ele volta com a nota e o feedback de cada correção finalizada. No AVA: ${cam('Ação de avaliação')} → <b>Enviar planilha de avaliação</b>, confira a prévia e confirme.</p></div></li>
  </ol>
  <p class="pf-tut-nota pf-tut-alerta"><b>A opção de planilha não aparece no AVA?</b> Nas configurações da Tarefa, em Tipos de feedback, ative <b>Planilha de avaliação offline</b>. Basta fazer uma vez por Tarefa.</p>
  <p class="pf-tut-nota">Na mesma aba ficam o <b>relatório da turma para imprimir</b> (quadro-resumo, similaridade e cada avaliação com as evidências) e a <b>planilha para Excel</b>.</p>
</section>`;

const niv = (n, t) => `<span class="pf-tag-nivel pf-n-${n}">${t}</span>`;
const MATRIZ = `
<section class="pf-tut-bloco" id="tut-matriz">
  <span class="pf-tut-quem">Para todos</span>
  <h2>Como a nota é calculada</h2>
  <p>A nota é a soma dos quatro critérios, no máximo 10,0, sem média e sem arredondamento.</p>
  <div class="pf-tab-wrap"><table class="pf-tab pf-tut-tab">
    <thead><tr><th>Critério</th><th class="num">Ótimo</th><th class="num">Bom</th><th class="num">Deve melhorar</th><th class="num">Insuficiente</th></tr></thead>
    <tbody>
      <tr><td>1. Descrição do confronto experimental</td><td class="num">3,0</td><td class="num">1,5</td><td class="num">0,0</td><td class="num">0,0</td></tr>
      <tr><td>2. Análise de situações vivenciadas</td><td class="num">3,0</td><td class="num">1,5</td><td class="num">0,0</td><td class="num">0,0</td></tr>
      <tr><td>3. Desenvolvimento de objetivos</td><td class="num">2,0</td><td class="num">1,0</td><td class="num">0,0</td><td class="num">0,0</td></tr>
      <tr><td>4. Organização e clareza na escrita</td><td class="num">2,0</td><td class="num">1,0</td><td class="num">0,0</td><td class="num">0,0</td></tr>
    </tbody></table></div>
  <h3>Critério 2: os três elementos</h3>
  <div class="pf-tab-wrap"><table class="pf-tab pf-tut-tab">
    <thead><tr><th>Análise crítica</th><th>Necessidades</th><th>Propõe ações</th><th>Nível</th></tr></thead>
    <tbody>
      <tr><td>Consistente</td><td>sim</td><td>sim</td><td>${niv('o', 'Ótimo')}</td></tr>
      <tr><td>Consistente</td><td colspan="2">só um dos dois</td><td>${niv('b', 'Bom')}</td></tr>
      <tr><td>Superficial</td><td>não</td><td>não</td><td>${niv('dm', 'Deve melhorar')}</td></tr>
      <tr><td>Ausente ou incoerente</td><td>—</td><td>—</td><td>${niv('i', 'Insuficiente')}</td></tr>
    </tbody></table></div>
  <p class="pf-tut-nota">Outras combinações (consistente sem os dois, ou superficial com um deles) não estão previstas na matriz. Nesses casos o sistema avisa e o professor escolhe o nível, com justificativa.</p>
  <h3>Critério 3: proporção dos objetivos atingidos</h3>
  <div class="pf-tab-wrap"><table class="pf-tab pf-tut-tab">
    <thead><tr><th>Objetivos da turma</th><th>${niv('o', 'Ótimo')}</th><th>${niv('b', 'Bom')}</th><th>${niv('dm', 'Deve melhorar')}</th><th>${niv('i', 'Insuficiente')}</th></tr></thead>
    <tbody>
      <tr><td>10 objetivos (2º e 5º período)</td><td>9 ou 10</td><td>6, 7 ou 8</td><td>1 a 5</td><td>nenhum</td></tr>
      <tr><td>8 objetivos (4º período)</td><td>8</td><td>5, 6 ou 7</td><td>1 a 4</td><td>nenhum</td></tr>
    </tbody></table></div>
  <p class="pf-tut-nota">A faixa entre 50% e 75% não está na matriz. Pela regra da coordenação, ela vale Bom "por aproximação", e essa observação fica registrada na correção.</p>
  <p><b>Condições especiais</b>, só se o professor marcar: entrega em atraso de até 48h (50% da nota), plágio com nova versão em 24h (50%) ou plágio com nota zerada.</p>
</section>`;

const DUVIDAS = `
<section class="pf-tut-bloco" id="tut-duvidas">
  <span class="pf-tut-quem">Dúvidas comuns</span>
  <h2>Perguntas frequentes</h2>
  <details><summary>Recarreguei a página e o PDF sumiu. Perdi a correção?</summary>
    <p>Não. As correções ficam salvas no Órbita. O PDF só aparece enquanto a página está aberta, porque ele não é enviado ao servidor. Para vê-lo de novo, clique em <b>Carregar ZIP para ver o PDF</b> e escolha o mesmo arquivo. Sem o ZIP, a aba "Texto extraído" continua mostrando o conteúdo, com a marcação das páginas.</p></details>
  <details><summary>Um aluno entregou depois que eu importei. Como incluo?</summary>
    <p>Baixe o ZIP de novo no AVA e importe outra vez. Quem já estava na lista continua com a correção, e quem é novo entra como pendente.</p></details>
  <details><summary>O aluno trocou o arquivo depois da minha correção.</summary>
    <p>Na próxima importação, a entrega aparece com o aviso "reenviado após a correção". A correção não é apagada: confira se ela ainda vale e finalize de novo.</p></details>
  <details><summary>Dois professores podem corrigir a mesma turma?</summary>
    <p>Sim. Os dois veem todas as entregas da turma, e cada correção registra quem corrigiu e quando. Combinem entre vocês quem corrige quais alunos.</p></details>
  <details><summary>A similaridade apontou dois alunos. O sistema já tirou nota?</summary>
    <p>Não. Ela só mostra os trechos iguais e a gravidade. Se você entender que foi plágio, marque na correção uma das opções previstas: nota zerada ou nova versão em 24h valendo 50%.</p></details>
  <details><summary>Não vejo a minha turma.</summary>
    <p>A coordenação precisa marcar você como professor corretor da turma, em Configurar turma.</p></details>
  <details><summary>O portfólio é guardado em algum serviço externo?</summary>
    <p>Não. O texto fica apenas no banco institucional do Órbita, e só os professores da turma e a coordenação têm acesso.</p></details>
</section>`;

export function tutorialHtml(editor) {
  const indice = [
    editor ? ['tut-coordenacao', 'Coordenação', 'Turmas e corretores'] : null,
    ['tut-professor', 'Professor', 'Importar, corrigir, devolver'],
    ['tut-matriz', 'A matriz', 'Como a nota é calculada'],
    ['tut-duvidas', 'Dúvidas', 'PDF sumiu, reenvio, plágio']
  ].filter(Boolean);
  return `<div class="pf-tut">
    <p class="pf-tut-intro">Os alunos continuam entregando na Tarefa do AVA. O professor traz as entregas para cá, corrige com a mesma matriz que todos os outros professores usam e devolve as notas ao AVA.</p>
    <nav class="pf-tut-idx" aria-label="Partes do guia">${indice.map(([id, t, s]) => `<button type="button" data-tut="${id}"><b>${t}</b><span>${s}</span></button>`).join('')}</nav>
    ${editor ? COORDENACAO : ''}${PROFESSOR}${MATRIZ}${DUVIDAS}
  </div>`;
}
