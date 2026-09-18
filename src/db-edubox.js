const { Pool } = require('pg');

// Conexão somente-leitura ao Postgres do Edubox (sistema acadêmico terceiro).
// Usuário de banco "consulta": SELECT em todas as tabelas do schema `ivp`,
// sem INSERT/UPDATE/DELETE. Recriado (18/09) pro módulo de Confirmação de
// Presença em Evento (Docência) — já tinha existido antes pro módulo CPA
// (removido em 2026-08-11 por falta de uso; ver histórico do git).
if (!process.env.EDUBOX_HOST) {
    throw new Error('❌ Credenciais do Edubox não encontradas. Configure EDUBOX_HOST/EDUBOX_DATABASE/EDUBOX_USER/EDUBOX_PASSWORD no .env.');
}

const pool = new Pool({
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

async function query(text, params) {
    return pool.query(text, params);
}

module.exports = { pool, query };
