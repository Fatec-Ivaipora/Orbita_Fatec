const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
require('dotenv').config();

const app = express();

// Compressão gzip/brotli das respostas — reduz bastante o peso transferido
// em conexões móveis lentas (JSON da API e os estáticos servidos localmente).
app.use(compression());

// Middlewares globais
// Origens permitidas: apenas o painel web oficial e ambiente de desenvolvimento local.
const ALLOWED_ORIGINS = [
    'https://orbita-fatecivp.web.app',       // Firebase Hosting (produção)
    'https://orbita-fatecivp.firebaseapp.com', // Firebase Hosting (alternativo)
    'https://orbita-fatec-ti.vercel.app',     // Vercel (produção, antigo)
    'https://orbita.fatecivaipora.com.br',    // Coolify (produção, domínio próprio — 26/11/2026)
    'http://localhost:3000',                  // Desenvolvimento local (backend)
    'http://127.0.0.1:3000',                  // Desenvolvimento local (backend)
];

const corsOptions = {
    origin: (origin, callback) => {
        // Permite requisições sem origin (Postman, APK nativo, curl, etc.)
        // E permite qualquer porta no localhost/127.0.0.1 para desenvolvimento local
        const isLocalhost = origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        const isVercelSubdomain = origin && /^https:\/\/.*\.vercel\.app$/.test(origin);
        // Migração pro Coolify (26/11/2026): enquanto não tem domínio
        // próprio, cada app sobe num link tipo <uuid>.<ip-do-servidor>.sslip.io
        // — libera só os domínios desse servidor específico da migração, não
        // qualquer sslip.io (que é um serviço público, sem dono verificado).
        const isCoolifyMigracao = origin && /^https:\/\/[a-z0-9]+\.177\.104\.189\.118\.sslip\.io$/.test(origin);
        if (!origin || ALLOWED_ORIGINS.includes(origin) || isLocalhost || isVercelSubdomain || isCoolifyMigracao) {
            callback(null, true);
        } else {
            callback(new Error(`CORS: Origem não autorizada — ${origin}`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    optionsSuccessStatus: 200
};
// Calendário Acadêmico público (site novo e qualquer site): aberto a qualquer origem, só leitura do que foi publicado
app.get('/api/publico/calendario-academico', cors(), (req, res) => require('../src/rotas/calendario-academico').publico(req, res));
app.use(cors(corsOptions));

// Responder a preflights OPTIONS explicitamente
app.options(/.*/, cors(corsOptions));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// NOME SOCIAL EM TODO O ÓRBITA (26/11/2026, pedido do T.I: "tudo que sai informação dos alunos"). Toda resposta da
// API passa por aqui: o nome de registro de quem tem nome social (config/nomes_sociais) vira o nome social — em
// qualquer módulo, campo ou texto, inclusive dados antigos já gravados (ex.: avaliação criada antes do cadastro)
// e nomes que vêm do AVA. Arquivo montado no servidor (Excel, PDF) troca na própria rota (nomeSocial.trocarNoTexto).
const nomeSocialGeral = require('../src/utils/nome-social');
app.use('/api', async (req, res, next) => {
    try { await nomeSocialGeral.carregarNomesSociais(); } catch (e) { /* sem a lista, segue sem trocar */ }
    const json = res.json.bind(res);
    res.json = (corpo) => json(nomeSocialGeral.trocarNoObjeto(corpo));
    const send = res.send.bind(res);
    res.send = (corpo) => send(typeof corpo === 'string' ? nomeSocialGeral.trocarNoTexto(corpo) : corpo);
    next();
});



// Rota de Teste para garantir que a API está no ar
app.get('/api', (req, res) => {
    res.json({ status: 'success', message: 'Órbita FATEC API está online!' });
});

// Importação das rotas
const rotasEmprestimo = require('../src/rotas/emprestimos');
const rotasUsuarios = require('../src/rotas/usuarios');
const rotasMeuEspaco = require('../src/rotas/meu-espaco');
const rotasEmpresas = require('../src/rotas/empresas');
const rotasValidacao = require('../src/rotas/validacao');
const rotasFerida = require('../src/rotas/ferida');
const rotasAlmoxarifadoFeridas = require('../src/rotas/almoxarifado-feridas');
const rotasAlmoxarifadoSaude = require('../src/rotas/almoxarifado-saude');
const rotasSecretariaDp = require('../src/rotas/secretaria-dp');
const rotasAcessos = require('../src/rotas/acessos');
const rotasFinanceiro = require('../src/rotas/financeiro');
const rotasMatriculas = require('../src/rotas/matriculas');
const rotasProcessos = require('../src/rotas/processos');
const rotasOrcamento = require('../src/rotas/orcamento');
const rotasAvaliacaoDocente = require('../src/rotas/avaliacao-docente');
const rotasCobrancaEdubox = require('../src/rotas/cobranca-edubox');
const rotasBancoMedFatec = require('../src/rotas/banco-med-fatec');
const rotasRelatorioDesempenho = require('../src/rotas/relatorio-desempenho');
const rotasAplicacaoProvasMed = require('../src/rotas/aplicacao-provas-med');
const rotasOsceMed = require('../src/rotas/osce-med');
const rotasPortfolioMed = require('../src/rotas/portfolio-med');
const rotasBancoProvas = require('../src/rotas/banco-provas');
const rotasFormularios = require('../src/rotas/formularios');
const rotasConfirmacaoEvento = require('../src/rotas/confirmacao-evento');
const rotasContratos = require('../src/rotas/contratos');
const rotasAulaExperimental = require('../src/rotas/aula-experimental');
const rotasAuloes = require('../src/rotas/auloes');
const rotasPalestras = require('../src/rotas/palestras');
const rotasCalendarioAcademico = require('../src/rotas/calendario-academico');
const rotasAgendaEspacos = require('../src/rotas/agenda-espacos');
const rotasMatrizes = require('../src/rotas/matrizes');
const rotasCpa = require('../src/rotas/cpa');
const rotasCad = require('../src/rotas/cad');
const rotasCorrecao = require('../src/rotas/correcao-provas');
const rotasTrilhaEad = require('../src/rotas/trilha-ead');
const rotasPlanoAcao = require('../src/rotas/plano-acao');
const rotasPlanoAcaoDocumentos = require('../src/rotas/plano-acao-documentos');
const rotasAutomacaoAva = require('../src/rotas/automacao-ava');
const rotasEadAulas = require('../src/rotas/ead-aulas');
const rotasLevantamentoEad = require('../src/rotas/levantamento-ead');
const rotasFinanceiroMedicina = require('../src/rotas/financeiro-medicina');
const rotasCustosTi = require('../src/rotas/custos-ti');

app.use('/api/emprestimos', rotasEmprestimo);
app.use('/api/usuarios', rotasUsuarios);
app.use('/api/meu-espaco', rotasMeuEspaco);
app.use('/api/empresas', rotasEmpresas);
app.use('/api/validacao', rotasValidacao);
app.use('/api/ferida', rotasFerida);
app.use('/api/almoxarifado-feridas', rotasAlmoxarifadoFeridas);
app.use('/api/almoxarifado-saude', rotasAlmoxarifadoSaude);
app.use('/api/secretaria-dp', rotasSecretariaDp);
app.use('/api/acessos', rotasAcessos);
app.use('/api/financeiro', rotasFinanceiro);
app.use('/api/matriculas', rotasMatriculas);
app.use('/api/processos', rotasProcessos);
app.use('/api/orcamento', rotasOrcamento);
app.use('/api/avaliacao-docente', rotasAvaliacaoDocente);
app.use('/api/cobranca/edubox', rotasCobrancaEdubox);
app.use('/api/banco-med-fatec', rotasBancoMedFatec);
app.use('/api/relatorio-desempenho', rotasRelatorioDesempenho);
app.use('/api/aplicacao-provas-med', rotasAplicacaoProvasMed);
app.use('/api/osce-med', rotasOsceMed);
app.use('/api/portfolio-med', rotasPortfolioMed);
app.use('/api/portfolio-publico', require('../src/rotas/portfolio-med-publico')); // link do professor, sem login (27/11/2026)
app.use('/api/banco-provas', rotasBancoProvas);
app.use('/api/formularios', rotasFormularios);
app.use('/api/confirmacao-evento', rotasConfirmacaoEvento);
app.use('/api/contratos', rotasContratos);
app.use('/api/aula-experimental', rotasAulaExperimental);
app.use('/api/auloes', rotasAuloes);
app.use('/api/palestras', rotasPalestras);
app.use('/api/agenda-espacos', rotasAgendaEspacos);
app.use('/api/matrizes', rotasMatrizes);
app.use('/api/cpa', rotasCpa);
app.use('/api/cad', rotasCad);
app.use('/api/correcao', rotasCorrecao);
app.use('/api/trilha-ead', rotasTrilhaEad);
app.use('/api/plano-acao/documentos', rotasPlanoAcaoDocumentos);
app.use('/api/plano-acao', rotasPlanoAcao);
app.use('/api/automacao-ava', rotasAutomacaoAva);
app.use('/api/ead-aulas', rotasEadAulas);
app.use('/api/levantamento-ead', rotasLevantamentoEad);
app.use('/api/financeiro-medicina', rotasFinanceiroMedicina);
app.use('/api/calendario-academico', rotasCalendarioAcademico);
app.use('/api/custos-ti', rotasCustosTi);

// Exportação obrigatória para o Vercel Serverless

module.exports = app;

// Caso o servidor seja rodado localmente (node api/index.js)
// Em produção o Vercel serve os arquivos estáticos direto (vercel.json só reescreve /api/*);
// localmente precisamos servir a pasta do projeto para as telas HTML abrirem.
if (require.main === module) {
    app.use(express.static(path.join(__dirname, '..'), {
        setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
    }));

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
}
