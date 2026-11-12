#!/bin/bash
# Instala/atualiza a rota /orbita-diag/* (diagnostico SO LEITURA do Edubox p/ o Orbita - 09/11/2026; v2 12/11/2026: colunas do financeiro).
# Colar no Web Console do droplet (DigitalOcean), como root. Desfazer: cp /opt/edubox-relay/server.mjs.bak-diag /opt/edubox-relay/server.mjs && systemctl restart edubox-relay
set -e
cd /opt/edubox-relay
cp server.mjs server.mjs.bak-diag
cat > /tmp/bloco-diag.mjs <<'BLOCO'
function diagResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

const DIAG_TABELAS = ['tac_matricula', 'tac_ingresso'];

async function diagConsulta(fn) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    await client.query("set statement_timeout = '20s';");
    return { ok: true, ...(await fn(client)) };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* ja fechado */ }
  }
}

// colunas das tabelas de matricula/ingresso/aluno e de tabelas com nome de contrato/assinatura/aceite/termo
function diagColunas() {
  return diagConsulta(async (c) => {
    const r = await c.query(`
      select table_name as tabela, column_name as coluna, data_type as tipo
        from information_schema.columns
       where table_schema = 'ivp'
         and (table_name in ('tac_matricula', 'tac_ingresso', 'tac_aluno')
              or table_name ~* '(contrat|assin|aceit|termo|ingres|formaing|tipoing)')
       order by table_name, ordinal_position
       limit 800`);
    return { colunas: r.rows };
  });
}

// colunas das tabelas do FINANCEIRO (tfi_*) e de qualquer tabela com observacao/plano/desconto no nome — so
// nome/tipo das colunas, nenhum dado (12/11/2026: fechamento do dia das Matriculas — parcelas, desconto, vencimento)
function diagColunasFinanceiro() {
  return diagConsulta(async (c) => {
    const r = await c.query(`
      select table_name as tabela, column_name as coluna, data_type as tipo
        from information_schema.columns
       where table_schema = 'ivp'
         and (table_name ~ '^tfi_' or table_name ~* '(obs|plano|descont|bolsa|financ)')
       order by table_name, ordinal_position
       limit 2500`);
    return { colunas: r.rows };
  });
}

// contagem por valor de UMA coluna (so tac_matricula / tac_ingresso), so das matriculas dos semestres pedidos.
// Devolve valor + quantidade; nada de nome/CPF. A coluna e conferida no information_schema.
function diagValores(tabela, coluna, semestres) {
  return diagConsulta(async (c) => {
    const ok = await c.query(`select 1 from information_schema.columns where table_schema = 'ivp' and table_name = $1 and column_name = $2`, [tabela, coluna]);
    if (!ok.rowCount) return { erro: 'coluna inexistente' };
    const col = tabela === 'tac_matricula' ? `m."${coluna}"` : `i."${coluna}"`;
    const r = await c.query(`
      select ${col}::text as valor, count(*)::int as qtd,
             count(*) filter (where i.seming = t.semtur)::int as qtd_ingresso_no_semestre
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        left join tac_ingresso i on i.coding = m.ingmat
       where t.semtur = any($1)
       group by 1
       order by 2 desc
       limit 100`, [semestres]);
    return { tabela, coluna, valores: r.rows };
  });
}

// visao geral do semestre: calouro (ingresso no proprio semestre) x veterano, por situacao da matricula e curso
function diagResumo(semestres) {
  return diagConsulta(async (c) => {
    const r = await c.query(`
      select trim(t.curtur) as curso, m.stamat::text as situacao,
             (i.seming = t.semtur) as ingresso_no_semestre,
             (select count(*) from tac_ingresso i2 where i2.aluing = i.aluing and i2.coding <> i.coding)::int > 0 as tem_outro_ingresso,
             count(*)::int as qtd
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        left join tac_ingresso i on i.coding = m.ingmat
       where t.semtur = any($1)
       group by 1, 2, 3, 4
       order by 1, 2`, [semestres]);
    return { resumo: r.rows };
  });
}

async function rotaOrbitaDiag(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/orbita-diag/')) return false;
  if (!autenticadoOrbita(req)) { diagResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { diagResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  const semestres = String(u.searchParams.get('semestres') || '2027/1,2027-1').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
  if (u.pathname === '/orbita-diag/ping') { diagResponder(res, 200, { ok: true, rotas: 'orbita-diag', versao: 2 }); return true; }
  if (u.pathname === '/orbita-diag/colunas-financeiro') { const r = await diagColunasFinanceiro(); diagResponder(res, r.ok ? 200 : 500, r); return true; }
  if (u.pathname === '/orbita-diag/colunas') { const r = await diagColunas(); diagResponder(res, r.ok ? 200 : 500, r); return true; }
  if (u.pathname === '/orbita-diag/resumo') { const r = await diagResumo(semestres); diagResponder(res, r.ok ? 200 : 500, r); return true; }
  if (u.pathname === '/orbita-diag/valores') {
    const tabela = u.searchParams.get('tabela'), coluna = String(u.searchParams.get('coluna') || '');
    if (!DIAG_TABELAS.includes(tabela) || !/^[a-z0-9_]{2,40}$/.test(coluna)) { diagResponder(res, 400, { ok: false, erro: 'tabela/coluna invalida' }); return true; }
    const r = await diagValores(tabela, coluna, semestres);
    diagResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  diagResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
BLOCO
node -e '
const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const bloco = fs.readFileSync("/tmp/bloco-diag.mjs", "utf8");
const MARCA = "// ---- Órbita — Diagnóstico matrículas";
const FIM = "// ---- fim Órbita — Diagnóstico matrículas ----";
const a = s.indexOf("const server = http.createServer(");
if (a < 0) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
const m = s.indexOf(MARCA), f = s.indexOf(FIM);
if (m >= 0 && f > m && f < a) {
  s = s.slice(0, m) + MARCA + " (v2) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(f + FIM.length + 1);
  console.log("bloco atualizado");
} else {
  const g = s.indexOf("if (!autenticado(req))", a);
  if (g < 0) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
  const ini = s.lastIndexOf("\n", g) + 1, recuo = s.slice(ini, g);
  s = s.slice(0, ini) + recuo + "if (await rotaOrbitaDiag(req, res)) return; // Órbita — Diagnóstico matrículas\n" + s.slice(ini);
  const cands = [s.indexOf("// ---- Órbita — Comercial menores"), s.indexOf("// ---- Órbita — Cobrança conferência"), s.indexOf("// ---- Órbita — Comercial (v"), s.indexOf("// ---- Órbita — Automação AVA"), s.indexOf("const server = http.createServer(")].filter(x => x >= 0);
  const p = Math.min(...cands);
  s = s.slice(0, p) + MARCA + " (v2) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(p);
  console.log("bloco inserido");
}
fs.writeFileSync("server.mjs", s);
'
node --check server.mjs && chown relay:relay server.mjs && systemctl restart edubox-relay && sleep 2 && systemctl is-active edubox-relay
TOKEN=$(grep -E '^ORBITA_TOKEN=' /opt/edubox-relay/.env | cut -d= -f2- | tr -d '"'"'"' ')
curl -s "http://localhost:8443/orbita-diag/ping" -H "Authorization: Bearer $TOKEN"; echo
curl -s "http://localhost:8443/orbita-diag/colunas-financeiro" -H "Authorization: Bearer $TOKEN" | head -c 200; echo " ..."
