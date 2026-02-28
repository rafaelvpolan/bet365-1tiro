export default {
    // url:'https://www.bet365.com/#/AVR/B146/R^1/',
    url:'https://www.bet365.bet.br',
    elements:{
        champsList:".vrl-MeetingsHeader_ButtonContainer div",
        champsResultBtn:'.vr-ResultsNavBarButton',
        champsResultTime:'.vrr-FixtureDetails_Event ',
        champsResultScore:'.vrr-HTHTeamDetails_Score ',
        champsResultTeamOne:'.vrr-HTHTeamDetails_TeamOne',
        champsResultTeamTwo:'.vrr-HTHTeamDetails_TeamTwo',
        buttonPlayVideo:'.fpm-PlayButton'
    },
    popups:{
        saldo:".llr-3 >> .llr-d"
    },
    locators:{
        menuCategory:"text=Esportes Virtuais >> nth=0",
        pageItem:".wcl-CommonElementStyle_PrematchCenter >> .vss-4 >> div >> nth=1",
        champsResultBtn:'.vr-EventTimesNavBar_ButtonContainer >> div >> nth=0',
    },
    loginElements:{
        buttonLogin:'.hrm-07 >> .hrm-ec >> nth=2',
        inputLogin:'.slm2-34 >> input[type=text]',
        inputPass:'.slm2-3b >> input[type=password]'
    }
}