import * as fs from 'fs'

const args = [
  '-wait-for-browser',
  '--disable-infobars',
  '--no-sandbox',
  '--start-maximized',
  '--enable-features=NetworkService',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-site-isolation-trials',
  '--disable-blink-features=AutomationControlled',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--shm-size=12gb'
];

interface optionsInterface {
  args?: string[];
  headless: boolean;
  ignoreHTTPSErrors?: boolean;
  ignoreDefaultArgs?: string[];
  executablePath?: string;
  channel?: string;
  proxy?: Object;
}

// Descobre o navegador SEM path fixo, ciente do SO. No Linux/WSL NÃO adianta apontar
// pro chrome.exe do Windows (Playwright Linux não executa .exe) — usa o Chromium do Linux.
const existe = (p?: string): p is string => {
  if (!p) return false;
  try { return fs.existsSync(p); } catch { return false; }
};

const LOCALAPPDATA = process.env.LOCALAPPDATA;
const candidatosWin: (string | undefined)[] = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  LOCALAPPDATA ? `${LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const candidatosLinux: (string | undefined)[] = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium',
];

const options: optionsInterface = {
  args,
  headless: String(process.env.HEADLESS ?? 'false') === 'true',
  ignoreHTTPSErrors: true,
  ignoreDefaultArgs: ["--enable-automation", '--disable-extensions'],
};

const encontrado = (process.platform === 'win32' ? candidatosWin : candidatosLinux).find(existe);
if (encontrado) {
  options.executablePath = encontrado;
  console.log('🌐 Navegador:', encontrado);
} else if (process.platform === 'win32') {
  options.channel = 'chrome';
  console.log('🌐 Windows: sem caminho conhecido — tentando channel="chrome". Se falhar, defina CHROME_PATH no .env.');
} else {
  // Linux/WSL sem Chrome do sistema → usa o Chromium empacotado do Playwright.
  // (rode uma vez:  npx playwright install chromium)
  console.log('🌐 Linux/WSL: usando o Chromium do Playwright. Se der erro de executável, rode: npx playwright install chromium');
}

export default options
