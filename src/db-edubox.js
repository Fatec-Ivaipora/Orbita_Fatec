const { Pool } = require('pg');

// Conexão somente-leitura ao Postgres do Edubox (sistema acadêmico/financeiro
// terceiro). Usuário de banco "consulta": SELECT em todas as tabelas do
// schema `ivp`, sem INSERT/UPDATE/DELETE.
//
// Banco `edubox` (ao vivo), não `edubox_old` (réplica de relatório usada
// pelo extinto módulo CPA) — testado em 2026-08-31: `edubox_old` estava
// ~3 meses desatualizado. Para o módulo Cobrança isso não é aceitável
// (aluno que já pagou apareceria como devedor), então usamos o banco
// transacional mesmo, só de leitura.
//
// Importante: NÃO lança erro aqui em cima (nível de módulo) se faltar
// configuração — este arquivo é importado por `api/index.js` junto de todas
// as outras rotas, então um throw aqui derrubaria o app inteiro sempre que
// EDUBOX_* não estiver configurado (ex.: esquecer de configurar as env vars
// na Vercel). Em vez disso, `pool` fica `null` e o erro só acontece dentro
// de `query()`, isolado à rota que efetivamente precisar do Edubox.
let pool = null;

if (process.env.EDUBOX_HOST) {
    pool = new Pool({
        host: process.env.EDUBOX_HOST,
        port: parseInt(process.env.EDUBOX_PORT, 10) || 5432,
        database: process.env.EDUBOX_DATABASE || 'edubox',
        user: process.env.EDUBOX_USER,
        password: process.env.EDUBOX_PASSWORD,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 15000,
    });

    pool.on('connect', (client) => {
        // As tabelas de interesse vivem no schema `ivp`, não no `public` padrão.
        client.query('SET search_path = ivp, public; SET default_transaction_read_only = on;');
    });
} else {
    console.error('⚠️  EDUBOX_HOST não configurado — o módulo Cobrança vai retornar erro até EDUBOX_HOST/EDUBOX_DATABASE/EDUBOX_USER/EDUBOX_PASSWORD serem definidos (.env local ou variáveis de ambiente da Vercel).');
}

async function query(text, params) {
    if (!pool) {
        throw new Error('Credenciais do Edubox não configuradas (EDUBOX_HOST/EDUBOX_DATABASE/EDUBOX_USER/EDUBOX_PASSWORD).');
    }
    return pool.query(text, params);
}

module.exports = { pool, query };
