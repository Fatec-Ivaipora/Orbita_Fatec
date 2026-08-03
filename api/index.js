const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Middlewares globais
// Origens permitidas: apenas o painel web oficial e ambiente de desenvolvimento local.
const ALLOWED_ORIGINS = [
    'https://orbita-fatecivp.web.app',       // Firebase Hosting (produção)
    'https://orbita-fatecivp.firebaseapp.com', // Firebase Hosting (alternativo)
    'https://orbita-fatec-ti.vercel.app',     // Vercel (produção)
    'http://localhost:3000',                  // Desenvolvimento local (backend)
    'http://127.0.0.1:3000',                  // Desenvolvimento local (backend)
];

const corsOptions = {
    origin: (origin, callback) => {
        // Permite requisições sem origin (Postman, APK nativo, curl, etc.)
        // E permite qualquer porta no localhost/127.0.0.1 para desenvolvimento local
        const isLocalhost = origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        const isVercelSubdomain = origin && /^https:\/\/.*\.vercel\.app$/.test(origin);
        if (!origin || ALLOWED_ORIGINS.includes(origin) || isLocalhost || isVercelSubdomain) {
            callback(null, true);
        } else {
            callback(new Error(`CORS: Origem não autorizada — ${origin}`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Responder a preflights OPTIONS explicitamente
app.options(/.*/, cors(corsOptions));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));



// Rota de Teste para garantir que a API está no ar
app.get('/api', (req, res) => {
    res.json({ status: 'success', message: 'Órbita FATEC API está online!' });
});

// Importação das rotas
const rotasEmprestimo = require('../src/rotas/emprestimos');
const rotasUsuarios = require('../src/rotas/usuarios');
const rotasEnsalamento = require('../src/rotas/ensalamento');
const rotasMeuEspaco = require('../src/rotas/meu-espaco');
const rotasCargaHoraria = require('../src/rotas/carga-horaria');
const rotasEmpresas = require('../src/rotas/empresas');
const rotasValidacao = require('../src/rotas/validacao');
const rotasCpa = require('../src/rotas/cpa');
const rotasAgenda = require('../src/rotas/agenda');
const rotasLocais = require('../src/rotas/locais');
const rotasFerida = require('../src/rotas/ferida');
const rotasAlmoxarifadoFeridas = require('../src/rotas/almoxarifado-feridas');
const rotasAlmoxarifadoSaude = require('../src/rotas/almoxarifado-saude');
const rotasSecretariaDp = require('../src/rotas/secretaria-dp');
const rotasAcessos = require('../src/rotas/acessos');
const rotasFinanceiro = require('../src/rotas/financeiro');
const rotasMatriculas = require('../src/rotas/matriculas');

app.use('/api/emprestimos', rotasEmprestimo);
app.use('/api/usuarios', rotasUsuarios);
app.use('/api/ensalamento', rotasEnsalamento);
app.use('/api/meu-espaco', rotasMeuEspaco);
app.use('/api/carga-horaria', rotasCargaHoraria);
app.use('/api/empresas', rotasEmpresas);
app.use('/api/validacao', rotasValidacao);
app.use('/api/cpa', rotasCpa);
app.use('/api/agenda', rotasAgenda);
app.use('/api/locais', rotasLocais);
app.use('/api/ferida', rotasFerida);
app.use('/api/almoxarifado-feridas', rotasAlmoxarifadoFeridas);
app.use('/api/almoxarifado-saude', rotasAlmoxarifadoSaude);
app.use('/api/secretaria-dp', rotasSecretariaDp);
app.use('/api/acessos', rotasAcessos);
app.use('/api/financeiro', rotasFinanceiro);
app.use('/api/matriculas', rotasMatriculas);

// Exportação obrigatória para o Vercel Serverless

module.exports = app;

// Caso o servidor seja rodado localmente (node api/index.js)
// Em produção o Vercel serve os arquivos estáticos direto (vercel.json só reescreve /api/*);
// localmente precisamos servir a pasta do projeto para as telas HTML abrirem.
if (require.main === module) {
    app.use(express.static(path.join(__dirname, '..')));

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
}
