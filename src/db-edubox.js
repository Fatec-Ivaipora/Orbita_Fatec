const { Pool } = require('pg');

// Conexão somente-leitura ao Postgres do Edubox (sistema acadêmico terceiro).
// Usuário de banco "consulta": SELECT em todas as tabelas do schema `ivp`,
// sem INSERT/UPDATE/DELETE (a única exceção, INSERT/UPDATE em `tfi_cliente`,
// é feita no banco `edubox` ao vivo, não no `edubox_old` usado aqui pros
// relatórios). Ver `/regras/regra_do_app.md` (módulo CPA) para mais contexto.
if (!process.env.EDUBOX_HOST) {
    throw new Error('❌ Credenciais do Edubox não encontradas. Configure EDUBOX_HOST/EDUBOX_DATABASE/EDUBOX_USER/EDUBOX_PASSWORD no .env.');
}

const pool = new Pool({
    host: process.env.EDUBOX_HOST,
    port: parseInt(process.env.EDUBOX_PORT, 10) || 5432,
    database: process.env.EDUBOX_DATABASE || 'edubox_old',
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

async function query(text, params) {
    return pool.query(text, params);
}

module.exports = { pool, query };
