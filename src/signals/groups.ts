// ─── GRUPOS DE SINAIS (Telegram) ──────────────────────────────────────────────
// Nome → ID do grupo. Pode sobrescrever por .env (GROUP_BRUXAO, GROUP_ELITE etc.).
// IDs de supergrupo do gramjs vêm como -100XXXXXXXXXX (o coletor compara pelo "bare id").
// IDs confirmados via getDialogs (conta é membro direto destes canais).
// REI = "Rei Do Futebol Virtual" (-1001639811606), confirmado pelo usuário em 2026-07-11.
export const SIGNAL_GROUPS: Record<string, string> = {
    BRUXAO: process.env.GROUP_BRUXAO ?? '-1001736730131',  // 🥇BRUXÃO TIPS🥇
    ELITE:  process.env.GROUP_ELITE  ?? '-1001360948390',  // ELITE TEAM
    BRUU:   process.env.GROUP_BRUU   ?? '-1001747408884',  // 𝙈𝙀𝙉𝙏𝙊𝙍𝘼 𝘽𝙍𝙐𝙐
    REI:    process.env.GROUP_REI    ?? '-1001639811606',  // Rei Do Futebol Virtual
};

// Normaliza qualquer forma de ID (-1003972273645, -1005245059079, 5245059079)
// para um "bare id" comparável (remove o prefixo -100 dos supergrupos).
export const bareId = (id: string | number): string =>
    String(id).replace(/^-?100/, '').replace(/^-/, '');

export const GROUP_BY_BARE = new Map<string, string>();
for (const [nome, id] of Object.entries(SIGNAL_GROUPS)) {
    GROUP_BY_BARE.set(bareId(id), nome);
}

// Retorna o NOME do grupo (ELITE_TEAM…) se o chat for monitorado por ID, senão undefined.
export const grupoDoChat = (chatId?: string | number | null): string | undefined =>
    (chatId === null || chatId === undefined) ? undefined : GROUP_BY_BARE.get(bareId(chatId));

// Normaliza título p/ comparação (sem acento/emoji/símbolos, minúsculo, MANTÉM
// espaços como separador de palavras). Ex.: "🥇BRUXÃO TIPS🥇" → "bruxao tips".
const norm = (s: string): string =>
    (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Aliases opcionais por env: GROUP_ELITE_ALIAS="elite,time da elite" etc.
const aliasesDe = (nome: string): string[] => {
    const env = process.env[`GROUP_${nome}_ALIAS`];
    const extra = env ? env.split(',').map(s => s.trim()).filter(Boolean) : [];
    return [nome, ...extra].map(norm).filter(Boolean);
};

// Casa o grupo pelo TÍTULO do chat — como FALLBACK do ID.
// ⚠️ Match por PALAVRA (não substring solta), senão nomes curtos como "REI"
// casariam com "Lureis"/"Costureira"/"Pedreiro". Regras:
//  - alias com espaço → precisa aparecer como trecho no título;
//  - alias com ≥5 letras → substring do título (sem espaços) OU palavra exata;
//  - alias curto (ex.: REI, BRUU) → precisa ser uma PALAVRA exata do título.
export const grupoPorTitulo = (title?: string | null): string | undefined => {
    if (!title) return undefined;
    const t = norm(title);
    const palavras = new Set(t.split(' ').filter(Boolean));
    const semEspaco = t.replace(/ /g, '');
    for (const nome of Object.keys(SIGNAL_GROUPS)) {
        for (const a of aliasesDe(nome)) {
            if (!a) continue;
            if (a.includes(' ')) { if (t.includes(a)) return nome; }
            else if (a.length >= 5) { if (palavras.has(a) || semEspaco.includes(a)) return nome; }
            else { if (palavras.has(a)) return nome; }
        }
    }
    return undefined;
};

// Resolve o grupo por ID e, como fallback, por título.
export const resolverGrupo = (chatId?: string | number | null, title?: string | null): string | undefined =>
    grupoDoChat(chatId) ?? grupoPorTitulo(title);
