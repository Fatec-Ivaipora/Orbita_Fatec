#!/usr/bin/env node
// Lê o diff do que está sendo commitado (via stdin) e barra o commit se achar
// padrão de segredo/chave externa hardcoded. Ver AGENTS.md ("Nunca hardcode
// segredo ou chave externa no código") — criado depois do incidente de
// 17/11/2026 (URL do Google Apps Script com token ficou no código 2 meses).
//
// Detecta só padrões de alta confiança (prefixo de token conhecido, URL com
// credencial na query string, chave privada) — não substitui revisão manual.

const PADROES = [
    { nome: 'URL com token/key/secret na query string', re: /https?:\/\/[^\s"'>]*[?&](token|key|secret|api[_-]?key|access[_-]?token)=[^\s"'>]{8,}/i },
    { nome: 'GitHub personal access token', re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
    { nome: 'Deploy ID de Google Apps Script (AKfy...)', re: /\bAKfy[A-Za-z0-9_-]{20,}\b/ },
    { nome: 'Chave privada', re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
    { nome: 'String de conexão com senha embutida', re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?):\/\/[^\s"'>]+:[^\s"'>@]+@/i },
    { nome: 'Chave da OpenAI/Anthropic/estilo sk-', re: /\bsk-[A-Za-z0-9]{20,}\b/ }
];

let entrada = '';
process.stdin.on('data', d => entrada += d);
process.stdin.on('end', () => {
    const linhas = entrada.split('\n');
    let arquivoAtual = null;
    const achados = [];

    for (const linha of linhas) {
        const m = linha.match(/^\+\+\+ b\/(.*)$/);
        if (m) { arquivoAtual = m[1]; continue; }
        if (!linha.startsWith('+') || linha.startsWith('+++')) continue;

        for (const padrao of PADROES) {
            if (padrao.re.test(linha)) {
                achados.push({ arquivo: arquivoAtual || '(desconhecido)', padrao: padrao.nome, trecho: linha.slice(0, 120) });
            }
        }
    }

    if (achados.length) {
        console.error('\n🛑 Commit bloqueado — parece ter segredo/chave externa hardcoded:\n');
        for (const a of achados) {
            console.error(`  [${a.padrao}] ${a.arquivo}`);
            console.error(`    ${a.trecho}`);
        }
        console.error('\nSe for segredo de verdade: mova pro .env (nunca commitado) e documente só o NOME da variável em .env_exemplo.');
        console.error('Se for falso positivo (ex.: chave web pública do Firebase, que é ok ficar no código): "git commit --no-verify" pula essa checagem — só use se tiver certeza.\n');
        process.exit(1);
    }
    process.exit(0);
});
