// ================================================================
//  Gerador de Moodle XML (banco de questões) — BANCO MED-FATEC
//  Formato validado contra uma exportação real do Open LMS da FATEC
//  (multichoice / multichoiceset / truefalse, imagem via @@PLUGINFILE@@
//  + <file base64>, feedback padrão, tags de dificuldade/autor/tipo).
// ================================================================

function xmlEscape(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// CDATA é o padrão usado pelo Moodle para os campos de texto HTML
// (questiontext, feedback, respostas). `]]>` dentro do conteúdo precisa
// ser quebrado, senão fecha o CDATA antes da hora.
function cdata(str) {
    const safe = String(str ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
    return `<![CDATA[${safe}]]>`;
}

function nomeArquivoImagem(imagem) {
    if (!imagem || !imagem.dataUrl) return null;
    const match = /^data:image\/(\w+);base64,/.exec(imagem.dataUrl);
    const ext = match ? match[1].replace('jpeg', 'jpg') : 'jpg';
    return `${(imagem.nome || 'imagem').replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`;
}

function base64DaImagem(imagem) {
    if (!imagem || !imagem.dataUrl) return null;
    const idx = imagem.dataUrl.indexOf(',');
    return idx >= 0 ? imagem.dataUrl.slice(idx + 1) : null;
}

const DIFICULDADE_LABEL = {
    facil: 'Fácil',
    media: 'Média',
    intermediaria: 'Intermediária',
    dificil: 'Difícil'
};

function blocoQuestionText(questao) {
    const nomeArquivo = nomeArquivoImagem(questao.imagem);
    const b64 = base64DaImagem(questao.imagem);
    const imgTag = nomeArquivo
        ? `\n<p><img src="@@PLUGINFILE@@/${xmlEscape(nomeArquivo)}" alt="${xmlEscape(questao.titulo || '')}"></p>`
        : '';
    const fileTag = (nomeArquivo && b64)
        ? `\n<file name="${xmlEscape(nomeArquivo)}" path="/" encoding="base64">${b64}</file>`
        : '';
    return `  <questiontext format="html">
    <text>${cdata((questao.enunciadoHtml || '') + imgTag)}</text>${fileTag}
  </questiontext>`;
}

function blocoGeneralFeedback(questao) {
    const partes = [];
    if (questao.justificativa) partes.push(questao.justificativa);
    if (questao.fonte) partes.push(`<p><em>FONTE: ${xmlEscape(questao.fonte)}</em></p>`);
    return `  <generalfeedback format="html">
    <text>${cdata(partes.join('\n'))}</text>
  </generalfeedback>`;
}

function blocoTags(questao) {
    const tags = [];
    if (questao.dificuldade) tags.push(`dificuldade:${DIFICULDADE_LABEL[questao.dificuldade] || questao.dificuldade}`);
    if (questao.elaboradoPor) tags.push(`autor:${questao.elaboradoPor}`);
    if (!tags.length) return '';
    return `  <tags>
${tags.map(t => `    <tag><text>${xmlEscape(t)}</text></tag>`).join('\n')}
  </tags>\n`;
}

function blocoAnswer(texto, fraction) {
    return `  <answer fraction="${fraction}" format="html">
    <text>${cdata(texto)}</text>
    <feedback format="html">
      <text></text>
    </feedback>
  </answer>`;
}

function questaoMultichoiceUnica(questao) {
    const corretaIdx = questao.alternativas.findIndex(a => a.correta);
    const answers = questao.alternativas
        .map((a, i) => blocoAnswer(a.texto, i === corretaIdx ? 100 : 0))
        .join('\n');
    return `<question type="multichoice">
  <name>
    <text>${xmlEscape(questao.titulo)}</text>
  </name>
${blocoQuestionText(questao)}
${blocoGeneralFeedback(questao)}
  <defaultgrade>1.0000000</defaultgrade>
  <penalty>0.3333333</penalty>
  <hidden>0</hidden>
  <idnumber></idnumber>
  <single>true</single>
  <shuffleanswers>true</shuffleanswers>
  <answernumbering>abc</answernumbering>
  <showstandardinstruction>0</showstandardinstruction>
  <correctfeedback format="html">
    <text>${cdata('<p>Sua resposta está correta.</p>')}</text>
  </correctfeedback>
  <partiallycorrectfeedback format="html">
    <text>${cdata('<p>Sua resposta está parcialmente correta.</p>')}</text>
  </partiallycorrectfeedback>
  <incorrectfeedback format="html">
    <text>${cdata('<p>Sua resposta está incorreta.</p>')}</text>
  </incorrectfeedback>
  <shownumcorrect/>
${answers}
${blocoTags(questao)}</question>`;
}

function questaoMultichoiceMultipla(questao) {
    const corretas = questao.alternativas.filter(a => a.correta).length || 1;
    const fracaoCorreta = (100 / corretas).toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
    const answers = questao.alternativas
        .map(a => blocoAnswer(a.texto, a.correta ? fracaoCorreta : 0))
        .join('\n');
    return `<question type="multichoiceset">
  <name>
    <text>${xmlEscape(questao.titulo)}</text>
  </name>
${blocoQuestionText(questao)}
${blocoGeneralFeedback(questao)}
  <defaultgrade>1.0000000</defaultgrade>
  <penalty>0.3333333</penalty>
  <hidden>0</hidden>
  <idnumber></idnumber>
  <shuffleanswers>true</shuffleanswers>
  <correctfeedback format="html">
    <text>${cdata('<p>Sua resposta está correta.</p>')}</text>
  </correctfeedback>
  <incorrectfeedback format="html">
    <text>${cdata('<p>Sua resposta está incorreta.</p>')}</text>
  </incorrectfeedback>
  <answernumbering>abc</answernumbering>
  <showstandardinstruction>0</showstandardinstruction>
${answers}
${blocoTags(questao)}</question>`;
}

function questaoVerdadeiroFalso(questao) {
    const respostaCerta = questao.alternativas.find(a => a.correta);
    const valorCerto = (respostaCerta?.texto || '').trim().toLowerCase() === 'verdadeiro' || (respostaCerta?.texto || '').trim().toLowerCase() === 'true';
    return `<question type="truefalse">
  <name>
    <text>${xmlEscape(questao.titulo)}</text>
  </name>
${blocoQuestionText(questao)}
${blocoGeneralFeedback(questao)}
  <defaultgrade>1.0000000</defaultgrade>
  <penalty>1.0000000</penalty>
  <hidden>0</hidden>
  <idnumber></idnumber>
  <answer fraction="${valorCerto ? 100 : 0}" format="moodle_auto_format">
    <text>true</text>
    <feedback format="html"><text></text></feedback>
  </answer>
  <answer fraction="${valorCerto ? 0 : 100}" format="moodle_auto_format">
    <text>false</text>
    <feedback format="html"><text></text></feedback>
  </answer>
${blocoTags(questao)}</question>`;
}

function questaoParaXml(questao) {
    if (questao.tipoMoodle === 'multichoice_multipla') return questaoMultichoiceMultipla(questao);
    if (questao.tipoMoodle === 'verdadeiro_falso') return questaoVerdadeiroFalso(questao);
    return questaoMultichoiceUnica(questao);
}

// `questoes` já vem na ordem da prova. `nomeCategoria` vira o bloco de
// categoria no topo do XML (mesmo formato usado pelo Open LMS da FATEC).
function gerarMoodleXml(nomeCategoria, questoes) {
    const categoriaBloco = `<question type="category">
  <category>
    <text>$module$/top/${xmlEscape(nomeCategoria)}</text>
  </category>
  <info format="moodle_auto_format">
    <text>${cdata(`Categoria gerada pelo Órbita — BANCO MED-FATEC ('${nomeCategoria}').`)}</text>
  </info>
  <idnumber></idnumber>
</question>`;

    const corpo = [categoriaBloco, ...questoes.map(questaoParaXml)].join('\n\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<quiz>\n${corpo}\n</quiz>\n`;
}

module.exports = { gerarMoodleXml };
