// Temas dos comentários da CPA para o Relatório da Direção.
//
// 1) Lista fixa de temas institucionais: cada tema é um conjunto de termos
//    (sem acento, minúsculo). Um comentário conta UMA menção para cada tema
//    que ele cita; a classificação do comentário (elogio/neutro/atenção, de
//    src/utils/cpa-comentarios.js) diz se a menção é elogio ou crítica.
// 2) Temas emergentes: palavras que se repetem em vários comentários e não
//    pertencem a nenhum tema fixo nem à lista de palavras genéricas — é o que
//    sinaliza assunto novo (ex.: "crachá", "van"). Só entra com frequência
//    mínima, para não virar lista de palavras soltas.

export const TEMAS = [
  { id: 'infra', nome: 'Infraestrutura e salas', termos: ['infraestrutura', 'estrutura fisica', 'sala de aula', 'salas', 'carteira', 'cadeira', 'mesa', 'ar condicionado', 'ventilador', 'banheiro', 'laboratorio', 'predio', 'bloco', 'rampa', 'acessibilidade', 'elevador', 'tomada', 'projetor', 'data show', 'datashow', 'televis', 'quadro', 'iluminacao', 'calor', 'barulho', 'espaco fisico', 'manutencao', 'bebedouro', 'puff', 'sofa'] },
  { id: 'tec', nome: 'Tecnologia, internet e sistemas', termos: ['internet', 'wifi', 'wi-fi', 'rede', 'computador', 'informatica', 'sistema', 'ava', 'plataforma', 'edubox', 'aplicativo', 'site', 'zoom'] },
  { id: 'ead', nome: 'Ensino EAD / online', termos: ['ead', 'online', 'on-line', 'remoto', 'sincron', 'assincron', 'aula gravada', 'aulas gravadas', 'a distancia', 'mediada'] },
  { id: 'didatica', nome: 'Didática e aulas', termos: ['didatic', 'explica', 'explicacao', 'metodolog', 'conteudo', 'dinamic', 'aula pratica', 'aulas praticas', 'teoria', 'ensino', 'aprendizado', 'aprendizagem', 'materia', 'duvida', 'duvidas'] },
  { id: 'avaliacoes', nome: 'Provas e atividades avaliativas', termos: ['prova', 'provas', 'nota', 'notas', 'trabalho', 'trabalhos', 'atividade', 'atividades', 'exame', 'revisao', 'peso', 'prazo', 'prazos', 'uas'] },
  { id: 'comunicacao', nome: 'Comunicação e informação', termos: ['comunica', 'divulga', 'aviso', 'avisos', 'informa', 'whatsapp', 'grupo de', 'e-mail', 'email', 'redes sociais', 'instagram', 'transparencia'] },
  { id: 'atendimento', nome: 'Atendimento, secretaria e coordenação', termos: ['secretaria', 'secretari', 'atendimento', 'atendente', 'coordenac', 'coordenador', 'coordenadora', 'financeiro', 'direcao', 'diretor', 'documento', 'requerimento', 'recepcao', 'protocolo'] },
  { id: 'alimentacao', nome: 'Alimentação e cantina', termos: ['cantina', 'lanchonete', 'praca de alimentacao', 'alimentacao', 'comida', 'micro-ondas', 'microondas', 'micro ondas', 'refeitorio', 'lanche', 'cafe'] },
  { id: 'biblioteca', nome: 'Biblioteca e acervo', termos: ['biblioteca', 'livro', 'livros', 'acervo', 'bibliotecari'] },
  { id: 'transporte', nome: 'Estacionamento e transporte', termos: ['estacionamento', 'estacionar', 'onibus', 'transporte', 'van', 'deslocamento', 'vaga', 'vagas'] },
  { id: 'seguranca', nome: 'Segurança e acesso', termos: ['seguranca', 'portaria', 'porteiro', 'vigia', 'vigilan', 'controle de entrada', 'catraca', 'cracha', 'porta lateral', 'portao'] },
  { id: 'limpeza', nome: 'Limpeza e conservação', termos: ['limpeza', 'limpo', 'limpa', 'sujo', 'suja', 'sujeira', 'lixo', 'higiene'] },
  { id: 'carreira', nome: 'Valorização, carreira e capacitação', termos: ['salario', 'plano de carreira', 'carreira', 'valoriza', 'hora aula', 'hora-aula', 'h/a', 'beneficio', 'reconhecimento', 'capacitac', 'formacao continuada', 'treinamento', 'qualificac', 'sobrecarga'] },
  { id: 'estagio', nome: 'Estágio e prática profissional', termos: ['estagio', 'estagios', 'clinica escola', 'clinica-escola', 'hospital', 'campo de pratica', 'supervisor', 'supervisao'] },
  { id: 'extensao', nome: 'Eventos, pesquisa e extensão', termos: ['evento', 'eventos', 'extensao', 'palestra', 'semana academica', 'projeto integrador', 'pesquisa', 'horas complementares', 'congresso', 'iniciacao cientifica'] },
  { id: 'ambiente', nome: 'Ambiente e relacionamento', termos: ['ambiente', 'acolh', 'respeito', 'convivencia', 'colegas', 'equipe', 'relacionamento', 'educad', 'simpatic', 'atencios', 'humano', 'humana'] },
];

// Palavras que aparecem em comentário de qualquer assunto: nunca viram tema emergente.
const GENERICAS = new Set(('a o e de da do das dos em no na nos nas um uma uns umas para pra por com sem que se ao aos as os mas mais muito muita muitos muitas ' +
  'ja nao sim tem ter ser esta estao foi sao era seja sendo estar fica ficar faz fazer feito pode podem poderia poderiam deveria deveriam precisa precisam ' +
  'eu ele ela eles elas nos voce voces meu minha seu sua isso isto esse essa este aquele aquela tudo todo toda todos todas nada algo alguns algumas cada ' +
  'quando onde como porque pois porem entao tambem ainda sempre nunca apenas so bem bom boa otimo otima excelente melhor pior ruim regular ' +
  'gosto gostei gostaria acho acredito sinto vejo creio penso considero ' +
  'comentario comentarios sugestao sugestoes critica criticas elogio elogios observacao opiniao avaliacao avaliar avaliacoes resposta respostas pergunta perguntas ' +
  'professor professora professores professoras aluno alunos aluna alunas docente docentes instituicao faculdade fatec curso cursos turma turmas semestre ' +
  'periodo periodos aula aulas forma parte questao ponto pontos coisa coisas pessoa pessoas vez vezes dia dias hora horas tempo ano anos geral modo maneira ' +
  'sobre ate desde entre tanto quanto assim aqui agora hoje depois antes durante muito pouco pouca demais bastante alguma algum nenhum nenhuma ' +
  'importante necessario possivel melhorar melhoria melhorias continuar parabens obrigado obrigada satisfeito satisfeita adequado adequada ' +
  'atende atendem atendeu realmente totalmente sempre super dentro fora outro outra outros outras mesmo mesma proprio propria nosso nossa ' +
  'cpa dimensao conheco desconheco consigo poder posso pouco relacao respeito questoes conforme qualquer quais qual quem dessa desse deste desta nessa nesse neste nesta pela pelo pelas pelos ' +
  'sao estou estamos estava fizeram fazem tenho temos tinha teria haver havia houve existe existem ok tranquilo legal show top').split(/\s+/));

// verbos/adjetivos genéricos que apareceram como "tema" nos dados reais
['falta', 'faltam', 'faltou', 'sala', 'pratica', 'praticas', 'problema', 'problemas', 'dificuldade', 'dificuldades', 'seria', 'disciplina', 'disciplinas',
  'principalmente', 'participacao', 'projeto', 'projetos', 'desenvolvimento', 'acoes', 'alem', 'plano', 'processo', 'academica', 'academico', 'necessidade',
  'estudante', 'estudantes', 'precisamos', 'colaboradores', 'maior', 'oportunidade', 'oportunidades', 'setores', 'demonstram', 'interesse', 'mais', 'menos',
  'facil', 'dificil', 'claro', 'clara', 'grande', 'grandes', 'pequeno', 'pequena', 'novo', 'nova', 'sempre', 'pode', 'precisa', 'gente', 'momento', 'caso',
  'exemplo', 'situacao', 'fato', 'falar', 'dizer', 'deixa', 'deixar', 'acaba', 'acabam', 'conseguimos', 'conseguem', 'consegue', 'entender', 'aprender',
  'positiva', 'positivo', 'negativa', 'negativo', 'considerando', 'seu', 'sua', 'seus', 'suas', 'compromisso', 'qualidade', 'forma', 'nivel', 'tipo', 'muitas', 'vezes', 'demonstra', 'conhecimento', 'conhecimentos'].forEach(p => GENERICAS.add(p));
const LIGACAO = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'as', 'os', 'em', 'no', 'na', 'nos', 'nas', 'para', 'pra', 'com', 'por', 'um', 'uma', 'que', 'se', 'ao', 'mais']);

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// termo curto (ava, van, uas, rede...) só casa como palavra inteira; o resto por prefixo
// (as expressões são montadas uma vez só: são milhares de comentários)
const cacheRe = new Map();
const casa = (t, termo) => {
  let re = cacheRe.get(termo);
  if (!re) {
    re = termo.length <= 4 || !/^[a-z]+$/.test(termo)
      ? new RegExp(`(^|[^a-z])${termo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^a-z])`)
      : new RegExp(`(^|[^a-z])${termo}`);
    cacheRe.set(termo, re);
  }
  return re.test(t);
};

export function temasDoComentario(texto) {
  const t = norm(texto);
  return TEMAS.filter(tema => tema.termos.some(termo => casa(t, termo))).map(tema => tema.id);
}

// comentarios: [{ texto, classificacao, dimensao? }]
export function analisarTemas(comentarios) {
  const porTema = new Map(TEMAS.map(t => [t.id, { ...t, mencoes: 0, elogios: 0, criticas: 0, neutros: 0, dimensoes: new Map(), exemplos: [] }]));
  for (const c of comentarios) {
    for (const id of temasDoComentario(c.texto)) {
      const e = porTema.get(id);
      e.mencoes += 1;
      if (c.classificacao === 'bom') e.elogios += 1; else if (c.classificacao === 'atencao') e.criticas += 1; else e.neutros += 1;
      if (c.dimensao) e.dimensoes.set(c.dimensao, (e.dimensoes.get(c.dimensao) || 0) + 1);
      if (c.classificacao === 'atencao') e.exemplos.push(c.texto);
    }
  }
  return [...porTema.values()].filter(e => e.mencoes > 0).sort((a, b) => b.mencoes - a.mencoes)
    .map(e => ({ ...e, dimensaoPrincipal: [...e.dimensoes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '' }));
}

// Expressões de duas palavras que se repetem em vários comentários e não
// são de nenhum tema fixo ("porta lateral", "plano carreira", "aula sabado").
// Palavra solta não serve: sai "falta", "sala", "seria" — o que não diz nada.
// `minimo` = em quantos comentários diferentes a expressão precisa aparecer
// (padrão: 3, ou 0,15% dos comentários em campanhas grandes). Só entra
// expressão que aparece mais em crítica do que em elogio/neutro (sinal de demanda).
export function temasEmergentes(comentarios, { minimo, limite = 8 } = {}) {
  const min = minimo || Math.max(3, Math.ceil(comentarios.length * 0.0015));
  const termosFixos = TEMAS.flatMap(t => t.termos);
  const deTemaFixo = (expr) => termosFixos.some(termo => casa(expr, termo));
  const cont = new Map();
  for (const c of comentarios) {
    const palavras = norm(c.texto).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    // palavras "de conteúdo" na ordem em que aparecem (pula artigos/preposições entre elas)
    const uteis = palavras.filter(p => p.length >= 3 && !GENERICAS.has(p) && !LIGACAO.has(p));
    const vistas = new Set();
    for (let i = 0; i < uteis.length - 1; i++) {
      const a = uteis[i].replace(/s$/, ''), b = uteis[i + 1].replace(/s$/, '');
      if (a === b) continue;
      const expr = `${a} ${b}`;
      if (vistas.has(expr) || deTemaFixo(expr)) continue;
      vistas.add(expr);
      if (!cont.has(expr)) cont.set(expr, { termo: expr, comentarios: 0, criticas: 0, dimensoes: new Map(), exemplo: '' });
      const e = cont.get(expr);
      e.comentarios += 1;
      if (c.classificacao === 'atencao') { e.criticas += 1; if (!e.exemplo || (c.texto.length < e.exemplo.length && c.texto.length > 40)) e.exemplo = c.texto; }
      if (c.dimensao) e.dimensoes.set(c.dimensao, (e.dimensoes.get(c.dimensao) || 0) + 1);
    }
  }
  return [...cont.values()]
    .filter(e => e.comentarios >= min && e.criticas * 2 > e.comentarios)
    .sort((a, b) => b.criticas - a.criticas || b.comentarios - a.comentarios)
    .slice(0, limite)
    .map(e => ({ ...e, dimensaoPrincipal: [...e.dimensoes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '' }));
}
