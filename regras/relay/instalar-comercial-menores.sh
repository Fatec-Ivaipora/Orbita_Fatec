#!/bin/bash
# Instala/atualiza a rota /comercial-menores/* do Órbita no relay do Edubox (menores de 18 entre os matriculados — 06/11/2026).
# Colar INTEIRO no Web Console do droplet (DigitalOcean), como root. Só acrescenta o bloco do Órbita; não toca no SIGMA nem nas outras rotas.
# Desfazer: cp /opt/edubox-relay/server.mjs.bak-menores-v2 /opt/edubox-relay/server.mjs && systemctl restart edubox-relay
set -e
cd /opt/edubox-relay
cp server.mjs server.mjs.bak-menores-v2
cat > /tmp/bloco-menores.mjs <<'BLOCO'
function menResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

const MEN_NOME_SQL = (col) => `regexp_replace(regexp_replace(translate(upper(trim(${col})), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN'), '[^A-Z0-9 ]+', ' ', 'g'), ' +', ' ', 'g')`;

async function menLista(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select distinct trim(${MEN_NOME_SQL('cl.nomcli')}) as nome, trim(c.codcur) as codcur,
             case when cl.nascli is null then 'sem' else 'menor' end as tipo
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        join tac_curso c on c.codcur = t.curtur
        join tfi_cliente cl on cl.codcli = m.climat
       where t.semtur = any($1)
         and (cl.nascli is null or cl.nascli > (current_date - interval '18 years'))`, [semestres]);
    return {
      ok: true,
      menores: r.rows.filter(x => x.tipo === 'menor').map(x => ({ nome: x.nome, codcur: x.codcur })),
      semNascimento: r.rows.filter(x => x.tipo === 'sem').map(x => ({ nome: x.nome, codcur: x.codcur }))
    };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

// Aniversário de 18 anos (só de quem completa 18 entre 1 ano atrás e o futuro) — pra saber se era menor
// NA DATA DA MATRÍCULA/CONTRATO, não só hoje (v2, 06/11/2026). Devolve nome, curso e a data em que faz 18.
async function menAniversarios(semestres) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select distinct trim(${MEN_NOME_SQL('cl.nomcli')}) as nome, trim(c.codcur) as codcur,
             to_char(cl.nascli + interval '18 years', 'YYYY-MM-DD') as faz18
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        join tac_curso c on c.codcur = t.curtur
        join tfi_cliente cl on cl.codcli = m.climat
       where t.semtur = any($1)
         and cl.nascli is not null
         and cl.nascli > (current_date - interval '19 years')`, [semestres]);
    return { ok: true, alunos: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaComercialMenores(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/comercial-menores/')) return false;
  if (!autenticadoOrbita(req)) { menResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { menResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/comercial-menores/ping') { menResponder(res, 200, { ok: true, rotas: 'comercial-menores', versao: 2 }); return true; }
  if (u.pathname === '/comercial-menores/aniversarios') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    if (!semestres.length) { menResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await menAniversarios(semestres);
    menResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (u.pathname === '/comercial-menores/lista') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    if (!semestres.length) { menResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    const r = await menLista(semestres);
    menResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  menResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
BLOCO
node -e '
const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const bloco = fs.readFileSync("/tmp/bloco-menores.mjs", "utf8");
const MARCA = "// ---- Órbita — Comercial menores";
const FIM = "// ---- fim Órbita — Comercial menores ----";
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
  s = s.slice(0, ini) + recuo + "if (await rotaOrbitaComercialMenores(req, res)) return; // Órbita — Comercial menores\n" + s.slice(ini);
  // antes dos outros blocos do Órbita (cada instalador troca só o que está entre os próprios marcadores;
  // o da AVA troca do marcador dela até o createServer) — assim nenhum reinstalar apaga este bloco
  const cands = [s.indexOf("// ---- Órbita — Cobrança conferência"), s.indexOf("// ---- Órbita — Comercial (v"), s.indexOf("// ---- Órbita — Automação AVA"), s.indexOf("const server = http.createServer(")].filter(x => x >= 0);
  const p = Math.min(...cands);
  s = s.slice(0, p) + MARCA + " (v2) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(p);
  console.log("bloco inserido");
}
fs.writeFileSync("server.mjs", s);
'
node --check server.mjs && chown relay:relay server.mjs && systemctl restart edubox-relay && sleep 2 && systemctl is-active edubox-relay
TOKEN=$(grep -E '^ORBITA_TOKEN=' /opt/edubox-relay/.env | cut -d= -f2- | tr -d '"'"'"' ')
curl -s "http://localhost:8443/comercial-menores/ping" -H "Authorization: Bearer $TOKEN"; echo
curl -s "http://localhost:8443/comercial-menores/aniversarios?semestres=2027/1,2027-1" -H "Authorization: Bearer $TOKEN" | head -c 160; echo " ..."
