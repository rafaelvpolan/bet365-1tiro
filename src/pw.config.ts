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
  proxy?:Object
}

const options: optionsInterface = {
  args:args,
  headless: false,
  // proxy: {
  //   server: '50.206.25.110:80'
  // },
  ignoreHTTPSErrors: true,
  ignoreDefaultArgs: ["--enable-automation", '--disable-extensions'], //REMOVE MODO DE TESTE DO NAVEGADOR,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // executablePath:"C:\\Program Files\\Mozilla Firefox\\firefox.exe"
};

export default options
