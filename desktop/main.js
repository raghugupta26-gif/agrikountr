/* Krishi Khata desktop app (Windows). Starts the shop server and opens the app window.
   Closing the window keeps the server running in the tray, so phones can still sync. */
'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const { start } = require('./server');

if(!app.requestSingleInstanceLock()){ app.quit(); }
let win = null, tray = null, srv = null, quitting = false;

function createWindow(){
  win = new BrowserWindow({ width:1280, height:860, minWidth:900, minHeight:600, title:'Krishi Khata', icon:path.join(__dirname,'build','icon.png'),
    autoHideMenuBar:true, webPreferences:{ contextIsolation:true, sandbox:true, spellcheck:false } });
  win.loadURL(`http://127.0.0.1:${srv.port}/`);
  win.webContents.setWindowOpenHandler(({url})=>{ shell.openExternal(url); return {action:'deny'}; });
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb)=>cb(['media','notifications','clipboard-sanitized-write'].includes(perm)));
  win.on('close', e=>{ if(!quitting){ e.preventDefault(); win.hide(); if(tray && !app._toldTray){ app._toldTray=true; tray.displayBalloon?.({title:'Krishi Khata', content:'Still running so phones can sync. Right-click the tray icon to quit.'}); } } });
}
app.on('second-instance', ()=>{ if(win){ win.show(); win.focus(); } });
app.whenReady().then(()=>{
  srv = start({ dataDir: path.join(app.getPath('userData'), 'shop-data'), webDir: path.join(__dirname, 'web') });
  srv.server.on('error', err=>{ dialog.showErrorBox('Krishi Khata', 'Could not start the shop server: '+err.message+'\nIs Krishi Khata already open?'); });
  if(!app.getLoginItemSettings().openAtLogin && process.platform==='win32'){ try{ app.setLoginItemSettings({openAtLogin:true, args:['--hidden']}); }catch(e){} }
  createWindow();
  if(process.argv.includes('--hidden')) win.hide();
  try{
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname,'build','icon.png')).resize({width:16, height:16}));
    tray.setToolTip('Krishi Khata – shop server running');
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:'Open Krishi Khata', click:()=>{ win.show(); win.focus(); }},
      {label:'Open data folder', click:()=>shell.openPath(srv.dataDir)},
      {label:'Back up now', click:()=>srv.backupNow()},
      {type:'separator'},
      {label:'Quit (phones stop syncing)', click:()=>{ quitting=true; srv.stop(); app.quit(); }}
    ]));
    tray.on('click', ()=>{ win.show(); win.focus(); });
  }catch(e){}
});
app.on('before-quit', ()=>{ quitting=true; try{ srv && srv.stop(); }catch(e){} });
app.on('window-all-closed', ()=>{ /* keep running in the tray */ });
