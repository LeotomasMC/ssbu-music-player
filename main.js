
//console.time("startup");
//console.time("interactable");

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
global.logQueue = []

// special log function that should also log to the browser window devtools console
function log(msg, opts) {
    if (opts) console.log(msg, opts);
    else      console.log(msg)
    if (mainWindow) { // we dont want to refrence the mainWindow if it doesnt exist yet
        mainWindow.webContents.send("console:log", msg)
    } else { // so if it doesnt exist, save it to a queue that will be requested by the window when it is ready to
        logQueue.push(msg);
    }
}
global.log = log; // allows me to use this anywhere (but mostly for the node debug console)
log("loading required modules...")

// Modules to control application life and create native browser window
const {app, ipcMain, systemPreferences, dialog, globalShortcut} = require('electron');
const path = require('path');
const platFolders = require('platform-folders');
//const ewc = require('@svensken/ewc');
const { BrowserWindow } = require("electron-acrylic-window");
const { autoUpdater } = require("electron-updater");
const { checkForUpdates } = require("./updater")
const os = require("os");
const fs = require("fs");
const exec = require('child_process').exec;
const WebSocket = require("ws")
const DiscordRPC = require("discord-rpc");

log("loading player modules")

const songsModule = require("./js/songs.js")
const serverModule = require("./js/server.js");
//const { stdout } = require('process');

const clientID = "659092610400387093";
var rpc = null;

var rpcReady = false
var rpcCache = null

//ipcMain.on("songs:getSongList", (e) => {
//    e.returnValue = songs
//})

log("registering handlers and listeners...")

ipcMain.on("console:getlogs", (e) => {
    //console.log("sending logs to browser window")
    //console.timeEnd("interactable")
    for (let msg in logQueue) {
        mainWindow.webContents.send("console:log", logQueue[msg]);
        delete logQueue[msg];
    }

    mainWindow.setThumbarButtons([
        {
            tooltip: 'Previous Song',
            icon: path.join(__dirname, "assets/play.png"),
            flags: ["disabled"],
            click () { keybind_prev() }
        },
        {
            tooltip: 'Pause/Play',
            icon: path.join(__dirname, "assets/play.png"),
            click () { keybind_pauseplay() }
        },
        {
            tooltip: 'Next Song',
            icon: path.join(__dirname, "assets/skip.png"),
            click () { keybind_next() }
        }
    ])
}) 

// sends the song list to the browser window when requested to
ipcMain.handle("songs:getSongList", (e) => {
    return songs
})

// opens the the music folders file, and creates it first if it does not exist
ipcMain.on("file:openMusicFoldersFile", () => {
    let ext = "ssbu-music" + ( app.isPackaged ? "" : "-dev" )
    if (!fs.existsSync(platFolders.getMusicFolder() + "/folders." + ext)) {
        fs.writeFileSync(platFolders.getMusicFolder() + "/folders." + ext, "// Hey, just write a list of folders you want to load from here\n// Start a line with any of ['#', '//', '$', '!', '-'] and it will be ignored when being parsed (to write comments)\n// Start a line with '%' to tell the player to also look in subfolders of the folder on that line")
        // i use sync here because i want to be 100% sure it exists before trying to open it.
    }
    exec(platFolders.getMusicFolder() + "/folders." + ext)
})

ipcMain.on("file:openSettingsFile", () => {
    let ext = "ssbu-music" + ( app.isPackaged ? "" : "-dev" )
    if (!fs.existsSync(platFolders.getMusicFolder() + "/settings." + ext)) {
        fs.writeFileSync(platFolders.getMusicFolder() + "/settings." + ext, "// Hey, just write a list of folders you want to load from here\n// Start a line with any of ['#', '//', '$', '!', '-'] and it will be ignored when being parsed (to write comments)\n// Start a line with '%' to tell the player to also look in subfolders of the folder on that line")
        // i use sync here because i want to be 100% sure it exists before trying to open it.
    }
    exec(platFolders.getMusicFolder() + "/settings." + ext)
})

// allows the browser window to set a discord status
ipcMain.on("rpc:setactivity", (e, activity) => {
    if (rpcReady) {
        rpc.setActivity(activity)
        //log("rpc: " + JSON.stringify(activity))
    } else {
        rpcCache = activity;
    }
})

async function startRPC() {
    log("setting up discord rpc...")

    DiscordRPC.register(clientID);
    rpc = new DiscordRPC.Client({ transport: 'ipc' });
    global.rpc = rpc

    rpc.on('ready', () => {
        rpcReady = true
    
        if (rpcCache !== null) { // if the browser tried setting a status before RPC was ready, we store it, and set it when RPC is actually ready
            rpc.setActivity(rpcCache);
            rpcCache = null;
        } else {
            rpc.setActivity({"state": "idle"})
        }
        //setInterval(() => {updateRPC()}, 15e3);
    })
    
    rpc.on('error', (e) => {
        log(e)
    })

    rpc.login({ clientId: clientID }).then(() => {
        rpc.subscribe('ACTIVITY_JOIN', ({ secret }) => {
            log(secret);
            startWSInstance(secret);
            
        })
        
        rpc.subscribe('ACTIVITY_JOIN_REQUEST', (user) => {
            log(user)
        })
    }).catch(console.error);
}

log("registering all functions...")

var ws = null;

function startWSInstance(dest) {
    log("creating websocket client...")
    ws = new WebSocket("ws://" + dest, {});
    log("assigning websocket listeners...")
    ws.on('open', () => {
        ws.send("ws:connected");
    })
    ws.on("message", (data) => {
        log(data)
    })
    log("created websocket client.")
}
//rpc.subscribe("")


//let popupWindow;


// function to check if the user is on windows 10 or not. this checks *specifically* for windows 10, and not just windows in general
// this function is only used to see if it should attempt to use acrylic or not
function isWindows10() {
    if (process.platform !== 'win32') return false;
    return os.release().split('.')[0] === '10';
}

function getVibrancySettings() {
    if (isWindows10()) return {
        theme: '#22222222',
        effect: 'acrylic',
        useCustomWindowRefreshMethod: true,
        disableOnBlur: true,
        debug: false
    };
    else return 'dark'; // if not on windows 10, this is used as the "vibrancy" setting on OSX, which is similar to acrylic
    // if not on OSX, this setting is just ignored at that point
}

var twitchOauthWindow = null;

async function createWindow () {
    // Create the browser window.
    log("creating browser window...")
    
    mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        minWidth: 550, 
        minHeight: 475,
        //transparent: true,
        //backgroundColor: '#fff',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: true,
            enableRemoteModule: true,
            //webSecurity: false // only ever disabled for testing purposes. a build will never intentionally be released with webSecurity disabled
        },
        //backgroundColor: '#44444444',
        vibrancy: getVibrancySettings(),
        frame: false // removes the frame from the window so acrylic works, but also because it draws its own title bar
    })
    songsModule.loadSongsFromMusicFolder().then((ret) => { //     waits for songs to finish loading
        mainWindow.webContents.send("songs:refreshList", ret); // then tells the browser window the new songs and that it should refresh them
    });
    //ewc.setAcrylic(mainWindow, 0x14800020);
    log("loading music player page...")

    // and load the index.html of the app.
    mainWindow.loadFile('index.html')
    //mainWindow.loadURL("chrome://chrome-urls")

    // Open the DevTools if app is not packaged. (so only in dev environment)
    if (!app.isPackaged) {
        log("opening devtools...");
        mainWindow.webContents.openDevTools();
    }
    
    log("registering window listeners...")
    // Emitted when the window is closed.
    mainWindow.on('closed', function () {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
        mainWindow = null
    });

    mainWindow.webContents.on('will-navigate', (e, url) => {
        if(url != mainWindow.webContents.getURL()) {
            e.preventDefault()
            require('electron').shell.openExternal(url)
        }
    })
    mainWindow.webContents.on('new-window', (e, url) => {
        if(url != mainWindow.webContents.getURL() && !url.startsWith("https://id.twitch.tv")) {
            e.preventDefault()
            require('electron').shell.openExternal(url)
        }

        if (url.startsWith("https://id.twitch.tv")) {
            console.log(e)
        }
    })

    startRPC()

    log("registering media key handlers...")
    // registers global shortcut handlers for media keys on the keyboard
    globalShortcut.register("MediaPlayPause",     keybind_pauseplay);
    globalShortcut.register("MediaStop",          keybind_stop);
    globalShortcut.register("MediaNextTrack",     keybind_next);
    globalShortcut.register("MediaPreviousTrack", keybind_prev);
    log("Done!")
}

function keybind_pauseplay() { mainWindow.webContents.send("updateState", "playpause");log("playpause"); };
function keybind_stop()      { mainWindow.webContents.send("updateState", "stop");log("stop"); };
function keybind_prev()      { mainWindow.webContents.send("updateState", "prev");log("prev"); };
function keybind_next()      { mainWindow.webContents.send("updateState", "next");log("next"); };

log("registering application listeners")

app.on("will-quit", () => {
    log("closing.")
    rpc.destroy()
    globalShortcut.unregisterAll();
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {log("application ready, preparing to create window..."); createWindow()})

// Quit when all windows are closed.
app.on('window-all-closed', function () {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    // disabled because idc about how mac works differently and because
    // it doesnt currently support reopening the main window or running
    // in the background (while closed)
    //if (process.platform !== 'darwin') app.quit()
    app.quit();
})

/*app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) createWindow()
})*/

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
ipcMain.on('acrylic-enable', (_) => {
    mainWindow.setVibrancy(getVibrancySettings())
});

ipcMain.on('acrylic-disable', (_) => {
    mainWindow.setVibrancy(null)
});

ipcMain.on("updateCheck", function() {
    checkForUpdates()
})

/*
ipcMain.on('blurBehind', (_) => {
    ewc.setBlurBehind(mainWindow, 0x14800020);
});
ipcMain.on('gradient', (_) => {
    ewc.setGradient(mainWindow, 0x14800020);
});
ipcMain.on('trGradient', (_) => {
    ewc.setTransparentGradient(mainWindow, 0x14800020);
});
*/
log("Finished main file sequence.")
//console.timeEnd("startup")