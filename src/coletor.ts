require('dotenv').config()
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { EditedMessage, EditedMessageEvent } from "telegram/events/EditedMessage";
import { DeletedMessage, DeletedMessageEvent } from "telegram/events/DeletedMessage";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

import { LogLevel } from "telegram/extensions/Logger";
import { resolverGrupo, grupoDoChat, grupoPorTitulo, SIGNAL_GROUPS } from "./signals/groups";
import { infoForward } from "./signals/telegram";
import { parseMensagem, isSignal, isResultado, extrairOdd, temLigaEMinutos, extrairReferencia, RE_GREEN, RE_RED } from "./signals/parser";

// ─── COLETOR / OBSERVER (somente escuta — NÃO abre navegador, NÃO aposta) ──────
// Objetivo: descobrir o FORMATO real das mensagens e provar se os eventos de
// EDIÇÃO (update) e RESPOSTA (reply) chegam corretamente pelo gramjs, para então
// consertar a detecção de GREEN no bot. Gera um relatório JSON.

const { log, warn } = console;
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = String(process.env.TELEGRAM_API_HASH);

// Config
const SNIFF_ALL = String(process.env.SNIFF_ALL ?? "false") === "true"; // true = observa TODOS os chats (p/ descobrir IDs)
const ONLY_SIGNALS = String(process.env.SNIFF_ONLY_SIGNALS ?? "true") === "true"; // true = armazena SÓ sinais de futebol virtual + confirmações
const OUT_DIR = process.env.SNIFF_OUT || path.join(process.cwd(), "coletor-out");
const REPORT_PATH = path.join(OUT_DIR, "coletor-relatorio.json");
const RAW_PATH = path.join(OUT_DIR, "raw.jsonl");                      // append-only: toda msg vista (à prova de zeramento)
const FLUSH_MS = Number(process.env.SNIFF_FLUSH_MS ?? 10000);          // grava o JSON a cada X ms
const DURATION_MS = Number(process.env.SNIFF_DURATION_MS ?? 0);        // 0 = roda até Ctrl+C
const HISTORY = Number(process.env.SNIFF_HISTORY ?? 40);               // nº de msgs recentes por canal a cada polling
const POLL_MS = Number(process.env.SNIFF_POLL_MS ?? 45000);           // intervalo do POLLING de histórico (não depende do stream ao vivo)

const askQuestion = (q: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(res => rl.question(q, a => { rl.close(); res(a); }));
};

const nowISO = () => new Date().toISOString();
const ensureOut = () => { if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true }); };

// Append-only: grava CADA mensagem vista imediatamente, antes de qualquer filtro.
// Não pode ser zerado por execução concorrente (append) e independe do relatório.
const appendRaw = (obj: any) => {
    try { ensureOut(); fs.appendFileSync(RAW_PATH, JSON.stringify(obj) + "\n"); } catch { /* ignora */ }
};

// ─── ESTADO DA COLETA ──────────────────────────────────────────────────────────

interface EventoColetado {
    seq: number;
    tipo: "new" | "edit" | "delete";
    capturadoEm: string;
    chatId: string | null;
    chatTitle: string | null;
    grupoConhecido: string | null;   // ELITE_TEAM… se o chat estiver monitorado
    messageId: number | null;
    senderId: string | null;
    date: number | null;             // unix (do Telegram)
    editDate: number | null;
    // Texto:
    text: string;
    textLen: number;
    textoAnterior: string | null;    // só em edições: o texto que tínhamos antes
    // Reply / referência:
    isReply: boolean;
    replyToMsgId: number | null;
    replyApontaParaMsgVista: boolean; // o msg respondido está no nosso histórico?
    replyApontaParaSinalAtivo: boolean;
    // Encaminhamento: quando a msg é repostada de um canal (o sinal REAL vem do canal origem).
    forward: { fromId: string | null; fromName: string | null } | null;
    viaBotId: string | null;
    // Código do canal (-100…) citado no texto (ex.: mensagens "CHANNEL CHECK").
    codigoCanal: string | null;
    isChannelCheck: boolean;
    // Emojis podem vir como ENTIDADES (custom emoji premium) e NÃO no texto:
    temEntidades: boolean;
    entidades: Array<{ tipo: string; offset?: number; length?: number; documentId?: string }>;
    temMedia: boolean;
    odd: number | null;              // odd de futebol virtual, se presente no texto
    // O que o classificador ATUAL decidiria:
    classificacao: {
        isSignal: boolean;
        isResultado: null | { green: boolean; red: boolean };
        greenRegex: boolean;
        redRegex: boolean;
        parsed: ReturnType<typeof parseMensagem> | null;
    };
}

const eventos: EventoColetado[] = [];
let seq = 0;

// Histórico de mensagens vistas (para diff de edição e resolução de reply).
// chave: `${chatId}:${msgId}` → { text, isSignal }
const historico = new Map<string, { text: string; isSignal: boolean }>();
const titleCache = new Map<string, string>();

// ── Rastreio de GREEN para ESTIMATIVA de acerto ──────────────────────────────
// chave do sinal → dados; e o conjunto de sinais que receberam GREEN.
const sinaisVistos = new Map<string, { grupo: string | null; liga: string | null; hora: string | null; odd: number | null; capturadoEm: string }>();
const greensPorSinal = new Set<string>();
const redsPorSinal = new Set<string>();

// Índice do último SINAL armazenado que ainda não tem grupo — para atribuir via
// mensagem "CHANNEL CHECK" que chega logo depois com o código do canal (-100…).
let ultimoSinalIdxSemGrupo = -1;

// Contagem de updates crus por tipo (diagnóstico do que o gramjs entrega).
const tiposUpdate: Record<string, number> = {};

// Dedupe do polling: chave da msg → último texto visto (evita reprocessar/reduplicar).
const ultimaVersao = new Map<string, string>();

// Corre uma promise com timeout: se estourar, devolve null e segue (não trava o fluxo).
const comTimeout = (p: Promise<any>, ms: number, label: string): Promise<any> =>
    Promise.race([
        p.catch((e: any) => { warn(`⚠️ ${label} erro:`, e?.message || e); return null; }),
        new Promise((res) => setTimeout(() => { warn(`⏱️ ${label} passou de ${ms}ms — seguindo sem esperar.`); res(null); }, ms)),
    ]);

// Contadores para o "observer"
const contadores = {
    novas: 0, edicoes: 0, delecoes: 0,
    replies: 0,
    sinais: 0, resultados: 0,
    edicoesEmSinalConhecido: 0,
    edicoesQueViraramResultado: 0,
    greenDetectados: 0, redDetectados: 0,
    emojiSomenteEmEntidade: 0,   // texto sem ✅/🟢 mas com entidade de emoji custom
    descartadosSemOdd: 0,        // msgs ignoradas por não serem sinal de futebol virtual
    reconexoes: 0,               // quantas vezes reconectou
    sinaisForaDeGrupo: 0,        // sinais achados em chat NÃO monitorado (dica de ID/título)
    channelChecks: 0,            // msgs "CHANNEL CHECK" detectadas
    sinaisAtribuidosPorCheck: 0, // sinais que ganharam grupo via CHANNEL CHECK
    rawUpdates: 0,               // updates CRUS recebidos (prova que o loop entrega eventos)
};

const chaveMsg = (chatId: string | null, id: number | null) => `${chatId}:${id}`;

const getTitle = async (message: any, chatId: string | null): Promise<string | null> => {
    if (!chatId) return null;
    if (titleCache.has(chatId)) return titleCache.get(chatId)!;
    let title: string | null = null;
    try {
        const chat: any = await message.getChat();
        title = chat?.title ?? [chat?.firstName, chat?.lastName].filter(Boolean).join(" ") ?? chat?.username ?? null;
    } catch { /* segue sem título */ }
    if (title) titleCache.set(chatId, title);
    return title;
};

const resumirEntidades = (entities: any[]): EventoColetado["entidades"] => {
    if (!Array.isArray(entities)) return [];
    return entities.map((e: any) => ({
        tipo: e?.className ?? e?.constructor?.name ?? "desconhecido",
        offset: e?.offset,
        length: e?.length,
        documentId: e?.documentId ? String(e.documentId) : undefined,
    }));
};

// Casa uma msg de resultado "solta" (sem reply) com o sinal mais recente do MESMO
// chat que bata em Liga + hora. Retorna a chave do sinal, ou null.
const acharSinalNoHistorico = (chatId: string | null, textoResultado: string): string | null => {
    const { liga, hora } = extrairReferencia(textoResultado);
    const prefixo = `${chatId}:`;
    let alvo: string | null = null;
    let maisRecente = "";
    for (const [chave, s] of sinaisVistos.entries()) {
        if (!chave.startsWith(prefixo)) continue;
        const okLiga = !liga || !s.liga || s.liga === liga;
        const okHora = !hora || !s.hora || String(s.hora) === String(hora);
        if (okLiga && okHora && s.capturadoEm > maisRecente) {
            maisRecente = s.capturadoEm;
            alvo = chave;
        }
    }
    return alvo;
};

// ─── PROCESSAMENTO DE UM EVENTO ─────────────────────────────────────────────────

const processar = async (tipo: "new" | "edit", message: any) => {
    const chatId = message.chatId?.toString() ?? null;
    // rawText vem SEM markdown (evita "**" cortando números como "4**9**").
    const text: string = message.rawText ?? message.text ?? message.message ?? "";
    const messageId = message.id != null ? Number(message.id) : null;

    // 🧱 Dedupe do POLLING + captura CRUA imediata (antes de qualquer filtro).
    const chaveDedup = chaveMsg(chatId, messageId);
    const versaoVista = ultimaVersao.get(chaveDedup);
    if (tipo === "new" && versaoVista === text) return; // já processada com mesmo texto
    ultimaVersao.set(chaveDedup, text);
    appendRaw({ t: nowISO(), tipo, grupo: grupoDoChat(chatId) ?? null, chatId, messageId, text });

    // Título + forward + via-bot: os sinais chegam num chat "hub" que reposta canais.
    const chatTitle = await getTitle(message, chatId);
    const fwd = infoForward(message);
    const viaBotId = (message as any).viaBotId?.toString?.() ?? null;

    const sinal = isSignal(text);
    // Critério do usuário: armazenar msgs que MENCIONEM a Liga + os minutos (odd de futebol virtual).
    const ehSinalVirtual = temLigaEMinutos(text);
    const resultado = isResultado(text, tipo === "edit");
    const greenRegex = RE_GREEN.test(text);
    const redRegex = RE_RED.test(text);
    const odd = extrairOdd(text);

    // "CHANNEL CHECK": mensagem que cita o CÓDIGO do canal (-100…). É assim que se
    // descobre de qual canal veio o sinal quando ele chega repostado.
    const codMatch = text.match(/(-100\d{6,})/);
    const codigoCanal = codMatch ? codMatch[1] : null;
    const isChannelCheck = /CHANNEL\s*CHECK|📢\s*Channel|🆔/i.test(text) && !!codigoCanal;

    // Resolve o grupo por TODAS as vias possíveis, incluindo o código citado.
    const grupo = resolverGrupo(chatId, chatTitle)
        ?? grupoDoChat(fwd?.fromId)
        ?? grupoPorTitulo(fwd?.fromName)
        ?? grupoDoChat(codigoCanal)
        ?? null;

    // Uma msg é "relevante" se: é sinal (Liga+minutos), resultado, CHANNEL CHECK, edição ou reply.
    const relevante = ehSinalVirtual || !!resultado || isChannelCheck || tipo === "edit" || !!(message.replyTo as any)?.replyToMsgId;

    if (isChannelCheck) contadores.channelChecks++;

    // ── FILTRO DE ARMAZENAMENTO ───────────────────────────────────────────────
    // SNIFF_ALL=true  → grava TUDO de TODO chat (descoberta: acha de onde vêm os sinais).
    // SNIFF_ALL=false → grava todo post de canal monitorado + sinais/results/checks de fora.
    const armazenar = SNIFF_ALL || !!grupo || relevante;
    if (!armazenar) { contadores.descartadosSemOdd++; return; }
    if (!grupo && ehSinalVirtual) contadores.sinaisForaDeGrupo++;

    // ── DIAGNÓSTICO: identidade CRUA de tudo que chega de canal monitorado/sinal/check ──
    if (grupo || ehSinalVirtual || isChannelCheck) {
        log(`🧭 [${grupo ?? "??"}] chat=${chatId} fwd=${fwd ? `${fwd.fromName ?? ""}#${fwd.fromId}` : "-"} ` +
            `cod=${codigoCanal ?? "-"} sinal=${ehSinalVirtual} check=${isChannelCheck} ` +
            `text=${JSON.stringify((text || "(vazio/mídia)").replace(/\n/g, " ⏎ ").slice(0, 100))}`);
    }

    const replyToMsgId = Number((message.replyTo as any)?.replyToMsgId) || null;
    const entidades = resumirEntidades(message.entities ?? []);
    const chave = chaveMsg(chatId, messageId);

    const anterior = tipo === "edit" ? (historico.get(chave)?.text ?? null) : null;

    // Reply aponta para algo que já vimos? E é um sinal?
    const replyChave = chaveMsg(chatId, replyToMsgId);
    const msgRespondida = replyToMsgId ? historico.get(replyChave) : undefined;
    const replyApontaParaMsgVista = !!msgRespondida;
    const replyApontaParaSinalAtivo = !!msgRespondida?.isSignal;

    const evento: EventoColetado = {
        seq: ++seq,
        tipo,
        capturadoEm: nowISO(),
        chatId,
        chatTitle,
        grupoConhecido: grupo,
        messageId,
        senderId: message.senderId?.toString() ?? null,
        date: message.date != null ? Number(message.date) : null,
        editDate: (message as any).editDate != null ? Number((message as any).editDate) : null,
        text,
        textLen: text.length,
        textoAnterior: anterior,
        isReply: !!replyToMsgId,
        replyToMsgId,
        replyApontaParaMsgVista,
        replyApontaParaSinalAtivo,
        forward: fwd,
        viaBotId,
        codigoCanal,
        isChannelCheck,
        temEntidades: entidades.length > 0,
        entidades,
        temMedia: !!message.media,
        odd,
        classificacao: {
            isSignal: sinal,
            isResultado: resultado,
            greenRegex,
            redRegex,
            parsed: sinal ? parseMensagem(text) : null,
        },
    };

    eventos.push(evento);
    const idxAtual = eventos.length - 1;

    // ── Atribuição por CHANNEL CHECK ──────────────────────────────────────────
    // O sinal chega sem saber o canal; a msg "CHANNEL CHECK" logo depois traz o
    // código (-100…). Aqui casamos o código com o sinal anterior sem grupo.
    if (ehSinalVirtual) {
        ultimoSinalIdxSemGrupo = grupo ? -1 : idxAtual;
    } else if (isChannelCheck && codigoCanal) {
        const gCheck = grupoDoChat(codigoCanal);
        log(`🔎 CHANNEL CHECK: código ${codigoCanal} → grupo ${gCheck ?? "(não configurado)"}`);
        if (gCheck && ultimoSinalIdxSemGrupo >= 0 && !eventos[ultimoSinalIdxSemGrupo]?.grupoConhecido) {
            eventos[ultimoSinalIdxSemGrupo].grupoConhecido = gCheck;
            const chaveSinal = chaveMsg(eventos[ultimoSinalIdxSemGrupo].chatId, eventos[ultimoSinalIdxSemGrupo].messageId);
            const s = sinaisVistos.get(chaveSinal);
            if (s) s.grupo = gCheck;
            contadores.sinaisAtribuidosPorCheck++;
            contadores.sinaisForaDeGrupo = Math.max(0, contadores.sinaisForaDeGrupo - 1);
            log(`🔗 Sinal #${eventos[ultimoSinalIdxSemGrupo].seq} atribuído ao canal ${gCheck} via CHANNEL CHECK.`);
            ultimoSinalIdxSemGrupo = -1;
        }
    }

    // Atualiza histórico (para diffs e resolução de reply futuros).
    if (messageId != null) historico.set(chave, { text, isSignal: ehSinalVirtual });

    // ── Registra o SINAL para a estimativa ────────────────────────────────────
    if (ehSinalVirtual && tipo === "new" && messageId != null) {
        const p = parseMensagem(text);
        sinaisVistos.set(chave, { grupo, liga: p.liga, hora: p.hora, odd, capturadoEm: evento.capturadoEm });
    }

    // ── Casa GREEN/RED a um sinal ─────────────────────────────────────────────
    // No BRUXÃO o sinal vira green sendo EDITADO com vários ✅ (ex.: "⏰ 52 ✅ …✅✅✅✅").
    // 1-2 ✅ podem ser template (ROBÔ OVER); então "green forte" = 3+ marcas verdes.
    const nMarcasVerdes = (text.match(/✅|✔️|🟢/g) ?? []).length;
    const sinalJaGreen = ehSinalVirtual && nMarcasVerdes >= 3;   // sinal em estado "greened"
    const sinalJaRed = ehSinalVirtual && /❌|🚫|🔴/.test(text);  // sinal marcado RED no próprio texto (ELITE: "TEMPO 55❌")
    if (greenRegex || redRegex) {
        let sinalAlvo: string | null = null;
        if ((sinalJaGreen || sinalJaRed) && sinaisVistos.has(chave)) {
            sinalAlvo = chave;                                   // o próprio sinal já traz o resultado (✅/❌)
        } else if (tipo === "edit" && sinaisVistos.has(chave)) {
            sinalAlvo = chave;                                   // sinal editado (recebeu ✅)
        } else if (replyToMsgId && sinaisVistos.has(replyChave)) {
            sinalAlvo = replyChave;                              // respondeu o sinal
        } else if (!ehSinalVirtual) {
            sinalAlvo = acharSinalNoHistorico(chatId, text);     // msg de confirmação separada
        }
        if (sinalAlvo) {
            if (greenRegex) { greensPorSinal.add(sinalAlvo); redsPorSinal.delete(sinalAlvo); }
            else if (redRegex && !greensPorSinal.has(sinalAlvo)) { redsPorSinal.add(sinalAlvo); }
        }
    }

    // ─── Contadores / observer ──────────────────────────────────────────────
    if (tipo === "new") contadores.novas++; else contadores.edicoes++;
    if (evento.isReply) contadores.replies++;
    if (sinal) contadores.sinais++;
    if (resultado) contadores.resultados++;
    if (greenRegex) contadores.greenDetectados++;
    if (redRegex) contadores.redDetectados++;
    // Emoji só em entidade (texto não tem green/red mas há entidade de emoji custom)?
    const temEmojiEntidade = entidades.some(e => /CustomEmoji|Emoji/i.test(e.tipo));
    if (temEmojiEntidade && !greenRegex && !redRegex) contadores.emojiSomenteEmEntidade++;

    // ─── LOG em tempo real (foco em EDIÇÃO e REPLY) ───────────────────────────
    const tag = grupo ? `⭐${grupo}` : `#${chatId}`;
    const preview = text.replace(/\n/g, " ⏎ ").slice(0, 120);

    if (tipo === "edit") {
        const eraSinal = anterior ? isSignal(anterior) : false;
        if (eraSinal) contadores.edicoesEmSinalConhecido++;
        if (eraSinal && (greenRegex || redRegex)) contadores.edicoesQueViraramResultado++;
        log(`\n✏️  [EDIT] ${tag} msg#${messageId}`);
        log(`    antes : ${anterior !== null ? JSON.stringify(anterior.slice(0, 120)) : "(não tínhamos essa msg no histórico!)"}`);
        log(`    depois: ${JSON.stringify(preview)}`);
        log(`    era sinal? ${eraSinal} | GREEN regex: ${greenRegex} | RED regex: ${redRegex}`);
        if (anterior === null) warn(`    ⚠️  Edição de msg que NÃO capturamos antes — rode o coletor ANTES do sinal chegar.`);
    } else if (evento.isReply) {
        log(`\n↩️  [REPLY] ${tag} msg#${messageId} → responde msg#${replyToMsgId}`);
        log(`    texto: ${JSON.stringify(preview)}`);
        log(`    respondido está no histórico? ${replyApontaParaMsgVista} | é sinal? ${replyApontaParaSinalAtivo}`);
        log(`    GREEN regex: ${greenRegex} | RED regex: ${redRegex}`);
    } else {
        const rot = sinal ? "🎯 SINAL" : resultado ? "🏁 RESULTADO" : "💬 outro";
        const oddTxt = odd != null ? ` | odd ${odd}` : "";
        log(`📥 [NEW ${rot}] ${tag} msg#${messageId}${oddTxt}: ${JSON.stringify(preview)}`);
    }
    if (temEmojiEntidade && !greenRegex && !redRegex) {
        warn(`    🔎 Emoji veio como ENTIDADE (custom emoji), não no texto → regex nunca vai pegar. Ver entidades no JSON.`);
    }
};

// ─── ESTIMATIVA DE ACERTO (baseada nos GREEN detectados) ──────────────────────

const pct = (n: number, d: number): number | null => d > 0 ? +((n / d) * 100).toFixed(1) : null;

const calcularEstimativa = (): any => {
    const total = sinaisVistos.size;
    const greens = greensPorSinal.size;
    const reds = redsPorSinal.size;
    const semResultado = Math.max(0, total - greens - reds);

    // Por grupo
    const porGrupo: Record<string, { sinais: number; greens: number; reds: number; semResultado: number; greenPct: number | null }> = {};
    for (const [chave, s] of sinaisVistos.entries()) {
        const g = s.grupo ?? "?";
        porGrupo[g] ??= { sinais: 0, greens: 0, reds: 0, semResultado: 0, greenPct: null };
        porGrupo[g].sinais++;
        if (greensPorSinal.has(chave)) porGrupo[g].greens++;
        else if (redsPorSinal.has(chave)) porGrupo[g].reds++;
        else porGrupo[g].semResultado++;
    }
    for (const g of Object.keys(porGrupo)) {
        const decididos = porGrupo[g].greens + porGrupo[g].reds;
        porGrupo[g].greenPct = pct(porGrupo[g].greens, decididos);
    }

    return {
        sinais: total,
        greens,
        reds,
        semResultadoDetectado: semResultado,
        // taxa sobre os sinais JÁ decididos (green+red); ignora os ainda sem confirmação
        greenPctSobreDecididos: pct(greens, greens + reds),
        // taxa sobre TODOS os sinais (trata "sem resultado" como não-green)
        greenPctSobreTotal: pct(greens, total),
        porGrupo,
        observacao: "Estimativa baseada nos GREEN/RED detectados por edição/reply/conteúdo. 'semResultado' = sinal sem confirmação capturada (rode o coletor cobrindo o ciclo completo).",
    };
};

// ─── RELATÓRIO JSON ──────────────────────────────────────────────────────────

const gerarRelatorio = (): any => {
    // Resumo por chat
    const porChat: Record<string, any> = {};
    for (const ev of eventos) {
        const k = ev.chatId ?? "null";
        porChat[k] ??= {
            chatTitle: ev.chatTitle, grupoConhecido: ev.grupoConhecido,
            new: 0, edit: 0, delete: 0, sinais: 0, resultados: 0, replies: 0,
        };
        porChat[k][ev.tipo]++;
        if (ev.classificacao.isSignal) porChat[k].sinais++;
        if (ev.classificacao.isResultado) porChat[k].resultados++;
        if (ev.isReply) porChat[k].replies++;
        if (ev.chatTitle && !porChat[k].chatTitle) porChat[k].chatTitle = ev.chatTitle;
    }
    return {
        iniciadoEm: inicio,
        geradoEm: nowISO(),
        config: { SNIFF_ALL, ONLY_SIGNALS, gruposConfigurados: SIGNAL_GROUPS },
        totalEventos: eventos.length,
        contadores,
        tiposUpdate,
        estimativa: calcularEstimativa(),
        porChat,
        eventos,
    };
};

const flush = () => {
    try {
        ensureOut();
        // Rede de segurança: NÃO sobrescreve um relatório bom (com eventos) por um vazio.
        // Evita que uma execução concorrente/falha (0 eventos) apague os dados coletados.
        if (eventos.length === 0 && fs.existsSync(REPORT_PATH)) return;
        fs.writeFileSync(REPORT_PATH, JSON.stringify(gerarRelatorio(), null, 2));
    } catch (e: any) {
        warn("❌ Falha ao gravar relatório:", e?.message || e);
    }
};

const imprimirResumo = () => {
    let rawLinhas = 0;
    try { rawLinhas = fs.readFileSync(RAW_PATH, "utf-8").split("\n").filter(Boolean).length; } catch {}
    log("\n══════════════ RESUMO DA COLETA ══════════════");
    log(`📄 raw.jsonl (durável, append-only): ${rawLinhas} linhas → ${RAW_PATH}`);
    log(JSON.stringify(contadores, null, 2));
    log(`\n📄 Relatório completo: ${REPORT_PATH}`);
    log("──────────────────────────────────────────────");
    log("Diagnóstico rápido:");
    if (contadores.edicoes === 0) log("  ⚠️  NENHUMA edição recebida — o grupo talvez confirme GREEN por reply/msg nova, não por edição.");
    if (contadores.replies === 0) log("  ⚠️  NENHUM reply recebido — confirmação provavelmente é edição ou msg solta.");
    if (contadores.emojiSomenteEmEntidade > 0) log(`  🔎 ${contadores.emojiSomenteEmEntidade} msg(s) com emoji só em ENTIDADE — regex de texto não pega; precisa ler entities.`);
    if (contadores.edicoesEmSinalConhecido > 0) log(`  ✅ ${contadores.edicoesEmSinalConhecido} edição(ões) em msgs que eram sinal (${contadores.edicoesQueViraramResultado} viraram GREEN/RED).`);
    if (contadores.channelChecks > 0) log(`  🔎 ${contadores.channelChecks} msg(s) CHANNEL CHECK detectadas; ${contadores.sinaisAtribuidosPorCheck} sinal(is) atribuído(s) ao canal pelo código.`);
    if (contadores.sinaisForaDeGrupo > 0) log(`  📌 ${contadores.sinaisForaDeGrupo} sinal(is) ainda SEM grupo — veja os logs "🧭 [id]" p/ achar chatId/fwd/código e configurar em SIGNAL_GROUPS.`);
    log(`  📶 updates crus recebidos: ${contadores.rawUpdates}. Tipos: ${JSON.stringify(tiposUpdate)}`);
    if (!Object.keys(tiposUpdate).some(t => /NewMessage|NewChannelMessage/i.test(t)))
        log("  ⛔ NENHUM update de MENSAGEM chegou (só status/leitura) → os canais não postaram OU os sinais vêm por outro chat/bot que não está sendo escutado.");
    if (contadores.novas === 0 && contadores.edicoes === 0) log("  ⚠️  ZERO mensagens novas — rode por mais tempo cobrindo atividade, ou a sessão não está nos chats certos.");
    else if (contadores.sinais === 0 && contadores.sinaisForaDeGrupo === 0) log("  ⚠️  Mensagens chegaram mas NENHUM sinal — formato diferente do parser (veja o JSON).");
    if (contadores.reconexoes > 0) log(`  🔌 ${contadores.reconexoes} reconexão(ões) durante a coleta.`);
    log(`  🗑️  ${contadores.descartadosSemOdd} msg(s) descartadas (ruído sem odd/sinal, ONLY_SIGNALS=${ONLY_SIGNALS}).`);

    // ── Estimativa de acerto ────────────────────────────────────────────────
    const est = calcularEstimativa();
    log("\n──────────── 🟢 ESTIMATIVA DE GREEN ────────────");
    log(`  Sinais: ${est.sinais} | 🟢 green: ${est.greens} | 🔴 red: ${est.reds} | ⏳ sem resultado: ${est.semResultadoDetectado}`);
    log(`  Taxa de green (só decididos): ${est.greenPctSobreDecididos ?? "—"}%`);
    log(`  Taxa de green (sobre total):  ${est.greenPctSobreTotal ?? "—"}%`);
    for (const [g, v] of Object.entries(est.porGrupo)) {
        const vv = v as any;
        log(`   • ${g}: ${vv.sinais} sinais, ${vv.greens}🟢/${vv.reds}🔴 → ${vv.greenPct ?? "—"}% green`);
    }
    log("══════════════════════════════════════════════\n");
};

let inicio = "";

// ─── MAIN ────────────────────────────────────────────────────────────────────

const run = async () => {
    inicio = nowISO();
    ensureOut();
    log("🕵️  COLETOR / OBSERVER — somente escuta (não aposta).");
    log(`   Modo: ${SNIFF_ALL ? "TODOS os chats (descoberta)" : "apenas grupos monitorados (por ID ou título)"}`);
    log(`   Armazenar só sinais de futebol virtual + confirmações? ${ONLY_SIGNALS}`);
    log(`   Grupos configurados:`, SIGNAL_GROUPS);
    log(`   Relatório: ${REPORT_PATH} (flush a cada ${FLUSH_MS}ms)`);
    if (DURATION_MS > 0) log(`   Duração: ${Math.round(DURATION_MS / 1000)}s`);
    log("   Pressione Ctrl+C para encerrar e gerar o relatório final.\n");

    // Não deixa uma rejeição solta (ex.: TIMEOUT do gramjs) derrubar o coletor.
    process.on("unhandledRejection", (r: any) => warn("🚨 unhandledRejection:", r?.message || r));
    process.on("uncaughtException", (e: any) => warn("🚨 uncaughtException:", e?.message || e));

    const session = new StringSession(process.env.SESSION ?? "");
    const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: Infinity,   // não desiste de reconectar
        retryDelay: 3000,
        autoReconnect: true,
        requestRetries: 5,
        timeout: 30,                   // timeout de request (s) — evita travar em request pendente
        floodSleepThreshold: 120,      // dorme automático em FLOOD_WAIT até 120s
    });
    // Silencia o SPAM de logs internos do gramjs (INFO/WARN de TIMEOUT/reconexão).
    try { client.setLogLevel(LogLevel.ERROR); } catch {}

    await client.start({
        phoneNumber: async () => process.env.TELEGRAM_MYPHONE as string,
        password: async () => await askQuestion("Senha 2FA (se tiver, senão Enter): "),
        phoneCode: async () => await askQuestion("Código recebido no Telegram: "),
        onError: (err: Error) => warn(err),
    });

    if (!process.env.SESSION) {
        log("⚠️  Copie essa SESSION para o .env:");
        log(client.session.save() as unknown as string);
    }
    log("📡 Conectado:", client.connected);

    // 🔑 PRIME: sem carregar os diálogos, o gramjs NÃO entrega updates de vários
    // chats (bug comum: "conecta mas não chega nenhuma mensagem"). Isso resolve.
    const entidadePorGrupo = new Map<string, any>();
    try {
        const dialogs: any = await comTimeout(client.getDialogs({ limit: 200 }), 30000, "getDialogs");
        log(`📇 ${dialogs?.length ?? 0} diálogos carregados (loop de updates primado).`);
        for (const d of dialogs ?? []) {
            const ent = d?.entity ?? d;
            const id = d?.id?.toString?.() ?? ent?.id?.toString?.();
            const titulo = d?.title ?? d?.name ?? ent?.title ?? "";
            const g = grupoDoChat(id) ?? grupoPorTitulo(titulo);
            if (g && !entidadePorGrupo.has(g)) {
                entidadePorGrupo.set(g, ent);
                log(`   ✅ diálogo monitorado: ${g} → id=${id} título="${titulo}"`);
            }
        }
    } catch (e: any) {
        warn("⚠️ getDialogs falhou (updates podem não chegar):", e?.message || e);
    }
    try { await client.getMe(); } catch {}

    // 📜 POLLING DE HISTÓRICO — a via CONFIÁVEL. Canais grandes mandam
    // `UpdateChannelTooLong` em vez de NewChannelMessage, então o stream ao vivo NÃO
    // dispara evento de mensagem. Buscar por getMessages periodicamente resolve.
    const resolverAlvo = async (nome: string, id: string): Promise<any> => {
        let alvo: any = entidadePorGrupo.get(nome) ?? null;
        if (!alvo) alvo = await comTimeout(client.getEntity(id), 15000, `getEntity(${nome})`);
        if (!alvo) alvo = await comTimeout(client.getEntity(Number(id) as any), 15000, `getEntity#(${nome})`);
        if (alvo && !entidadePorGrupo.has(nome)) entidadePorGrupo.set(nome, alvo);
        return alvo ?? id; // último recurso: id cru
    };

    const coletarHistorico = async (rotulo: string) => {
        let totalLidas = 0, antes = eventos.length;
        for (const [nome, id] of Object.entries(SIGNAL_GROUPS)) {
            try {
                const alvo = await resolverAlvo(nome, id);
                const msgs: any[] = await comTimeout(client.getMessages(alvo, { limit: HISTORY }), 20000, `getMessages(${nome})`) ?? [];
                totalLidas += msgs.length;
                // processa do mais antigo → mais novo; o dedupe ignora o que já vimos.
                for (const m of [...msgs].reverse()) {
                    try { await processar("new", m); } catch (e: any) { warn(`   erro ${nome}:`, e?.message || e); }
                }
                log(`   📥 ${nome}: ${msgs.length} lidas`);
            } catch (e: any) {
                warn(`   ❌ getMessages(${nome} ${id}) FALHOU:`, e?.message?.split("\n")[0] || e);
            }
        }
        flush();
        log(`✅ [${rotulo}] ${totalLidas} lidas, +${eventos.length - antes} novas → ${eventos.length} eventos totais.`);
        if (eventos.length === 0) {
            warn("⛔ NADA coletado. Causas: conta não está nos canais / SESSION inválida / IDs errados.");
            warn(`   (raw bruto em ${RAW_PATH} — confira se tem linhas)`);
        }
    };

    let polling = false;
    const pollTimer = setInterval(async () => {
        if (polling) return; polling = true;
        try { await coletarHistorico(`poll ${nowISO()}`); } catch (e: any) { warn("poll erro:", e?.message || e); }
        finally { polling = false; }
    }, POLL_MS);

    if (HISTORY > 0) {
        log(`\n📜 Coleta inicial + polling a cada ${Math.round(POLL_MS / 1000)}s...`);
        await coletarHistorico("inicial");
        log("");
    }

    // Handler CRU: conta e CLASSIFICA todo update — revela se mensagens de canal/bot
    // estão chegando (UpdateNewChannelMessage/UpdateNewMessage) ou só status/leitura.
    client.addEventHandler((update: any) => {
        contadores.rawUpdates++;
        const t = update?.className ?? update?.constructor?.name ?? "unknown";
        tiposUpdate[t] = (tiposUpdate[t] ?? 0) + 1;
        // Loga msgs de verdade (ignora spam de status/typing).
        if (/NewMessage|NewChannelMessage|EditMessage|EditChannelMessage/i.test(t)) {
            const m = update?.message;
            const cid = m?.peerId ? JSON.stringify(m.peerId) : (m?.chatId ?? "?");
            log(`📡 ${t} | peer=${cid} | text=${JSON.stringify(String(m?.message ?? "").slice(0, 80))}`);
        }
    });

    client.addEventHandler(async (event: NewMessageEvent) => {
        try { await processar("new", event.message); } catch (e: any) { warn("erro new:", e?.message || e); }
    }, new NewMessage({}));

    client.addEventHandler(async (event: EditedMessageEvent) => {
        try { await processar("edit", event.message); } catch (e: any) { warn("erro edit:", e?.message || e); }
    }, new EditedMessage({}));

    // Deleções (opcional — só conta, não processa texto)
    client.addEventHandler(async (_event: DeletedMessageEvent) => {
        contadores.delecoes++;
    }, new DeletedMessage({}));

    // Flush periódico
    const flushTimer = setInterval(flush, FLUSH_MS);

    // ── Heartbeat: mostra a cada 30s que está vivo e o que chegou ─────────────
    const heartbeatTimer = setInterval(() => {
        const porGrupo: Record<string, number> = {};
        for (const e of eventos) if (e.grupoConhecido) porGrupo[e.grupoConhecido] = (porGrupo[e.grupoConhecido] ?? 0) + 1;
        log(`💓 vivo | updates=${contadores.rawUpdates} tipos=${JSON.stringify(tiposUpdate)} ` +
            `msgsArmazenadas=${eventos.length} sinais=${contadores.sinais} porGrupo=${JSON.stringify(porGrupo)}`);
    }, 30000);

    // ── Watchdog de reconexão ────────────────────────────────────────────────
    // Checa a conexão periodicamente; se caiu, tenta reconectar (o autoReconnect
    // do gramjs às vezes não volta sozinho após um TIMEOUT longo).
    let reconectando = false;
    const reconnectTimer = setInterval(async () => {
        if (reconectando) return;
        try {
            // Só age em desconexão EXPLÍCITA (=== false). Se for undefined, o gramjs
            // está no meio de (re)conectar — não brigamos com o autoReconnect.
            if (client.connected === false) {
                reconectando = true;
                warn("🔌 Conexão caiu — tentando reconectar...");
                await client.connect();
                if (client.connected) { contadores.reconexoes++; log("✅ Reconectado."); }
            }
        } catch (e: any) {
            warn("❌ Falha ao reconectar:", e?.message || e);
        } finally {
            reconectando = false;
        }
    }, 30000);

    // Encerramento limpo
    const encerrar = async (motivo: string) => {
        log(`\n🛑 Encerrando (${motivo})...`);
        clearInterval(flushTimer);
        clearInterval(reconnectTimer);
        clearInterval(heartbeatTimer);
        clearInterval(pollTimer);
        flush();
        // Snapshot com timestamp p/ não perder a coleta ao rodar de novo.
        if (eventos.length > 0) {
            try {
                const snap = path.join(OUT_DIR, `coletor-relatorio-${nowISO().replace(/[:.]/g, "-")}.json`);
                fs.writeFileSync(snap, JSON.stringify(gerarRelatorio(), null, 2));
                log(`💾 Snapshot salvo: ${snap}`);
            } catch { /* ignora */ }
        }
        imprimirResumo();
        try { await client.disconnect(); } catch {}
        process.exit(0);
    };
    process.on("SIGINT", () => { encerrar("Ctrl+C"); });
    process.on("SIGTERM", () => { encerrar("SIGTERM"); });

    if (DURATION_MS > 0) setTimeout(() => encerrar("tempo esgotado"), DURATION_MS);

    await new Promise(() => {}); // mantém vivo
};

run().catch(e => { warn("💥 Erro fatal:", e?.message || e); flush(); process.exit(1); });
