// Custo do Google Cloud (Órbita + SIGMA, mesma conta de faturamento), via
// BigQuery Billing Export — precisa estar configurado no Console do Google
// Cloud (Billing → Billing export → BigQuery). Sem isso, devolve
// { configurado: false } em vez de quebrar (mesmo padrão de
// src/utils/rota-coleta.js com GOOGLE_MAPS_API_KEY).
//
// Variáveis de ambiente necessárias:
//   GCP_BILLING_SA_KEY       — JSON da service account (inteiro, numa linha), OU
//   GCP_BILLING_SA_KEY_PATH  — caminho pro arquivo da service account
//   GCP_BILLING_QUERY_PROJECT — projeto do GCP onde a query do BigQuery roda (cobrada a quem consulta)
//   GCP_BILLING_DATASET      — dataset.tabela do billing export (ex.: billing_export.gcp_billing_export_v1_XXXXXX)
//   GCP_FIREBASE_PROJECT_ID  — id do projeto do Órbita no billing export (padrão: orbita-fatecivp)
//   GCP_SIGMA_PROJECT_ID     — id do projeto do SIGMA no billing export (opcional — sem ele, só mostra Órbita)

const PROJETO_ORBITA = process.env.GCP_FIREBASE_PROJECT_ID || 'orbita-fatecivp';
const PROJETO_SIGMA = process.env.GCP_SIGMA_PROJECT_ID || null;

function configurado() {
    return !!(
        process.env.GCP_BILLING_DATASET &&
        process.env.GCP_BILLING_QUERY_PROJECT &&
        (process.env.GCP_BILLING_SA_KEY || process.env.GCP_BILLING_SA_KEY_PATH)
    );
}

let authClientPromise = null;
function getAuthClient() {
    if (!authClientPromise) {
        // Lazy require: google-auth-library só é carregada se alguém realmente
        // chamar uma função deste arquivo (evita custo de boot em quem não usa).
        const { GoogleAuth } = require('google-auth-library');
        const scopes = [
            'https://www.googleapis.com/auth/bigquery.readonly',
            'https://www.googleapis.com/auth/cloud-platform.read-only'
        ];
        const options = { scopes };
        if (process.env.GCP_BILLING_SA_KEY) {
            options.credentials = JSON.parse(process.env.GCP_BILLING_SA_KEY);
        } else {
            options.keyFile = process.env.GCP_BILLING_SA_KEY_PATH;
        }
        authClientPromise = new GoogleAuth(options).getClient();
    }
    return authClientPromise;
}

// Roda uma query no BigQuery e devolve as linhas já como objetos simples
// (nome da coluna -> valor), em vez do formato bruto {f:[{v:...}]} da API.
async function query(sql) {
    const client = await getAuthClient();
    const res = await client.request({
        url: `https://bigquery.googleapis.com/bigquery/v2/projects/${process.env.GCP_BILLING_QUERY_PROJECT}/queries`,
        method: 'POST',
        data: { query: sql, useLegacySql: false, timeoutMs: 20000 }
    });
    const campos = (res.data.schema && res.data.schema.fields) || [];
    return (res.data.rows || []).map(linha => {
        const obj = {};
        linha.f.forEach((celula, i) => { obj[campos[i].name] = celula.v; });
        return obj;
    });
}

const TABELA = () => `\`${process.env.GCP_BILLING_DATASET.replace(/`/g, '')}\``;

// Gasto do mês atual e do mês anterior, por projeto (Órbita x SIGMA).
async function resumoMensal() {
    if (!configurado()) return { configurado: false };
    const projetos = [PROJETO_ORBITA, PROJETO_SIGMA].filter(Boolean);
    const sql = `
        SELECT
            project.id AS projeto,
            SUM(IF(DATE(usage_start_time) >= DATE_TRUNC(CURRENT_DATE(), MONTH), cost, 0)) AS mesAtual,
            SUM(IF(DATE(usage_start_time) >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH)
                   AND DATE(usage_start_time) < DATE_TRUNC(CURRENT_DATE(), MONTH), cost, 0)) AS mesAnterior
        FROM ${TABELA()}
        WHERE project.id IN UNNEST(@projetos)
          AND usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 62 DAY)
        GROUP BY projeto
    `.replace('@projetos', `[${projetos.map(p => `'${p}'`).join(',')}]`);
    const linhas = await query(sql);
    return {
        configurado: true,
        porProjeto: linhas.map(l => ({
            projeto: l.projeto,
            mesAtual: Number(l.mesAtual || 0),
            mesAnterior: Number(l.mesAnterior || 0)
        }))
    };
}

// Gasto diário dos últimos N dias, por projeto e por categoria de serviço
// (separa "Cloud Firestore" de "Cloud Functions"/"Hosting" etc. — é o mais
// perto que dá de "é mais leitura ou escrita" só com o billing export).
async function historicoDiario(dias = 30) {
    if (!configurado()) return { configurado: false };
    const projetos = [PROJETO_ORBITA, PROJETO_SIGMA].filter(Boolean);
    const sql = `
        SELECT
            DATE(usage_start_time) AS dia,
            project.id AS projeto,
            service.description AS servico,
            SUM(cost) AS custo
        FROM ${TABELA()}
        WHERE project.id IN UNNEST(@projetos)
          AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${Math.min(Number(dias) || 30, 365)} DAY)
        GROUP BY dia, projeto, servico
        ORDER BY dia
    `.replace('@projetos', `[${projetos.map(p => `'${p}'`).join(',')}]`);
    const linhas = await query(sql);
    return {
        configurado: true,
        linhas: linhas.map(l => ({ dia: l.dia, projeto: l.projeto, servico: l.servico, custo: Number(l.custo || 0) }))
    };
}

module.exports = { configurado, resumoMensal, historicoDiario };
