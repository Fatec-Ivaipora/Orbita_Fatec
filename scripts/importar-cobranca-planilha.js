/**
 * importar-cobranca-planilha.js — carga ÚNICA da planilha "COBRANÇA
 * GRADUAÇÃO.xlsx" (fonte: financeiro) para o Firestore, substituindo de vez
 * a antiga integração ao vivo com o Postgres do Edubox no módulo Cobrança.
 * A partir desta carga, o financeiro cadastra/edita os casos manualmente
 * pela própria tela — este script não roda de novo em rotina, só se for
 * preciso reimportar do zero. É seguro rodar de novo com --confirmar: ele
 * apaga a carga anterior (parcelas + ações com origem=planilha) antes de
 * regravar — NUNCA apaga casos/ações cadastrados manualmente pela tela.
 *
 * Lê a aba "Todos graduação " (mestra — as abas "Advogado", "Trancados,
 * cancelado..." e "Ativos" são só recortes filtrados da mesma mestra,
 * conferido linha a linha, não trazem coluna extra nenhuma) e a aba
 * "Comparativo Valores em Aberto " (histórico mensal jan-ago/2026, usado só
 * pro gráfico de tendência do relatório — não dá pra recalcular isso depois
 * a partir das parcelas, porque cada mês reflete a situação de cada aluno
 * NAQUELE mês, que muda com o tempo).
 *
 * A planilha tem 3 linhas de rodapé (subtotal/cabeçalho repetido/"Qtd.")
 * misturadas nos dados — filtradas por Sta.Mat fora do conjunto válido.
 * Conferido: 1119 linhas válidas, soma "A Pagar" e "V, Pago" batem exato com
 * o rodapé "Qtd. 1119 / 737586.48 / 7799.03" da própria planilha.
 *
 * USO:
 *   node scripts/importar-cobranca-planilha.js "caminho/planilha.xlsx"
 *   node scripts/importar-cobranca-planilha.js "caminho/planilha.xlsx" --confirmar
 *
 * Sem --confirmar só mostra o resumo do que seria gravado (nada é gravado).
 */
const path = require('path');
const xlsx = require('xlsx');
const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const COL_PARCELAS = 'financeiro_cobranca_parcelas';
const COL_ACOES = 'financeiro_cobranca_acoes';
const COL_HISTORICO = 'financeiro_cobranca_historico_mensal';

const SITUACOES_VALIDAS = new Set(['Trancamento', 'Desistência', 'Concluído', 'Ativo', 'Cancelado', 'Pendente']);
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function excelDateParaISO(serial) {
    const utcDays = Math.floor(serial - 25569);
    const d = new Date(utcDays * 86400 * 1000);
    return d.toISOString().slice(0, 10);
}

// Janeiro-Junho = ".1", Julho-Dezembro = ".2" do mesmo ano — vale pra
// qualquer ano presente nos dados, não só 2026 (a pedido do usuário).
// Fica editável por aluno depois, porque negociação pode mudar o semestre
// que uma dívida antiga é "cobrada dentro".
function calcularSemestre(vencimentoISO) {
    const [ano, mes] = vencimentoISO.split('-');
    return `${ano}/${Number(mes) <= 6 ? 1 : 2}`;
}

function normalizarCpf(v) {
    const digitos = (v || '').toString().replace(/\D/g, '');
    return digitos.length === 11 ? digitos : null;
}

function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

// A coluna "Curso" da planilha vem truncada em ~30 caracteres (limite do
// sistema de origem) — pra maioria dos cursos isso só corta o fim do nome
// (sem ambiguidade, resolvido aqui direto). Conferido linha a linha em
// 2026-09-04.
const CURSOS_TRUNCADOS_SIMPLES = {
    'BACHARELADO EM PSICOLOGIA - FO': 'BACHARELADO EM PSICOLOGIA',
    'BACHARELADO EM CIÊNCIAS CONTÁB': 'BACHARELADO EM CIÊNCIAS CONTÁBEIS',
    'BACHARELADO EM ENGENHARIA CIVI': 'BACHARELADO EM ENGENHARIA CIVIL',
    'BACHARELADO EM ARQUITETURA E U': 'BACHARELADO EM ARQUITETURA E URBANISMO',
    'BACHARELADO EM MEDICINA VETERI': 'BACHARELADO EM MEDICINA VETERINÁRIA'
};

// "SUPERIOR DE TECNOLOGIA EM GEST" é o caso grave: esconde 4 tecnólogos
// DIFERENTES (confirmado analisando o campo Plano por aluno) — Gestão
// Financeira, Gestão Comercial, Gestão de Recursos Humanos ("RH" em alguns
// planos mais antigos) e Agronegócio. Resolvido por aluno (cpf) abaixo.
const CURSO_TECNOLOGO_AMBIGUO = 'SUPERIOR DE TECNOLOGIA EM GEST';
const CURSO_TECNOLOGO_NAO_IDENTIFICADO = 'SUPERIOR DE TECNOLOGIA EM GESTÃO (curso não identificado na planilha)';
const NOME_PLANO_PARA_CURSO_TECNOLOGO = {
    'RH': 'SUPERIOR DE TECNOLOGIA EM GESTÃO DE RECURSOS HUMANOS',
    'GESTÃO DE RECURSOS HUMANOS': 'SUPERIOR DE TECNOLOGIA EM GESTÃO DE RECURSOS HUMANOS',
    'GESTÃO FINANCEIRA': 'SUPERIOR DE TECNOLOGIA EM GESTÃO FINANCEIRA',
    'GESTÃO COMERCIAL': 'SUPERIOR DE TECNOLOGIA EM GESTÃO COMERCIAL',
    'AGRONEGÓCIO': 'SUPERIOR DE TECNOLOGIA EM AGRONEGÓCIO'
};
// O campo Plano geralmente é "<NOME DO CURSO> <ANO>.<SEMESTRE>[...]" (ex.:
// "GESTÃO FINANCEIRA 2026.1") — planos de negociação avulsa (ex. "ADVOGADO
// FATEC", "RENEGOCIAÇÃO GRADUAÇÃO") não batem nesse formato e são ignorados.
const REGEX_NOME_CURSO_NO_PLANO = /^(.*?)\s+\d{4}[./]\d/;

// Corrige o campo `curso` nas próprias parcelas (mutando o array). Os
// truncamentos simples são 1-pra-1, corrigidos direto. Já o tecnólogo
// ambíguo é resolvido por ALUNO: junta todas as parcelas do mesmo cpf e
// procura, em qualquer uma delas, um Plano que revele o curso real — nem
// toda parcela tem isso (uma parcela em "ADVOGADO FATEC" não revela nada),
// mas geralmente pelo menos uma parcela "normal" do aluno revela.
function corrigirCursos(parcelas) {
    for (const p of parcelas) {
        if (CURSOS_TRUNCADOS_SIMPLES[p.curso]) p.curso = CURSOS_TRUNCADOS_SIMPLES[p.curso];
    }

    const porCpf = new Map();
    for (const p of parcelas) {
        if (p.curso !== CURSO_TECNOLOGO_AMBIGUO || !p.cpf) continue;
        if (!porCpf.has(p.cpf)) porCpf.set(p.cpf, []);
        porCpf.get(p.cpf).push(p);
    }

    let resolvidos = 0, naoIdentificados = 0;
    for (const linhasDoAluno of porCpf.values()) {
        const nomesEncontrados = new Set();
        for (const p of linhasDoAluno) {
            const m = p.plano.match(REGEX_NOME_CURSO_NO_PLANO);
            const nomeCurso = m && NOME_PLANO_PARA_CURSO_TECNOLOGO[m[1].trim().toUpperCase()];
            if (nomeCurso) nomesEncontrados.add(nomeCurso);
        }
        const cursoFinal = nomesEncontrados.size === 1 ? [...nomesEncontrados][0] : CURSO_TECNOLOGO_NAO_IDENTIFICADO;
        if (nomesEncontrados.size === 1) resolvidos++; else naoIdentificados++;
        linhasDoAluno.forEach(p => { p.curso = cursoFinal; });
    }
    return { alunosTecnologoAmbiguo: porCpf.size, resolvidos, naoIdentificados };
}

function derivarModelo(curso) {
    const c = curso.toUpperCase();
    if (c.startsWith('BACHARELADO EM')) return 'Bacharelado';
    if (c.startsWith('LICENCIATURA EM')) return 'Licenciatura';
    if (c.startsWith('SUPERIOR DE TECNOLOGIA EM') || c.startsWith('TECNÓLOGO EM')) return 'Tecnólogo';
    return 'Outro';
}

function lerParcelas(wb) {
    const ws = wb.Sheets['Todos graduação '];
    if (!ws) throw new Error('Aba "Todos graduação " não encontrada na planilha.');
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });

    const validas = rows.slice(1).filter(r => {
        const [cliente, , staMat, , , , venc] = r;
        return String(cliente).trim() && typeof venc === 'number' && SITUACOES_VALIDAS.has(staMat);
    });

    const vistos = new Set();
    const parcelas = [];
    let duplicadasIgnoradas = 0;
    for (const r of validas) {
        const chave = r.join('|');
        if (vistos.has(chave)) { duplicadasIgnoradas++; continue; }
        vistos.add(chave);

        const [cliente, cpfBruto, staMat, celular, curso, plano, venc, valorBruto, descCad, desc, multa, juros, aPagar, vPago] = r;
        const vencimentoISO = excelDateParaISO(venc);
        const valorAPagar = round2(aPagar);
        const valorPago = round2(vPago);

        parcelas.push({
            nome: String(cliente).trim(),
            cpf: normalizarCpf(cpfBruto),
            celular: String(celular || '').trim(),
            curso: String(curso).trim(),
            situacao: staMat,
            plano: String(plano || '').trim(),
            vencimento: vencimentoISO,
            semestre: calcularSemestre(vencimentoISO),
            valorBruto: round2(valorBruto),
            descontoCadastro: round2(descCad),
            desconto: round2(desc),
            multa: round2(multa),
            juros: round2(juros),
            valorAPagar,
            valorPago,
            quitado: (valorAPagar - valorPago) <= 0.01,
            origem: 'planilha_2026-09-03',
            criadoEm: new Date().toISOString(),
            atualizadoEm: new Date().toISOString()
        });
    }
    return { parcelas, duplicadasIgnoradas, totalBruto: validas.length };
}

// "ADVOGADO FATEC" e "DÉBITO JUDICIAL" são planos que já sinalizam, na
// própria planilha do financeiro, que aquele aluno está em cobrança
// jurídica — não existe outra fonte disso (era a mesma lacuna do Edubox,
// que também não tinha controle jurídico nenhum). Uma ação por ALUNO (não
// por parcela — um aluno pode ter várias parcelas no mesmo plano).
function seedAcoesJuridicas(parcelas) {
    const porCpf = new Map(); // cpf -> tipo mais "forte" encontrado
    const prioridade = { acordo_judicial: 2, enviado_advocacia: 1 };
    for (const p of parcelas) {
        if (!p.cpf) continue;
        let tipo = null;
        if (p.plano === 'DÉBITO JUDICIAL') tipo = 'acordo_judicial';
        else if (p.plano === 'ADVOGADO FATEC') tipo = 'enviado_advocacia';
        if (!tipo) continue;
        const atual = porCpf.get(p.cpf);
        if (!atual || prioridade[tipo] > prioridade[atual.tipo]) {
            porCpf.set(p.cpf, { tipo, nomeAluno: p.nome });
        }
    }
    return [...porCpf.entries()].map(([cpf, { tipo, nomeAluno }]) => ({
        cpf, nomeAluno, tipo,
        escritorio: '',
        observacoes: 'Importado automaticamente da planilha COBRANÇA GRADUAÇÃO (plano indicava cobrança jurídica).',
        origem: 'planilha',
        criadoPor: 'import-script',
        criadoPorNome: 'Importação da planilha',
        criadoEm: admin.firestore.FieldValue.serverTimestamp()
    }));
}

function lerHistoricoMensal(wb) {
    const ws = wb.Sheets['Comparativo Valores em Aberto '];
    if (!ws) return [];
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const registros = [];
    for (const r of rows) {
        const [mes, ativos, juridico, inativos, obs] = r;
        if (!MESES.includes(String(mes).trim())) continue;
        registros.push({
            mes: String(mes).trim(),
            ano: 2026,
            valorAbertoAtivos: round2(ativos),
            valorAbertoJuridico: round2(juridico),
            valorAbertoInativos: round2(inativos),
            observacao: String(obs || '').trim(),
            origem: 'planilha_2026-09-03'
        });
    }
    return registros;
}

async function gravarEmLotes(colecao, docs, idFn) {
    const chunks = [];
    for (let i = 0; i < docs.length; i += 400) chunks.push(docs.slice(i, i + 400));
    let gravados = 0;
    for (const chunk of chunks) {
        const batch = db.batch();
        chunk.forEach(doc => {
            const ref = idFn ? db.collection(colecao).doc(idFn(doc)) : db.collection(colecao).doc();
            batch.set(ref, doc);
        });
        await batch.commit();
        gravados += chunk.length;
    }
    return gravados;
}

// Apaga os docs de uma consulta em lotes de 400 (limite do batch do
// Firestore). Usado pra limpar a carga anterior antes de reimportar — só
// roda depois de conferir que não há casos cadastrados manualmente (ver
// checagem no README do script / regra_do_app.md).
async function apagarResultado(query) {
    const snap = await query.get();
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
        const batch = db.batch();
        docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
    }
    return docs.length;
}

async function main() {
    const arquivo = process.argv[2];
    const confirmar = process.argv.includes('--confirmar');
    if (!arquivo) throw new Error('Uso: node scripts/importar-cobranca-planilha.js "caminho/planilha.xlsx" [--confirmar]');

    const wb = xlsx.readFile(path.resolve(arquivo));
    const { parcelas, duplicadasIgnoradas, totalBruto } = lerParcelas(wb);
    const { alunosTecnologoAmbiguo, resolvidos, naoIdentificados } = corrigirCursos(parcelas);
    parcelas.forEach(p => { p.modelo = derivarModelo(p.curso); });
    const acoesJuridicas = seedAcoesJuridicas(parcelas);
    const historico = lerHistoricoMensal(wb);

    const totalAPagar = parcelas.reduce((s, p) => s + p.valorAPagar, 0);
    const totalPago = parcelas.reduce((s, p) => s + p.valorPago, 0);
    const emAberto = parcelas.filter(p => !p.quitado);
    const alunosUnicos = new Set(parcelas.map(p => p.cpf).filter(Boolean));

    console.log('── RESUMO DA IMPORTAÇÃO ──────────────────────');
    console.log('Linhas válidas na planilha :', totalBruto);
    console.log('Duplicadas exatas ignoradas:', duplicadasIgnoradas);
    console.log('Parcelas a gravar          :', parcelas.length);
    console.log('  → em aberto              :', emAberto.length);
    console.log('  → já quitadas (histórico):', parcelas.length - emAberto.length);
    console.log('Alunos únicos (por CPF)    :', alunosUnicos.size);
    console.log('Soma "A Pagar"             : R$', totalAPagar.toFixed(2));
    console.log('Soma "V, Pago"             : R$', totalPago.toFixed(2));
    console.log('Ações jurídicas seedadas   :', acoesJuridicas.length,
        `(${acoesJuridicas.filter(a => a.tipo === 'acordo_judicial').length} acordo judicial, ${acoesJuridicas.filter(a => a.tipo === 'enviado_advocacia').length} enviado à advocacia)`);
    console.log('Registros de histórico mensal:', historico.length);
    console.log(`Tecnólogo "GEST..." desambiguado: ${alunosTecnologoAmbiguo} aluno(s) — ${resolvidos} identificado(s) pelo Plano, ${naoIdentificados} sem plano que revele o curso (ficam como "não identificado")`);

    if (!confirmar) {
        console.log('\n⚠️  PRÉVIA — nada foi gravado. Rode de novo com --confirmar para gravar no Firestore.');
        return;
    }

    console.log('\nLimpando carga anterior (parcelas + ações seedadas da planilha)...');
    const apagadasParcelas = await apagarResultado(db.collection(COL_PARCELAS));
    console.log('🗑️ ', apagadasParcelas, 'parcelas antigas removidas');
    const apagadasAcoes = await apagarResultado(db.collection(COL_ACOES).where('origem', '==', 'planilha'));
    console.log('🗑️ ', apagadasAcoes, 'ações antigas (origem=planilha) removidas — ações manuais não são tocadas');

    console.log('\nGravando parcelas...');
    const gravadasParcelas = await gravarEmLotes(COL_PARCELAS, parcelas);
    console.log('✅', gravadasParcelas, 'parcelas gravadas em', COL_PARCELAS);

    console.log('Gravando ações jurídicas (seed)...');
    const gravadasAcoes = await gravarEmLotes(COL_ACOES, acoesJuridicas);
    console.log('✅', gravadasAcoes, 'ações gravadas em', COL_ACOES);

    console.log('Gravando histórico mensal...');
    const gravadoHistorico = await gravarEmLotes(COL_HISTORICO, historico, (h) => `${h.ano}-${String(MESES.indexOf(h.mes) + 1).padStart(2, '0')}`);
    console.log('✅', gravadoHistorico, 'registros gravados em', COL_HISTORICO);
}

main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
