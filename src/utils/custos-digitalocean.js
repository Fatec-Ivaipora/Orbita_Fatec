// Custo do servidor do relay na DigitalOcean, via API de billing deles.
// Sem DIGITALOCEAN_API_TOKEN configurado, devolve { configurado: false }
// em vez de quebrar (mesmo padrão de src/utils/rota-coleta.js).
//
// Variável de ambiente necessária:
//   DIGITALOCEAN_API_TOKEN — token de API, escopo "Billing", só leitura

function configurado() {
    return !!process.env.DIGITALOCEAN_API_TOKEN;
}

async function chamar(caminho) {
    const res = await fetch(`https://api.digitalocean.com/v2${caminho}`, {
        headers: { Authorization: `Bearer ${process.env.DIGITALOCEAN_API_TOKEN}` },
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`DigitalOcean respondeu ${res.status} em ${caminho}`);
    return res.json();
}

// Saldo e gasto do mês corrente.
async function resumoMensal() {
    if (!configurado()) return { configurado: false };
    const dados = await chamar('/customers/my/balance');
    return {
        configurado: true,
        mesAtual: Number(dados.month_to_date_usage || 0),
        saldo: Number(dados.account_balance || 0),
        geradoEm: dados.generated_at || null
    };
}

// Histórico de faturas (uma linha por item de cobrança, já paginado pela DO
// — só a primeira página, suficiente pro gráfico dos últimos meses).
async function historicoFaturas() {
    if (!configurado()) return { configurado: false };
    const dados = await chamar('/customers/my/billing_history?per_page=200');
    const itens = (dados.billing_history || []).map(i => ({
        data: i.date,
        tipo: i.type,
        descricao: i.description,
        valor: Number(i.amount || 0)
    }));
    return { configurado: true, itens };
}

module.exports = { configurado, resumoMensal, historicoFaturas };
