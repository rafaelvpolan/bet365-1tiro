
require('dotenv').config()
const { chromium } = require('playwright');
import options from './pw.config'
import bet365Spec from './spec/bet365.spec';
import Bet365Repository from './api/bet365/repositories/index.repository'
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import * as readline from "readline";
const apiId: number = Number(process.env.TELEGRAM_API_ID); // seu api_id
const apiHash: string = String(process.env.TELEGRAM_API_HASH);
console.log(apiId, typeof apiId);
const session = new StringSession(""); // na primeira vez deixa vazio
// import { MongoDbConnect } from './config/database'
import { IBets } from './api/bet365/models/bets.model';
// MongoDbConnect()

const { log, info, warn, error } = console

let browser: any = null
let context: any = null
let page: any = null
let lastTime: any = null
let errTimeout: number = 0
var initBetStatus: boolean = false;
let MONEY:string;
const dateNow = () => {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0'); //January is 0!
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

const init = async () => {
    await watchTelegram()
    await initBet()

}

const initBet = async () => {
    lastTime = new Date()
    errTimeout = 0


    // NAVEGA ATË A PAGINA
    await login()
    initBetStatus = await navigate()
    getMoney()
    // placeBet({liga:'PREMIER',hora:'23', entrada:[31,34]})
    // PEGA OS RESULTADOS
    // grapGameResults()
}


const indiceChamps:any = {
    COPA: 1,
    EURO: 2,
    SUPER: 3,
    PREMIER: 4
}

const watchTelegram = async () => {

    const sessionString = process.env.SESSION ?? "";
    const session = new StringSession(sessionString);

    const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
    });

    if (sessionString) {
        // Já tem session — só conecta sem pedir código
        await client.connect();
        log("✅ Telegram reconectado pela session!");
    } else {
        // Primeira vez — faz login completo
        await client.start({
            phoneNumber: async () => process.env.TELEGRAM_MYPHONE as string,
            password: async () => await askQuestion("Senha 2FA (se tiver, senão Enter): "),
            phoneCode: async () => await askQuestion("Digite o código recebido no Telegram: "),
            onError: (err: Error) => log(err),
        });

        const savedSession = client.session.save() as unknown as string;
        log("⚠️  Copie essa SESSION para o .env:");
        log(savedSession);
    }

    client.addEventHandler(async (event: NewMessageEvent) => {
        const message = event.message;
        const chatId = message.chatId?.toString();
        console.log('CHAT ID::', chatId);
        if (chatId !== "-1003606398609") return;

        log("Mensagem do grupo:", message.text);
        const msg:propsBet = parseMensagem(message.text)
        log("Estrutura:", msg)
        if(BetInProgress) new Promise(resolve => setTimeout(resolve, 10000))
        placeBet(msg)

    }, new NewMessage({}));
};

const LIGAS = ['EURO', 'COPA', 'PREMIER', 'SUPER'];

function parseMensagem(texto: string):propsBet {
    // Liga
    const liga = LIGAS.find(l => texto.includes(l)) || null;

    // Hora
    const horaMatch = texto.match(/⏰\s*H:\s*(\d+)/);
    const hora = horaMatch ? horaMatch[1] : null;

    // Todos os minutos após ➡
    const setaMatch = texto.match(/➡\s*([\d\s]+)/);
    const minutos = setaMatch
        ? setaMatch[1].trim().split(/\s+/).map(Number).filter(n => !isNaN(n))
        : [];

    // Primeiros 2 minutos (entrada) com hora
    const entrada = setaMatch
        ? setaMatch[1].trim().split(/\s+/).map(Number).filter(n => !isNaN(n))
            .slice(0, 2)
            .map(min => `${hora}:${String(min).padStart(2, '0')}`)
        : [];

    return { liga, hora, minutos, entrada };
}



const login = async () => {

    browser = await chromium.launch(options)
    context = await browser.newContext({
        geolocation: { latitude: -23.5505, longitude: -46.6333 }, // São Paulo, por exemplo
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
    // await page.keyboard.type('Hello World!');
    // await page.keyboard.press('ArrowLeft');

}
const navigate = async () => {
    // INICIA O BROWSER 
    // if (browser) browser.close()
    // browser = await chromium.launch(options)
    // context = await browser.newContext();
    // await page.goto(bet365Spec.url);
    // await page.setViewportSize({ width: 1920, height: 1080 });
    // await page.waitForSelector('body')

    const popupSaldo = await page.locator(bet365Spec.popups.saldo);
    if (popupSaldo)
        await popupSaldo.click();
    await page.waitForTimeout(2000)
    const btnPage = await page.locator(bet365Spec.locators.menuCategory);
    if (btnPage)
        await btnPage.click();
    await page.waitForTimeout(2000)

           // ACEITA COOKIES 
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
const getMoney = async () => {
    // INICIA O BROWSER 
    // if (browser) browser.close()
    // browser = await chromium.launch(options)
    // context = await browser.newContext();
    // await page.goto(bet365Spec.url);
    // await page.setViewportSize({ width: 1920, height: 1080 });
    // await page.waitForSelector('body')

    MONEY = await page.$eval(bet365Spec.elements.money, (el: any) => el ? el.innerText : null);
    console.log(MONEY)

    setTimeout(getMoney,120000)

}

interface propsBet {
    liga:string | null
    hora:string | null
    minutos:Array<number>
    entrada:Array<string>
}
let BetInProgress = false
const placeBet = async (props:propsBet) =>{
    if(props.entrada.length==0 || !props.liga) return
    BetInProgress = true
    // NAVETA ATE O CHAMP
    await page.locator(`.vrl-MeetingsHeader_ButtonContainer >> div >> nth=${indiceChamps[props.liga]}`).click() ;    

    await page.waitForTimeout(3000)
    const entrada = props.entrada; // sua entrada

    for (const horario of entrada) {
        const botao = page.locator('.vr-EventTimesNavBarButton_Text', {
            hasText: horario
        });
        const existe = await botao.count();

        if (existe > 0) {
            await botao.click();
            console.log(`✅ Clicou em ${horario}`);
            await page.waitForTimeout(3000)
            await page.locator('.gl-MarketGroupPod.gl-MarketGroup >> nth=2 >> .gl-ParticipantOddsOnly.gl-Participant_General.gl-Market_General-cn1 >> nth=0').click()
            await page.waitForTimeout(3000)
            page.locator('.bsf-StakeBox_Wrapper').click()
            await page.waitForTimeout(1000)
            await page.keyboard.type('1');
            await page.waitForTimeout(1000)
            await page.locator('.bsf-PlaceBetButton.bsf-PlaceBetButton-ccyprefixsymbol').click()
            await page.waitForTimeout(2000)
            await page.locator('.bss-ReceiptContent_Done').click()
            await page.waitForTimeout(2000)
        
        } else {
            console.log(`❌ Horário ${horario} não encontrado na tela`);
        }
    }
    
    await page.reload()
    await page.waitForSelector('body')
    BetInProgress = false
    // console.log(champsListName)
    // console.log(champsListName[indiceChamps[props.liga]])


}

const grapGameResults = async () => {


    try {
        await page.waitForSelector(bet365Spec.elements.champsList, { timeout: 5000 })
    } catch (err) {
        error(err)
        errTimeout++

    }

    // let champsListName = await page.evaluate((bet:any) => Array.from( document.querySelectorAll(bet.elements.champsList), element => element.textContent) , bet365Spec );
    let champsListName = await page.$$eval(bet365Spec.elements.champsList, (items: any) => items.map((item: any) => item.innerText));
    // console.log('LIST',champsListName) 
    // PRE CARREGA PAGINAS
    // for (const i of Object.keys(champsListName)) {
    //     const menuChamp = page.locator(bet365Spec.elements.champsList + ' >> nth=' + i)
    //     await menuChamp.click()
    //     await page.waitForTimeout(2000)
    // }

    for (const i of Object.keys(champsListName)) {
        // console.log(i)
        await page.reload()
        await page.waitForSelector('body')

        // CLINA NO CAMPEONATO FORCANDO APARECER O RESULTADO
        await page.mouse.move(0, 0);
        await page.mouse.down();
        await page.mouse.move(0, 100);
        await page.mouse.move(100, 100);
        await page.mouse.move(100, 0);
        await page.mouse.move(0, 0);
        await page.mouse.up();

        const boxChamp = await page.locator(bet365Spec.elements.champsList + ' >> nth=' + i).boundingBox();
        await page.mouse.click(boxChamp.x + boxChamp.width / 2, boxChamp.y + boxChamp.height / 2);


        await page.locator(bet365Spec.elements.buttonPlayVideo).click()
        // await page.locator(bet365Spec.elements.champsList + ' >> nth=' + i).click()
        await page.waitForTimeout(3000)


        // await page.locator(bet365Spec.elements.champsList + ' >> nth=' + i).click()
        try {
            await page.waitForSelector(bet365Spec.locators.champsResultBtn, { timeout: 3000 })
        } catch (err) {
            error(err)
            errTimeout++
            continue
        }
        await page.waitForTimeout(3000)
        // Clica no Resultados
        const boxResult = await page.locator(bet365Spec.elements.champsResultBtn).boundingBox();
        await page.mouse.click(boxResult.x + boxResult.width / 2, boxResult.y + boxResult.height / 2);

        // Pega o horario
        try {
            await page.waitForSelector(bet365Spec.elements.champsResultTime, { timeout: 3000 })
        } catch (err) {
            error(err)
            errTimeout++
            continue
        }
        let time = await page.$eval(bet365Spec.elements.champsResultTime, (el: any) => el ? el.innerText : null)
        if (!time) {
            error('TIME not found.')
            errTimeout++
            continue
        }
        const timeSplit = time.split(' - ')[1].split('.')
        time = timeSplit[0].padStart(2, '0') + ':' + timeSplit[1].padStart(2, '0')

        // GERA TIMESTAMP
        const dt: any = new Date()
        const timestamp = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), timeSplit[0], timeSplit[1], 0, 0)
        console.log(timestamp)
        // Pega o TeamOne
        try {
            await page.waitForSelector(bet365Spec.elements.champsResultTeamOne, { timeout: 3000 })
        } catch (err) {
            error(err)
            errTimeout++
            continue
        }
        let teamOne = await page.$eval(bet365Spec.elements.champsResultTeamOne, (el: any) => el ? el.innerText : null)
        // Pega o TeanTwo
        try {
            await page.waitForSelector(bet365Spec.elements.champsResultTeamTwo, { timeout: 3000 })
        } catch (err) {
            error(err)
            errTimeout++
            continue
        }
        let teamTwo = await page.$eval(bet365Spec.elements.champsResultTeamTwo, (el: any) => el ? el.innerText : null)
        // Pega o score
        try {
            await page.waitForSelector(bet365Spec.elements.champsResultScore, { timeout: 3000 })
        } catch (err) {
            error(err)
            errTimeout++
            continue
        }
        let score = await page.$eval(bet365Spec.elements.champsResultScore, (el: any) => el ? el.innerText : null)

        if (!score) {
            error('SCORE not found.')
            errTimeout++
            continue
        }

        if (score.indexOf('undefined') === -1) {
            const datetime = dateNow() + ' ' + time
            const find = await Bet365Repository.find({ find: { championship: champsListName[i], timestamp: timestamp } })


            if (!find.length) {
                console.log('Novo resultado inserido!')
                score = score.replace(' - ', '-')
                let scores = await score.split('-')

                const teamWin = (scores[0] > scores[1] ? teamOne : (scores[0] < scores[1] ? teamTwo : (scores[0] == scores[1] ? 'tied' : 'error')))
                const totalGoals = (+scores[0]) + (+scores[1])
                const props = <IBets>{
                    sport: 'Futebol',
                    championship: champsListName[i],
                    date: dateNow(),
                    time: time,
                    datetime: datetime,
                    timestamp: timestamp,
                    timezone: process.env.TZ,
                    teamOne: teamOne,
                    teamTwo: teamTwo,
                    teamWin: teamWin,
                    totalGoals: totalGoals,
                    score: score

                }
                await Bet365Repository.save(props)


            }



        }

        await page.waitForTimeout(10000)


    }


    const timeExec = new Date().getTime() - lastTime.getTime()
    const diff = (timeExec / (1000 * 60 * 60)).toFixed(1)

    console.log('Exec Script in:', +diff, 'hr(s)', 'Err Timeout:', errTimeout)

    if (+diff > 10 || errTimeout > 20) {
        await page.close()
        initBet()
    }
    // await page.reload()
    // await page.waitForTimeout(20000)
    grapGameResults()
}

init()

// TEST


const modeloMsg = `Mensagem do grupo: 🤖 **DE TIRO  SECO / 2026** 🤖
🏆 PREMIER 🏆

⏰ H: 23
➡ 01 04 07

✔ **Entrada:** Ambas Sim

💰 **Proteção (Obrigatória):**
03.00: 0 Gol
03.03: 0 Gol
IA • DA BRUU

🔗 ACESSE AQUI
🚨 ABORTAR SE BATER 2 JOGOS ANTES SEGUIDOS

**1 Greens Seguidos! ** 🤑

✅13➖➖➖✖4➖➖➖A: 2
SG: 7➖➖➖G1: 5
💰P: 2

🎯 76,47% de Acerto`

log(parseMensagem(modeloMsg))