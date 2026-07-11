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

const { log, info, warn, error } = console
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let browser: any = null
let context: any = null
let page: any = null
let lastTime: any = null
let errTimeout: number = 0
var initBetStatus: boolean = false;
let MONEY: string;

// ─── CONFIG ESTRATÉGIA AUTÔNOMA ("Sequência Controlada") ───────────────────────
// Liga por variáveis de ambiente. Tudo tem default seguro.
const AUTO_MODE   = String(process.env.AUTO_MODE ?? 'false') === 'true';   // liga o modo autônomo (senão usa Telegram)
const AUTO_DRY_RUN = String(process.env.AUTO_DRY_RUN ?? 'true') === 'true'; // true = NÃO aposta dinheiro real, só simula/loga
const AUTO_LIGA   = String(process.env.AUTO_LIGA ?? 'SUPER').toUpperCase(); // COPA | EURO | SUPER | PREMIER
const AUTO_MAX_GAMES  = Number(process.env.AUTO_MAX_GAMES  ?? 20);   // máx. de jogos por sessão
const AUTO_MAX_TIROS  = Number(process.env.AUTO_MAX_TIROS  ?? 3);    // teto do martingale (reseta ao atingir)
const AUTO_STOP_WIN   = Number(process.env.AUTO_STOP_WIN   ?? 5);    // para se o lucro acumulado >= R$
const AUTO_STOP_LOSS  = Number(process.env.AUTO_STOP_LOSS  ?? 3);    // para se o prejuízo acumulado >= R$
const AUTO_SETTLE_MS  = Number(process.env.AUTO_SETTLE_MS  ?? 90000);// tempo de espera até o jogo liquidar (ms)
const AUTO_BASE       = Number(process.env.AUTO_BASE       ?? 0.10); // stake base do tiro 1


// ─── TIPOS ───────────────────────────────────────────────────────────────────

interface propsBet {
    liga: string | null
    hora: string | null
    minutos: Array<number>
    entrada: Array<string>
}

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
const groupIds = ["-1003972273645","-1003888617976"];

const indiceChamps: any = {
    COPA: 1,
    EURO: 2,
    SUPER: 3,
    PREMIER: 4
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
7
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

const LIGAS = ['EURO', 'COPA', 'PREMIER', 'SUPER'];

function parseMensagem(texto: string): propsBet {
    // Liga
    const liga = LIGAS.find(l => texto.includes(l)) || null;

    // Hora
    const horaMatch = texto.match(/⏰\s*H:\s*(\d+)/);
    const hora = horaMatch ? horaMatch[1] : null;

    // Todos os minutos após ➡ (aceita ➡ e ➡️)
    const setaMatch = texto.match(/➡️?\s*([\d\s]+)/);
    const minutos = setaMatch
        ? setaMatch[1].trim().split(/\s+/).map(Number).filter(n => !isNaN(n))
        : [];

    // Entrada: todos os minutos formatados como "hora:minuto" (usado como fallback)
    const entrada = minutos.map(min => `${hora}:${String(min).padStart(2, '0')}`);

    return { liga, hora, minutos, entrada };
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

    // ── Nova mensagem ────────────────────────────────────────────────────────
    client.addEventHandler(async (event: NewMessageEvent) => {
        const message = event.message;
        const chatId = message.chatId?.toString();
        log('CHAT ID::', chatId);
        if (!chatId || !groupIds.includes(chatId)) return;
       

        log("📩 Nova mensagem:", message.text);

        const msg: propsBet = parseMensagem(message.text);
        log("Estrutura parseada:", msg);

        if (!msg.liga || !msg.hora || msg.minutos.length === 0) {
            log("⚠️ Mensagem ignorada: sem liga, hora ou minutos.");
            return;
        }

        const messageId = Number(message.id);

        // ✅ FORA do forEach — registra o sinal UMA VEZ
        activeSignals.set(messageId, {
            props: msg,
            tiroAtual: 0,
            green: false,
            timestamp: Date.now(),
        });


        const minutoBase = msg.minutos[0];

        msg.minutos.forEach((minuto, index) => {
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

    }, new NewMessage({}));

    // ── Mensagem editada — detecta GREEN ─────────────────────────────────────
    client.addEventHandler(async (event: EditedMessageEvent) => {
        const message = event.message;
        const chatId = message.chatId?.toString();
      
        if (!chatId || !groupIds.includes(chatId)) return;

        const signal = activeSignals.get(message.id);
        if (!signal) return; // Não é um sinal ativo

        const text = message.text ?? "";
        log(`✏️  Mensagem editada (ID: ${message.id}):`, text);

        if (text.toUpperCase().includes("GREEN")) {
            console.log(`✅ GREEN detectado! Cancelando sinal ${message.id}`);

            signal.green = true;
            activeSignals.set(message.id, signal);

            removeFromQueue(message.id);
            activeSignals.delete(message.id);
        }

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
    await initBet()

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

const login = async () => {
    browser = await chromium.launch(options)
    context = await browser.newContext({
        geolocation: { latitude: -23.5505, longitude: -46.6333 },
        permissions: ['geolocation'],
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
    });
    await context.setDefaultTimeout(0);
    await context.setDefaultNavigationTimeout(0);
    page = await context.newPage();
    await page.goto(bet365Spec.url);
    await page.setViewportSize({ width: 1620, height: 880 });
    await page.waitForSelector('body')
    await page.locator(bet365Spec.loginElements.buttonLogin).click()
    await page.locator(bet365Spec.loginElements.inputLogin).click();
    await page.keyboard.type('rafaelvpolan75362')
    await page.waitForTimeout(800);
    await page.locator(bet365Spec.loginElements.inputPass).click();
    await page.keyboard.type('rafa5841');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    return true
}



const navigate = async () => {
    const popupSaldo = await page.locator(bet365Spec.popups.saldo);
    if (popupSaldo)
        await popupSaldo.click();
    await page.waitForTimeout(2000)
    const btnPage = await page.locator(bet365Spec.locators.menuCategory);
    if (btnPage)
        await btnPage.click();
    await page.waitForTimeout(2000)

    const cookieButton = page.locator('button', { hasText: "Aceitar todos" });
    if (await cookieButton.count() > 0) {
        await cookieButton.click();
        console.log('✅ Cookies aceitos');
    }

    const btnPageSport = await page.locator(bet365Spec.locators.pageItem);
    if (btnPageSport)
        await btnPageSport.click();
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
        const BASE = AUTO_BASE;
        const valorAposta = BASE * Math.pow(2, tiro - 1);

        log(`💰 Valor da aposta no tiro ${tiro}: R$${valorAposta}`);

        if (!await getMoney()) {
            await page.close()
            loginReady = await login()
            initBetStatus = await navigate()
        }

        if (!loginReady || !initBetStatus) return

        await page.locator(`.vrl-MeetingsHeader_ButtonContainer >> div >> nth=${indiceChamps[props.liga]}`).click();
        await page.waitForTimeout(2000)

        for (const horario of props.entrada) {

            const botao = page.locator('.vr-EventTimesNavBarButton_Text', { hasText: horario });

            if (await botao.count() === 0) {
                console.log(`❌ Horário ${horario} não encontrado`);
                continue;
            }

            await botao.first().click();
            console.log(`✅ Clicou em ${horario}`);

            await page.waitForTimeout(2000)

            const odd = page.locator('.gl-MarketGroupPod.gl-MarketGroup >> nth=2 >> .gl-ParticipantOddsOnly >> nth=0');

            if (await odd.count() === 0) {
                console.log(`❌ Odd não encontrada`);
                continue;
            }

            await odd.click();

            await page.waitForTimeout(1500)

            await page.locator('.bsf-StakeBox_Wrapper').click()

            await page.keyboard.type(String(valorAposta));

            await page.waitForTimeout(1000)

            // 🧪 DRY-RUN (só no modo autônomo): monta a aposta mas NÃO confirma
            if (AUTO_MODE && AUTO_DRY_RUN) {
                console.log(`🧪 [DRY-RUN] Aposta montada e NÃO enviada → ${props.liga} ${horario} | tiro ${tiro} | R$${valorAposta.toFixed(2)}`);
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

            await page.locator('.bss-ReceiptContent_Done').click()

            await page.waitForTimeout(1500)
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