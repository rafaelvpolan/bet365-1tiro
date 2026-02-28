
require('dotenv').config()
const { chromium } = require('playwright');
import options from './pw.config'
import bet365Spec from './spec/bet365.spec';
import Bet365Repository from './api/bet365/repositories/index.repository'
import { MongoDbConnect } from './config/database'
import { IBets } from './api/bet365/models/bets.model';
MongoDbConnect()

const { log, info, warn, error } = console

let browser: any = null
let context: any = null
let page: any = null
let lastTime: any = null
let errTimeout: number = 0
const dateNow = () => {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0'); //January is 0!
    const yyyy = today.getFullYear();

    return dd + '/' + mm + '/' + yyyy;
}



const getRandomArbitrary = (min:number, max:number) => {
    return Math.random() * (max - min) + min;
  }

const init = async () => {

    lastTime = new Date()
    errTimeout = 0
    // NAVEGA ATË A PAGINA
    await login()
    await navigate()
    // PEGA OS RESULTADOS
    grapGameResults()



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
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForSelector('body')
    await page.locator(bet365Spec.loginElements.buttonLogin).click()
    await page.locator(bet365Spec.loginElements.inputLogin).click();


    await page.keyboard.type('rafaelvpolan75362')
    await page.waitForTimeout(2000);
    await page.locator(bet365Spec.loginElements.inputPass).click();
    await page.keyboard.type('rafa5841');
    await page.waitForTimeout(2000);
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
    const btnPageSport = await page.locator(bet365Spec.locators.pageItem);
    if (btnPageSport)
        await btnPageSport.click();
    return true

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

                const teamWin = (scores[0]>scores[1]?teamOne:(scores[0]<scores[1]?teamTwo:(scores[0]==scores[1]?'tied':'error')))
                const totalGoals = (+scores[0])+(+scores[1])
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

    console.log('Exec Script in:', +diff, 'hr(s)', 'Err Timeout:',errTimeout)

    if (+diff > 10 || errTimeout > 20) {
        await page.close()
        init()
    }
    // await page.reload()
    // await page.waitForTimeout(20000)
    grapGameResults()
}

init()