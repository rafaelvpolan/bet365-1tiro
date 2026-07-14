require('dotenv').config()
const { chromium } = require('playwright');
import options from './pw.config'
import bet365Spec from './spec/bet365.spec';
import Bet365Repository from './api/bet365/repositories/index.repository'
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { EditedMessage, EditedMessageEvent } from "telegram/events/EditedMessage";
import * as readline from "readline";

const apiId: number = Number(process.env.TELEGRAM_API_ID);
const apiHash: string = String(process.env.TELEGRAM_API_HASH);
console.log(apiId, typeof apiId);

import { IBets } from './api/bet365/models/bets.model';
import {
    propsBet, parseMensagem, isSignal,
    isResultado, RE_GREEN, RE_RED, extrairReferencia, extrairMinutosMencionados,
} from './signals/parser';
import { resolverGrupoDaMensagem } from './signals/telegram';
import { SIGNAL_GROUPS } from './signals/groups';

// 📝 Tee dos logs para arquivo (bot.log) — permite acompanhar/depurar a execução.
//    Sobrescreve console.* ANTES de desestruturar log/warn abaixo.
const _fsLog = require('fs');
const LOG_FILE = process.env.LOG_FILE || 'bot.log';
try { _fsLog.writeFileSync(LOG_FILE, `===== início ${new Date().toISOString()} =====\n`); } catch {}
const _teeFile = (nivel: string, args: any[]) => {
    try {
        const linha = args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
        _fsLog.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${nivel} ${linha}\n`);
    } catch {}
};
(['log', 'warn', 'error', 'info'] as const).forEach((m) => {
    const orig = (console as any)[m].bind(console);
    (console as any)[m] = (...a: any[]) => { orig(...a); _teeFile(m.toUpperCase(), a); };
});

const { log, info, warn, error } = console
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let browser: any = null
let context: any = null
let page: any = null
let lastTime: any = null
let errTimeout: number = 0
var initBetStatus: boolean = false;
let MONEY: string;
let browserHealthy = false;   // navegador vivo e navegável?
let restarting = false;       // reinício em andamento (evita reinícios paralelos)

// ─── CONFIG ESTRATÉGIA AUTÔNOMA ("Sequência Controlada") ───────────────────────
// Liga por variáveis de ambiente. Tudo tem default seguro.
const AUTO_MODE   = String(process.env.AUTO_MODE ?? 'false') === 'true';   // liga o modo autônomo (senão usa Telegram)
const AUTO_DRY_RUN = String(process.env.AUTO_DRY_RUN ?? 'true') === 'true'; // true = NÃO aposta dinheiro real, só simula/loga
// 🛡️ Trava GLOBAL de segurança: por padrão NUNCA confirma aposta real (vale p/ Telegram também).
// Só aposta de verdade com DRY_RUN=false explícito no .env.
const DRY_RUN = String(process.env.DRY_RUN ?? 'true') === 'true';
// Intervalo de POLLING dos canais (eventos ao vivo não entregam msgs de canal grande).
const POLL_MS = Number(process.env.TELEGRAM_POLL_MS ?? 20000);
// 🎯 MARTINGALE: só tiro 1 e tiro 2. tiro1 = BASE; tiro2 = 2×BASE (dobra se não deu green).
const MAX_TIROS = Number(process.env.MAX_TIROS ?? 2);
// Valor base do tiro 1 (mínimo da bet365 = R$0,50). Tiro 2 = 2×BASE = R$1,00.
const BASE_STAKE = Number(process.env.BASE_STAKE ?? 0.50);
// 🔐 Credenciais bet365 — SEMPRE do .env (nunca hardcoded, senão vazam no git).
const BET365_USER = String(process.env.BET365_USER ?? '');
const BET365_PASS = String(process.env.BET365_PASS ?? '');
const AUTO_LIGA   = String(process.env.AUTO_LIGA ?? 'SUPER').toUpperCase(); // COPA | EURO | SUPER | PREMIER
const AUTO_MAX_GAMES  = Number(process.env.AUTO_MAX_GAMES  ?? 20);   // máx. de jogos por sessão
const AUTO_MAX_TIROS  = Number(process.env.AUTO_MAX_TIROS  ?? 3);    // teto do martingale (reseta ao atingir)
const AUTO_STOP_WIN   = Number(process.env.AUTO_STOP_WIN   ?? 5);    // para se o lucro acumulado >= R$
const AUTO_STOP_LOSS  = Number(process.env.AUTO_STOP_LOSS  ?? 3);    // para se o prejuízo acumulado >= R$
const AUTO_SETTLE_MS  = Number(process.env.AUTO_SETTLE_MS  ?? 90000);// tempo de espera até o jogo liquidar (ms)
const AUTO_BASE       = Number(process.env.AUTO_BASE       ?? 0.10); // stake base do tiro 1


// ─── TIPOS ───────────────────────────────────────────────────────────────────

interface SignalState {
    props: propsBet
    tiroAtual: number   // último tiro executado (0 = nenhum ainda)
    green: boolean
    timestamp: number
}


interface BetQueueItem {
    messageId: number
    tiro: number
    hora: number
    minuto: number
    timestampExecucao: number
}

const betQueue: BetQueueItem[] = [];

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────

const activeSignals = new Map<number, SignalState>();
let BetInProgress = false;

const indiceChamps: any = {
    COPA: 1,
    EURO: 2,
    SUPER: 3,
    PREMIER: 4
}

// Liga do sinal → nome da ABA no "Futebol ao vivo" (clicada por texto).
const ligaTabLive: any = {
    COPA: 'Copa do Mundo',
    EURO: 'Euro Cup',
    SUPER: 'Super Liga Sul-Americana',
    PREMIER: 'Premier League',
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

const dateNow = () => {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    return dd + '/' + mm + '/' + yyyy;
}

const askQuestion = (question: string): Promise<string> => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
};

const getRandomArbitrary = (min: number, max: number) => {
    return Math.random() * (max - min) + min;
}

const removeFromQueue = (messageId: number) => {
    for (let i = betQueue.length - 1; i >= 0; i--) {
        if (betQueue[i].messageId === messageId) {
            betQueue.splice(i, 1);
        }
    }
};

let workerRunning = false;

const startQueueWorker = () => {
    setInterval(async () => {
        if (workerRunning) return;
        workerRunning = true;

        try {
            betQueue.sort((a, b) => a.timestampExecucao - b.timestampExecucao);

            for (let i = 0; i < betQueue.length; i++) {
                const now = Date.now(); // 🔥 corrigido
                const item = betQueue[i];
                if (item.timestampExecucao > now) break;
                // if (BetInProgress) break; // 🔥 corrigido

                const signal = activeSignals.get(item.messageId);
                console.log('COD 1',signal);
                if (!signal) {
                    betQueue.splice(i, 1);
                    i--;
                    continue;
                }
                console.log('COD 2',signal.green);
                if (signal.green) {
                    console.log(`🟢 GREEN → cancelando sinal ${item.messageId}`);
                    removeFromQueue(item.messageId);
                    activeSignals.delete(item.messageId);
                    break;
                }
                console.log('CONDICAO 3', (now - item.timestampExecucao) > 60000,(now - item.timestampExecucao), 60000);
                if ((now - item.timestampExecucao) > 60000) {
                    console.log(`⏰ Ignorando tiro atrasado (${item.tiro})`);
                    betQueue.splice(i, 1);
                    i--;
                    continue;
                }

                console.log(`🔥 EXECUTANDO AGORA tiro ${item.tiro}`);

                await placeBet({
                    ...signal.props,
                    entrada: [`${item.hora}:${String(item.minuto).padStart(2,'0')}`]
                }, item.tiro);

                betQueue.splice(i, 1);
                i--;
            }

        } catch (err) {
            console.log("❌ Erro no worker:", err);
        }

        workerRunning = false;

    }, 1000);
};



// ─── PARSER DE MENSAGEM ───────────────────────────────────────────────────────

// Casa um resultado "solto" (GREEN/RED sem reply) com um sinal ativo. Nestes grupos
// o GREEN é uma msg NOVA citando a liga + a faixa de minutos (ex.: "PREMIER ⏰ 39-42").
// Estratégia: liga obrigatória (se ambos têm), hora se citada, e prioriza o sinal
// cujos minutos batem com os mencionados; empate → o mais recente.
function acharSinalPorConteudo(texto: string): number | null {
    const { liga, hora } = extrairReferencia(texto);
    const mins = extrairMinutosMencionados(texto);
    let melhor: number | null = null;
    let melhorScore = -Infinity;
    for (const [id, s] of activeSignals.entries()) {
        if (s.green) continue;
        if (liga && s.props.liga && s.props.liga !== liga) continue;         // liga não bate
        if (hora && s.props.hora && String(s.props.hora) !== String(hora)) continue; // hora não bate
        const overlap = s.props.minutos.some(m => mins.includes(m)) ? 1 : 0;
        const score = overlap * 1e13 + s.timestamp;                          // overlap manda; depois recência
        if (score > melhorScore) { melhorScore = score; melhor = id; }
    }
    return melhor;
}

// Resolve um sinal. GREEN → cancela os tiros restantes. RED → apenas loga:
// o próximo minuto (gale) da própria mensagem já está agendado e dispara sozinho.
function resolverSinal(messageId: number, green: boolean, origem: string): void {
    const signal = activeSignals.get(messageId);
    if (!signal) return;
    if (green) {
        console.log(`✅ GREEN (${origem}) → cancelando tiros restantes do sinal ${messageId}`);
        signal.green = true;
        activeSignals.set(messageId, signal);
        removeFromQueue(messageId);
        activeSignals.delete(messageId);
    } else {
        console.log(`🔴 RED (${origem}) no sinal ${messageId} → mantém a fila; o próximo minuto (gale) dispara sozinho`);
    }
}

// ─── WATCH TELEGRAM ───────────────────────────────────────────────────────────

const watchTelegram = async () => {
    const sessionString = process.env.SESSION ?? "";
    const session = new StringSession(sessionString);

    const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 10,
        retryDelay: 3000,
        autoReconnect: true,
        requestRetries: 5,
    });

    await client.start({
        phoneNumber: async () => process.env.TELEGRAM_MYPHONE as string,
        password: async () => await askQuestion("Senha 2FA (se tiver, senão Enter): "),
        phoneCode: async () => await askQuestion("Digite o código recebido no Telegram: "),
        onError: (err: Error) => log(err),
    });

    if (!sessionString) {
        const savedSession = client.session.save() as unknown as string;
        log("⚠️  Copie essa SESSION para o .env:");
        log(savedSession);
    }

    log("📡 Status conectado:", client.connected);

    // ── Processa UMA mensagem (usado pelo evento ao vivo E pelo polling) ─────────
    const processarMensagem = async (message: any) => {
        // Resolve o grupo por chatId OU pela origem do encaminhamento (fwdFrom).
        const grupo = await resolverGrupoDaMensagem(message);
        if (!grupo) return; // não é um dos grupos monitorados

        const texto = message.rawText ?? message.text ?? "";

        // 1) É uma confirmação de resultado (GREEN/RED)? → resolve o sinal alvo.
        const resultado = isResultado(texto);
        if (resultado) {
            const replyId = Number((message.replyTo as any)?.replyToMsgId) || 0;
            const alvo = (replyId && activeSignals.has(replyId))
                ? replyId
                : acharSinalPorConteudo(texto);
            if (alvo && activeSignals.has(alvo)) {
                const origem = replyId === alvo ? 'reply' : 'conteúdo';
                if (resultado.green)    resolverSinal(alvo, true,  origem);
                else if (resultado.red) resolverSinal(alvo, false, origem);
            } else {
                log('ℹ️ Resultado sem sinal ativo correspondente — ignorado.');
            }
            return;
        }

        // 2) É um sinal de entrada?
        if (!isSignal(texto)) {
            log('⚠️ Mensagem ignorada: não é sinal nem resultado.');
            return;
        }

        const msg: propsBet = parseMensagem(texto);
        const messageId = Number(message.id);

        // 🎯 MARTINGALE: usa no MÁXIMO os 2 primeiros minutos (tiro 1 e tiro 2).
        const minutosTiros = msg.minutos.slice(0, MAX_TIROS);
        const planoStakes = minutosTiros.map((_, i) => (BASE_STAKE * Math.pow(2, i)).toFixed(2));
        log(`🎯 ENTRADA [${grupo}] msg#${messageId}: liga=${msg.liga}${msg.hora ? ` H:${msg.hora}` : ''} | ` +
            `gale (máx ${MAX_TIROS}): ${minutosTiros.map((m, i) => `T${i + 1}@${m}=R$${planoStakes[i]}`).join(' → ')}` +
            (msg.minutos.length > MAX_TIROS ? ` (ignorando extras: ${JSON.stringify(msg.minutos.slice(MAX_TIROS))})` : ''));

        // ✅ FORA do forEach — registra o sinal UMA VEZ
        activeSignals.set(messageId, {
            props: msg,
            tiroAtual: 0,
            green: false,
            timestamp: Date.now(),
        });


        const minutoBase = minutosTiros[0];

        minutosTiros.forEach((minuto, index) => {
            const tiro = index + 1;

            let deltaMinutos = minuto - minutoBase;

            // 🔁 virada (59 → 00)
            if (deltaMinutos < 0) {
                deltaMinutos += 60;
            }

            let delayMs = deltaMinutos * 60 * 1000;

            // 🔥 tiro 1 imediato (2s de buffer)
            if (index === 0) {
                delayMs = 2000;
            }

            console.log(`🎯 Tiro ${tiro} em ${delayMs}ms`);

            const timestampExecucao = Date.now() + delayMs;

                    console.log('AGORA',Date.now()); 
            console.log('EXECUCAO',timestampExecucao);

            betQueue.push({
                messageId,
                tiro,
                hora: Number(msg.hora),
                minuto,
                timestampExecucao
            });
        });
    };

    // Handler ao vivo (mantido; mas canais grandes NÃO disparam evento de msg → polling abaixo).
    client.addEventHandler((event: NewMessageEvent) => {
        processarMensagem(event.message).catch(e => warn('erro msg ao vivo:', e?.message || e));
    }, new NewMessage({}));

    // 🔑 Prime dos diálogos (carrega entidades p/ getMessages funcionar).
    try { await client.getDialogs({ limit: 200 }); } catch (e: any) { warn('getDialogs:', e?.message || e); }

    // ── POLLING dos canais ───────────────────────────────────────────────────
    // É o que REALMENTE pega as entradas: canais grandes mandam UpdateChannelTooLong,
    // então o evento ao vivo não entrega a mensagem. Buscamos getMessages a cada POLL_MS.
    const vistos = new Set<string>();
    let primeiraVarredura = true;
    const poll = async () => {
        for (const [nome, id] of Object.entries(SIGNAL_GROUPS)) {
            try {
                let alvo: any = id;
                try { alvo = await client.getEntity(id); } catch {}
                const msgs: any[] = await client.getMessages(alvo, { limit: 15 });
                for (const m of [...(msgs ?? [])].reverse()) {
                    const chave = `${id}:${m.id}`;
                    if (vistos.has(chave)) continue;
                    vistos.add(chave);
                    if (primeiraVarredura) continue; // não aposta em histórico velho na largada
                    await processarMensagem(m);
                }
            } catch (e: any) { warn(`poll ${nome}:`, e?.message?.split('\n')[0] || e); }
        }
        if (primeiraVarredura) { log(`👀 Polling ativo (a cada ${Math.round(POLL_MS / 1000)}s). ${vistos.size} msgs marcadas como base.`); }
        primeiraVarredura = false;
    };
    await poll();
    setInterval(() => { poll().catch(e => warn('poll loop:', e?.message || e)); }, POLL_MS);

    // ── Mensagem editada — detecta GREEN ─────────────────────────────────────
    client.addEventHandler(async (event: EditedMessageEvent) => {
        const message = event.message;
        if (!await resolverGrupoDaMensagem(message)) return;

        const text = message.text ?? "";

        // A edição pode ser na própria msg do sinal, numa msg que responde o sinal,
        // ou numa msg de resultado que cita liga/hora.
        const replyId = Number((message.replyTo as any)?.replyToMsgId) || 0;
        const alvo = activeSignals.has(message.id)
            ? message.id
            : (replyId && activeSignals.has(replyId))
                ? replyId
                : acharSinalPorConteudo(text);

        if (!alvo || !activeSignals.has(alvo)) return;

        log(`✏️  [edit] (msg ${message.id} → sinal ${alvo}):`, text);

        // Na própria msg do sinal, isResultado() retorna null (ainda parseia como sinal);
        // por isso testamos GREEN/RED diretamente como fallback.
        const green = RE_GREEN.test(text);
        const red   = RE_RED.test(text);
        if (green)    resolverSinal(alvo, true,  'edição');
        else if (red) resolverSinal(alvo, false, 'edição');

    }, new EditedMessage({}));

    // Limpa sinais antigos a cada 2h para não acumular memória
    setInterval(() => {
        const limite = Date.now() - 2 * 60 * 60 * 1000;
        for (const [id, signal] of activeSignals.entries()) {
            if (signal.timestamp < limite) {
                log(`🧹 Removendo sinal antigo: ${id}`);
                activeSignals.delete(id);
            }
        }
    }, 30 * 60 * 1000);

    // Segura o processo vivo indefinidamente
    await new Promise(() => {});
};

// ─── LOGIN / NAVEGAÇÃO ────────────────────────────────────────────────────────

let loginReady: boolean = false

const init = async () => {
    installGlobalGuards()      // 🛡️ evita que 1 rejeição não tratada derrube o processo
    await initBet()
    browserHealthy = true
    attachBrowserWatchdog()    // 🐶 reinicia sozinho se o navegador crashar

    // 🧪 TESTE DE CLIQUE: dispara uma aposta na hora, sem esperar o Telegram.
    // Ex.:  TEST_SIGNAL="PREMIER 30-33" npm run start:dev
    // Respeita DRY_RUN (monta e NÃO confirma). Serve pra ver o bot clicar na tela.
    if (process.env.TEST_SIGNAL) {
        const raw = process.env.TEST_SIGNAL;
        // Parsing FLEXÍVEL p/ teste: pega a liga e QUALQUER número (não exige ⏰/TEMPO).
        const liga = ['EURO', 'COPA', 'PREMIER', 'SUPER'].find(l => raw.toUpperCase().includes(l)) ?? null;
        const mins = (raw.match(/\d{1,2}/g) ?? []).map(Number).filter(n => n >= 0 && n <= 59).slice(0, MAX_TIROS);
        log(`🧪 TEST_SIGNAL "${raw}" → liga=${liga} minutos=${JSON.stringify(mins)} (DRY_RUN=${DRY_RUN})`);
        if (liga && mins.length) {
            await placeBet({ liga, hora: null, minutos: mins,
                entrada: [String(mins[0]).padStart(2, '0')] }, 1);
        } else {
            warn('🧪 TEST_SIGNAL inválido — use "SUPER 52" ou "PREMIER 30".');
        }
    }

    if (AUTO_MODE) {
        // 🤖 Modo autônomo: o próprio bot escolhe os confrontos em sequência
        await autoSequence()
    } else {
        // 📡 Modo padrão: aguarda sinais do Telegram
        startQueueWorker() // 🔥 AQUI
        await watchTelegram()
    }
}

const initBet = async () => {
    lastTime = new Date()
    errTimeout = 0
    loginReady = await login()
    initBetStatus = await navigate()
    await getMoney()
}

// ─── WATCHDOG DE CRASH DO NAVEGADOR ────────────────────────────────────────────
// Detecta crash/fechamento do Chromium e reinicia sozinho, sem derrubar o bot
// (o Telegram continua escutando — só a camada de aposta é reconstruída).

const browserErrRe = /(Target (?:closed|crashed)|browser(?: has been)? closed|Session closed|Connection closed|Execution context was destroyed|frame (?:was |got )?detached|Protocol error|has been closed|crashed)/i;
const pareceErroDeBrowser = (m: any): boolean => browserErrRe.test(String(m?.message ?? m ?? ''));

const attachBrowserWatchdog = (): void => {
    try {
        page.on('crash', () => { warn('💥 Página (page) crashou'); browserHealthy = false; scheduleRestart('page crash'); });
        page.on('close', () => { warn('⚠️ Página (page) fechou'); browserHealthy = false; });
        context.on('close', () => { warn('⚠️ Context fechou'); browserHealthy = false; scheduleRestart('context close'); });
        const browser = typeof context.browser === 'function' ? context.browser() : null;
        browser?.on?.('disconnected', () => { warn('⚠️ Browser desconectou'); browserHealthy = false; scheduleRestart('browser disconnected'); });
        log('🐶 Watchdog do navegador ativo.');
    } catch (e: any) {
        warn('⚠️ Falha ao anexar watchdog:', e?.message || e);
    }
};

const scheduleRestart = (motivo: string): void => {
    if (restarting) return;               // já tem um reinício em andamento
    restarting = true;
    warn(`🔄 Agendando reinício do navegador (motivo: ${motivo})...`);
    restartBrowser().finally(() => { restarting = false; });
};

const restartBrowser = async (): Promise<void> => {
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
        try {
            warn(`🔁 Reiniciando navegador (tentativa ${tentativa}/5)...`);
            try { await context?.close(); } catch {}   // fecha o contexto morto (evita vazamento)
            page = null;
            context = null;
            await initBet();                            // relança login + navega + lê saldo
            attachBrowserWatchdog();
            browserHealthy = true;
            log('✅ Navegador reiniciado com sucesso.');
            return;
        } catch (e: any) {
            warn(`❌ Falha ao reiniciar (tentativa ${tentativa}/5):`, e?.message?.split('\n')[0] || e);
            await sleep(5000 * tentativa);              // backoff progressivo
        }
    }
    warn('🛑 Não reiniciou após 5 tentativas. Nova tentativa em 30s.');
    setTimeout(() => { restarting = false; scheduleRestart('retry-tardio'); }, 30000);
};

const installGlobalGuards = (): void => {
    process.on('unhandledRejection', (reason: any) => {
        warn('🚨 unhandledRejection:', reason?.message || reason);
        if (pareceErroDeBrowser(reason)) scheduleRestart('unhandledRejection');
    });
    process.on('uncaughtException', (err: any) => {
        warn('🚨 uncaughtException:', err?.message || err);
        if (pareceErroDeBrowser(err)) scheduleRestart('uncaughtException');
    });
    log('🛡️ Guards globais instalados (o processo não cai mais por rejeição não tratada).');
};

const login = async () => {
    const os = require('os');
    const pathMod = require('path');
    // Perfil dedicado → evita o singleton do Chrome do sistema (pw.config aponta pro Chrome instalado).
    const userDataDir = pathMod.join(process.env.TEMP || os.tmpdir(), `bet365-1tiro-${Date.now()}`);
    context = await chromium.launchPersistentContext(userDataDir, {
        ...options,
        geolocation: { latitude: -23.5505, longitude: -46.6333 },
        permissions: ['geolocation'],
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
    });
    // Timeouts FINITOS: se um seletor sumir, falha rápido em vez de travar pra sempre.
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(45000);
    page = context.pages().length ? context.pages()[0] : await context.newPage();
    await page.setViewportSize({ width: 1620, height: 880 });
    try {
        await page.goto(bet365Spec.url, { waitUntil: 'domcontentloaded' });
    } catch (e: any) { console.log('⚠️ goto falhou/timeout:', e?.message?.split('\n')[0] || e); }
    await page.waitForTimeout(4000);

    // aceita cookies se aparecer
    try {
        const c = page.locator('button', { hasText: 'Aceitar todos' });
        if (await c.count() > 0) { await c.click({ timeout: 5000 }); console.log('✅ Cookies aceitos'); }
    } catch {}

    // login best-effort: se o seletor mudou, NÃO trava — segue em modo leitura (dry-run não aposta real).
    try {
        await page.locator(bet365Spec.loginElements.buttonLogin).click({ timeout: 8000 })
        await page.locator(bet365Spec.loginElements.inputLogin).click({ timeout: 8000 });
        await page.keyboard.type(BET365_USER)
        await page.waitForTimeout(800);
        await page.locator(bet365Spec.loginElements.inputPass).click({ timeout: 8000 });
        await page.keyboard.type(BET365_PASS);
        await page.waitForTimeout(1000);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000);
        console.log('🔑 Login enviado');
    } catch (e: any) {
        console.log('⚠️ Login best-effort falhou (segue mesmo assim p/ dry-run):', e?.message?.split('\n')[0] || e);
    }
    return true
}



const navigate = async () => {
    // cada passo é best-effort com timeout curto: se um seletor sumiu, não trava a sessão.
    const tenta = async (label: string, fn: () => Promise<any>) => {
        try { await fn(); console.log(`✅ ${label}`); }
        catch (e: any) { console.log(`⚠️ ${label} falhou:`, e?.message?.split('\n')[0] || e); }
    };

    await tenta('popup saldo', async () => {
        const el = page.locator(bet365Spec.popups.saldo);
        if (await el.count() > 0) await el.click({ timeout: 6000 });
    });
    await page.waitForTimeout(1500)
    await tenta('menu Esportes Virtuais', async () => {
        await page.locator(bet365Spec.locators.menuCategory).click({ timeout: 8000 });
    });
    await page.waitForTimeout(1500)
    await tenta('cookies', async () => {
        const cookieButton = page.locator('button', { hasText: "Aceitar todos" });
        if (await cookieButton.count() > 0) await cookieButton.click({ timeout: 5000 });
    });
    await tenta('página do esporte', async () => {
        await page.locator(bet365Spec.locators.pageItem).click({ timeout: 8000 });
    });
    // 🔄 A página de ligas às vezes não renderiza de primeira — recarrega após 2s.
    await tenta('reload da página de ligas', async () => {
        await page.waitForTimeout(2000);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
    });
    return true
}

const getMoney = async (): Promise<boolean> => {
    try {
        const el = await page.$(bet365Spec.elements.money);
        if (el) {
            MONEY = await el.innerText();
            console.log(MONEY);
            return true;
        }
        console.log('⚠️ Elemento não encontrado, tentando novamente...');
        return false;
    } catch (error) {
        console.log('❌ Erro ao buscar saldo, tentando novamente...', error);
        return false;
    }
};

// ─── PLACE BET ────────────────────────────────────────────────────────────────

const placeBet = async (props: propsBet, tiro: number = 1) => {
    console.log('PLACEBET');
    if (props.entrada.length == 0 || !props.liga) return

    BetInProgress = true

    try {
        // 🛡️ Garante navegador vivo antes de qualquer interação com a página.
        if (!page || (typeof page.isClosed === 'function' && page.isClosed()) || !browserHealthy) {
            warn('⚠️ Navegador indisponível no placeBet → reiniciando antes de apostar.');
            await restartBrowser();
            if (!browserHealthy) { warn('🛑 Aposta abortada: navegador não voltou.'); return; }
        }

        // Martingale: tiro 1 = BASE, tiro 2 = 2×BASE. (só tiro 1 e 2)
        const valorAposta = BASE_STAKE * Math.pow(2, tiro - 1);

        log(`💰 Tiro ${tiro} → R$${valorAposta.toFixed(2)} ${tiro === 1 ? '(base)' : '(dobro — tiro 1 não deu green)'}`);

        if (!await getMoney()) {
            warn('⚠️ Saldo não lido → reiniciando navegador (fecha o contexto antigo, sem vazar).');
            await restartBrowser();
        }

        if (!loginReady || !initBetStatus) return

        // 🔄 Recarrega ANTES de selecionar a liga (a página de ligas às vezes não
        // renderiza e as odds ao vivo precisam estar atualizadas na hora da aposta).
        try {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2500);
        } catch (e: any) { warn('⚠️ reload pré-aposta falhou:', e?.message?.split('\n')[0] || e); }

        // 1) Seleciona a LIGA pela aba (por texto — futebol ao vivo).
        const tab = ligaTabLive[props.liga] ?? props.liga;
        const abaLiga = page.locator(`text=${tab}`);
        if (await abaLiga.count() === 0) {
            console.log(`❌ Aba da liga "${tab}" não encontrada`);
            return;
        }
        await abaLiga.first().click();
        console.log(`✅ Liga: ${tab}`);
        await page.waitForTimeout(3000)

        for (const horario of props.entrada) {
            // O "minuto" do sinal = minuto do horário do jogo na timeline (ex.: 52 → "01:52").
            const mm = String(horario.split(':').pop() ?? '').padStart(2, '0');

            // 2) Clica no jogo cujo horário termina em :mm.
            const botao = page.locator('.vr-EventTimesNavBarButton_Text', { hasText: `:${mm}` });
            if (await botao.count() === 0) {
                console.log(`❌ Jogo :${mm} não encontrado na timeline`);
                continue;
            }
            await botao.first().click();
            console.log(`✅ Jogo :${mm} selecionado`);
            await page.waitForTimeout(2500)

            // 3) Mercado "Para o Time Marcar - Sim/Não" → "Ambos os Times" → coluna SIM.
            const pod = page.locator('.gl-MarketGroupPod', { hasText: 'Para o Time Marcar' });
            if (await pod.count() === 0) {
                console.log('❌ Mercado "Para o Time Marcar" não encontrado');
                continue;
            }
            // Colunas do mercado: [0]=rótulos, [1]=Sim, [2]=Não. "Ambos os Times" é a 1ª linha.
            let simOdd = pod.first().locator('.gl-Market').nth(1).locator('.gl-ParticipantOddsOnly').first();
            if (await simOdd.count() === 0) {
                // grupo pode estar recolhido → abre pelo cabeçalho e tenta de novo.
                try { await pod.first().locator('.gl-MarketGroupButton').first().click(); await page.waitForTimeout(1000); } catch {}
                simOdd = pod.first().locator('.gl-Market').nth(1).locator('.gl-ParticipantOddsOnly').first();
            }
            if (await simOdd.count() === 0) {
                console.log('❌ Odd "Ambos os Times → Sim" não encontrada');
                continue;
            }
            const oddTxt = await simOdd.locator('.gl-ParticipantOddsOnly_Odds').first().innerText().catch(() => '?');
            await simOdd.click();
            console.log(`✅ "Ambos os Times → Sim" (odd ${oddTxt})`);
            await page.waitForTimeout(1500)

            // 4) Valor da aposta.
            await page.locator('.bsf-StakeBox_Wrapper').click()
            await page.keyboard.type(String(valorAposta));
            await page.waitForTimeout(1000)

            // 🧪 DRY-RUN: monta e NÃO confirma (trava global DRY_RUN). Só aposta real com DRY_RUN=false.
            if (DRY_RUN || (AUTO_MODE && AUTO_DRY_RUN)) {
                console.log(`🧪 [DRY-RUN] Montada e NÃO enviada → ${props.liga} :${mm} AMBAS-MARCAM-Sim | tiro ${tiro} | R$${valorAposta.toFixed(2)}`);
                await page.keyboard.press('Escape').catch(() => {});
                await page.waitForTimeout(500)
                continue;
            }

            const btn = page.locator('.bsf-PlaceBetButton');
            if (await btn.count() === 0) {
                console.log(`❌ Botão apostar não encontrado`);
                continue;
            }
            await btn.click();
            await page.waitForTimeout(3000)
            try { await page.locator('.bss-ReceiptContent_Done').click({ timeout: 5000 }); } catch {}
            await page.waitForTimeout(1500)
            console.log(`✅ APOSTA CONFIRMADA → ${props.liga} :${mm} AMBAS-MARCAM-Sim | tiro ${tiro} | R$${valorAposta.toFixed(2)}`);
        }

    } catch (err) {
        console.log("❌ ERRO no placeBet:", err);
    } finally {
        BetInProgress = false
    }
};



// ─── ESTRATÉGIA AUTÔNOMA: "Sequência Controlada" ───────────────────────────────

// Converte "R$ 1.234,56" → 1234.56
const parseSaldo = (s: string): number => {
    if (!s) return NaN;
    const cleaned = s.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
    return parseFloat(cleaned);
};

// Lê os horários dos próximos confrontos disponíveis na tela, em ordem.
const lerHorariosDisponiveis = async (liga: string): Promise<string[]> => {
    try {
        await page.locator(`.vrl-MeetingsHeader_ButtonContainer >> div >> nth=${indiceChamps[liga]}`).click();
        await page.waitForTimeout(2500);
        const horarios: string[] = await page.$$eval(
            '.vr-EventTimesNavBarButton_Text',
            (els: any[]) => els.map(e => (e.innerText || '').trim()).filter(Boolean)
        );
        // remove duplicados preservando a ordem
        return [...new Set(horarios)];
    } catch (err) {
        console.log('❌ Erro ao ler horários:', err);
        return [];
    }
};

const autoSequence = async () => {
    console.log('🤖 ===== MODO AUTÔNOMO "Sequência Controlada" =====');
    console.log(`   Liga: ${AUTO_LIGA} | DRY-RUN: ${AUTO_DRY_RUN} | máx jogos: ${AUTO_MAX_GAMES}`);
    console.log(`   Martingale até tiro ${AUTO_MAX_TIROS} | base R$${AUTO_BASE.toFixed(2)}`);
    console.log(`   Stop-win R$${AUTO_STOP_WIN.toFixed(2)} | Stop-loss R$${AUTO_STOP_LOSS.toFixed(2)}`);
    if (!indiceChamps[AUTO_LIGA]) {
        console.log(`❌ Liga inválida: ${AUTO_LIGA}. Use COPA | EURO | SUPER | PREMIER.`);
        return;
    }

    let tiro = 1;
    let lucroAcumulado = 0;
    let jogos = 0;
    const jaApostados = new Set<string>();

    while (jogos < AUTO_MAX_GAMES) {
        // trilhos de risco
        if (lucroAcumulado >= AUTO_STOP_WIN) {
            console.log(`🏁 STOP-WIN atingido: +R$${lucroAcumulado.toFixed(2)}. Encerrando sessão.`);
            break;
        }
        if (lucroAcumulado <= -AUTO_STOP_LOSS) {
            console.log(`🛑 STOP-LOSS atingido: R$${lucroAcumulado.toFixed(2)}. Encerrando sessão.`);
            break;
        }

        // escolhe o próximo confronto ainda não apostado, em sequência
        const horarios = await lerHorariosDisponiveis(AUTO_LIGA);
        const horario = horarios.find(h => !jaApostados.has(h));
        if (!horario) {
            console.log('⏳ Nenhum confronto novo disponível. Aguardando próximos...');
            await sleep(15000);
            continue;
        }
        jaApostados.add(horario);
        jogos++;

        const [horaStr, minStr] = horario.split(':');
        const stake = AUTO_BASE * Math.pow(2, tiro - 1);

        console.log(`\n🎯 Jogo ${jogos}/${AUTO_MAX_GAMES} → ${AUTO_LIGA} ${horario} | tiro ${tiro} | stake R$${stake.toFixed(2)}`);

        // saldo antes
        await getMoney();
        const saldoAntes = parseSaldo(MONEY);

        // executa (placeBet respeita o DRY-RUN internamente)
        await placeBet({
            liga: AUTO_LIGA,
            hora: horaStr,
            minutos: [Number(minStr)],
            entrada: [horario],
        }, tiro);

        // aguarda o jogo liquidar
        console.log(`⏱️  Aguardando liquidação (~${Math.round(AUTO_SETTLE_MS / 1000)}s)...`);
        await sleep(AUTO_SETTLE_MS);

        // determina resultado
        let green: boolean;
        if (AUTO_DRY_RUN) {
            // sem aposta real → simula o resultado só para exercitar a lógica
            green = getRandomArbitrary(0, 1) > 0.5;
            console.log(`🧪 [DRY-RUN] resultado SIMULADO: ${green ? 'GREEN' : 'RED'}`);
        } else {
            await getMoney();
            const saldoDepois = parseSaldo(MONEY);
            const net = saldoDepois - saldoAntes;
            green = net > 0;
            lucroAcumulado += net;
            console.log(`💵 Saldo ${saldoAntes.toFixed(2)} → ${saldoDepois.toFixed(2)} (net ${net >= 0 ? '+' : ''}${net.toFixed(2)}) → ${green ? '🟢 GREEN' : '🔴 RED'}`);
        }

        // martingale controlado
        if (green) {
            if (AUTO_DRY_RUN) lucroAcumulado += stake * 0.8; // estimativa só p/ log em simulação
            console.log('🟢 GREEN → reset para tiro 1');
            tiro = 1;
        } else {
            if (AUTO_DRY_RUN) lucroAcumulado -= stake;
            if (tiro >= AUTO_MAX_TIROS) {
                console.log(`🔴 RED no tiro ${tiro} (teto) → aborta sequência e reseta para tiro 1`);
                tiro = 1;
            } else {
                tiro++;
                console.log(`🔴 RED → sobe para tiro ${tiro}`);
            }
        }

        console.log(`📊 Lucro acumulado: ${lucroAcumulado >= 0 ? '+' : ''}R$${lucroAcumulado.toFixed(2)}`);
    }

    console.log(`\n🤖 Sessão encerrada. Jogos: ${jogos} | Resultado: ${lucroAcumulado >= 0 ? '+' : ''}R$${lucroAcumulado.toFixed(2)}`);
    // segura o processo vivo (não fecha o browser abruptamente)
    await new Promise(() => {});
};



init()