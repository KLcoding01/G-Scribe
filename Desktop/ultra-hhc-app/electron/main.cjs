const { app, BrowserWindow, shell, ipcMain, clipboard, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { getMedsInjectorBootstrapCode, getMedsAutofillCode, parseMedsText } = require('./medsInjector.cjs');
const { extractMedsFromImage } = require('./medsOCR.cjs');
const autofillEngineDb = require('./autofillEngineDb.cjs');
const { registerAiAssistantIpc } = require('./services/aiAssistantService.cjs');
const { registerCopilotIpc } = require('./services/copilotService.cjs');
const { registerKinnserSummaryCopilotIpc } = require('./services/kinnserSummaryCopilotService.cjs');
const responseCache = require('./responseCache.cjs');
const goldenExamples = require('./goldenExamples.cjs');
const prefetchEngine = require('./prefetchEngine.cjs');

// Fail-safe: never crash on duplicate ipcMain.handle registration.
// If a channel is registered again, replace the previous handler.
const _ipcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  try { ipcMain.removeHandler(channel); } catch (_) {}
  return _ipcHandle(channel, listener);
};

function debugLog(location, message, data, hypothesisId = 'H0') {
  const payload = { sessionId: '1182f5', runId: 'rule-click', hypothesisId, location, message, data: data || {}, timestamp: Date.now() };
  try {
    fetch('http://127.0.0.1:7444/ingest/9f1a5f2d-97a0-4685-b04b-06f3a38c8908', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '1182f5' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch (_) {}
  try {
    fs.mkdirSync(path.join(__dirname, '..', '.cursor'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, '..', '.cursor', 'debug-1182f5.log'), JSON.stringify(payload) + '\n');
  } catch (_) {}
}

// ── API Key Storage ─────────────────────────────────────────────

// Migrate data from old app name (autofill-oasis) to new (orbit-agent)
(function migrateOldData() {
  try {
    const newDir = app.getPath('userData'); // .../orbit-agent/
    const oldDir = path.join(path.dirname(newDir), 'autofill-oasis');
    if (!fs.existsSync(oldDir)) return;
    const newConfig = path.join(newDir, 'config.json');
    // Only migrate if new dir has no config yet
    if (fs.existsSync(newConfig)) return;
    console.log('[Migration] Copying data from autofill-oasis to orbit-agent...');
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    const files = fs.readdirSync(oldDir);
    for (const f of files) {
      const src = path.join(oldDir, f);
      const dst = path.join(newDir, f);
      if (!fs.existsSync(dst)) {
        try {
          fs.copyFileSync(src, dst);
          console.log('[Migration] Copied:', f);
        } catch (e) {
          console.error('[Migration] Failed to copy', f, e.message);
        }
      }
    }
    console.log('[Migration] Done. Data migrated from autofill-oasis.');
  } catch (e) {
    console.error('[Migration] Error:', e.message);
  }
})();

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  return {};
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

let appConfig = loadConfig();

// ── Custom Profiles Storage ──────────────────────────────────────
const PROFILES_PATH = path.join(app.getPath('userData'), 'custom-profiles.json');

function loadCustomProfiles() {
  try {
    if (fs.existsSync(PROFILES_PATH)) {
      return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load custom profiles:', e);
  }
  return {};
}

function saveCustomProfiles(profiles) {
  try {
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save custom profiles:', e);
    return false;
  }
}

function loadAutofillStore() {
  return autofillEngineDb.getStore();
}

function saveAutofillStore(store) {
  try {
    return autofillEngineDb.saveFullStore(store);
  } catch (e) {
    console.error('Failed to save autofill store:', e);
    return false;
  }
}

function autofillActorLabel() {
  try {
    return appConfig.ownerDisplayName || os.userInfo().username || 'local';
  } catch {
    return 'local';
  }
}

// ── Register custom protocol so browser can launch this app ─────
const PROTOCOL = 'orbit-agent';
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// ── Single instance lock — focus existing window if re-launched ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let mainWindow = null;
let serviceIpcRegistered = false;
let coreIpcRegistered = false;

function createWindow() {
  // #region agent log
  debugLog('electron/main.cjs:createWindow', 'createWindow entered', { coreIpcRegistered, serviceIpcRegistered }, 'H0');
  // #endregion
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 880,
    minHeight: 520,
    resizable: true,
    maximizable: true,
    title: 'Orbit Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  if (!coreIpcRegistered) {
    // ── Clipboard IPC ─────────────────────────────────────────────
    ipcMain.handle('clipboard:writeText', (_evt, text) => {
      try {
        clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''));
        return true;
      } catch { return false; }
    });

  ipcMain.handle('shell:openExternal', async (_evt, url) => {
    try { await shell.openExternal(url); return true; } catch { return false; }
  });

  // ── Meds Injector IPC ─────────────────────────────────────────
  ipcMain.handle('meds:getBootstrapCode', () => {
    return getMedsInjectorBootstrapCode();
  });

  ipcMain.handle('meds:getAutofillCode', (_evt, entries, agency) => {
    return getMedsAutofillCode(entries, agency);
  });

  ipcMain.handle('meds:parseText', (_evt, text) => {
    return parseMedsText(text);
  });

  // ── Meds OCR IPC ──────────────────────────────────────────────
  ipcMain.handle('meds:ocrImage', async (_evt, imageDataUrl) => {
    try {
      const apiKey = appConfig.anthropicApiKey;
      if (!apiKey) {
        return { ok: false, error: 'API key not configured. Click ⚙️ to set up.' };
      }

      // Convert data URL to buffer
      const base64Match = imageDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
      if (!base64Match) {
        return { ok: false, error: 'Invalid image format' };
      }
      const imageBuffer = Buffer.from(base64Match[1], 'base64');

      const result = await extractMedsFromImage(imageBuffer, apiKey);
      return { ok: true, text: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('meds:pickImage', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }
        ]
      });

      if (result.canceled || !result.filePaths.length) {
        return { ok: false, canceled: true };
      }

      const images = result.filePaths.map(filePath => {
        const buffer = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase().slice(1);
        const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
        const mimeType = mimeTypes[ext] || 'image/png';
        const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
        return { dataUrl, fileName: path.basename(filePath) };
      });

      // Return single image for backwards compat, plus array
      return { 
        ok: true, 
        dataUrl: images[0].dataUrl, 
        fileName: images[0].fileName,
        images 
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── Config IPC ────────────────────────────────────────────────
  ipcMain.handle('config:getApiKey', () => {
    return appConfig.anthropicApiKey ? '••••••••' + appConfig.anthropicApiKey.slice(-4) : '';
  });

  ipcMain.handle('config:setApiKey', (_evt, apiKey) => {
    appConfig.anthropicApiKey = apiKey;
    saveConfig(appConfig);
    return { ok: true };
  });

  ipcMain.handle('config:hasApiKey', () => {
    return !!appConfig.anthropicApiKey;
  });

  ipcMain.handle('config:getUiTheme', () => {
    return appConfig.uiTheme === 'light' ? 'light' : 'dark';
  });

  ipcMain.handle('config:setUiTheme', (_evt, theme) => {
    appConfig.uiTheme = theme === 'light' ? 'light' : 'dark';
    saveConfig(appConfig);
    return { ok: true, uiTheme: appConfig.uiTheme };
  });

  // ── Saved Credentials IPC ──────────────────────────────────────
  ipcMain.handle('config:getSavedCredentials', (_evt, siteKey) => {
    try {
      // Support per-site credentials (fall back to legacy global _savedCred)
      const perSite = appConfig._siteCredentials || {};
      const cred = (siteKey && perSite[siteKey]) || appConfig._savedCred;
      if (!cred || !cred.u) return { ok: false };
      const u = Buffer.from(cred.u, 'base64').toString('utf8');
      const p = Buffer.from(cred.p, 'base64').toString('utf8');
      return { ok: true, username: u, password: p };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('config:saveCredentials', (_evt, username, password, siteKey) => {
    try {
      const entry = {
        u: Buffer.from(String(username || '')).toString('base64'),
        p: Buffer.from(String(password || '')).toString('base64'),
        ts: Date.now(),
      };
      if (siteKey) {
        if (!appConfig._siteCredentials) appConfig._siteCredentials = {};
        appConfig._siteCredentials[siteKey] = entry;
      }
      // Also save as legacy global fallback
      appConfig._savedCred = entry;
      saveConfig(appConfig);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('config:clearCredentials', (_evt, siteKey) => {
    if (siteKey && appConfig._siteCredentials) {
      delete appConfig._siteCredentials[siteKey];
    } else {
      delete appConfig._savedCred;
      delete appConfig._siteCredentials;
    }
    saveConfig(appConfig);
    return { ok: true };
  });

  ipcMain.handle('config:listSavedCredentials', () => {
    try {
      const result = {};
      const perSite = appConfig._siteCredentials || {};
      for (const [key, cred] of Object.entries(perSite)) {
        if (cred && cred.u) {
          const u = Buffer.from(cred.u, 'base64').toString('utf8');
          result[key] = { username: u, savedAt: cred.ts };
        }
      }
      return { ok: true, sites: result };
    } catch {
      return { ok: false, sites: {} };
    }
  });

  // ── Custom Profiles IPC ─────────────────────────────────────────
  ipcMain.handle('profiles:getAll', () => {
    return loadCustomProfiles();
  });

  ipcMain.handle('profiles:save', (_evt, key, profileData) => {
    const profiles = loadCustomProfiles();
    profiles[key] = profileData;
    const ok = saveCustomProfiles(profiles);
    return { ok, total: Object.keys(profiles).length };
  });

  ipcMain.handle('profiles:delete', (_evt, key) => {
    const profiles = loadCustomProfiles();
    delete profiles[key];
    const ok = saveCustomProfiles(profiles);
    return { ok, total: Object.keys(profiles).length };
  });

  ipcMain.handle('profiles:list', () => {
    const profiles = loadCustomProfiles();
    return Object.keys(profiles).map(key => ({
      key,
      agency: profiles[key].agency || key.split('/')[0],
      category: profiles[key].category || key.split('/')[1],
      level: profiles[key].level || key.split('/')[2],
      fieldCount: countProfileFields(profiles[key].data || {}),
      savedAt: profiles[key].savedAt,
    }));
  });

  function countProfileFields(data) {
    let count = 0;
    if (!data) return 0;
    for (const secData of Object.values(data)) {
      const d = secData?.alta || secData;
      count += (d?.checkboxes?.length || 0)
        + Object.keys(d?.selects || {}).length
        + Object.keys(d?.texts || d?.fields || {}).length
        + Object.keys(d?.radios || {}).length
        + Object.keys(d?.checkbox_ng_models || {}).length;
    }
    return count;
  }

  // ── Autofill Profile Builder IPC ─────────────────────────────
  ipcMain.handle('autofillProfiles:getStore', () => loadAutofillStore());

  ipcMain.handle('autofillProfiles:saveStore', (_evt, store) => ({ ok: saveAutofillStore(store) }));

  ipcMain.handle('autofillProfiles:saveProfile', (_evt, profile) => {
    const store = loadAutofillStore();
    const now = new Date().toISOString();
    const actor = autofillActorLabel();
    const idx = store.profiles.findIndex((p) => p.id === profile.id);
    if (idx === -1) {
      profile.createdAt = profile.createdAt || now;
      profile.createdBy = profile.createdBy || actor;
      profile.updatedAt = now;
      profile.updatedBy = actor;
      store.profiles.push(profile);
    } else {
      const prev = store.profiles[idx];
      store.profiles[idx] = {
        ...prev,
        ...profile,
        createdAt: prev.createdAt,
        createdBy: prev.createdBy,
        updatedAt: now,
        updatedBy: actor,
      };
    }
    const saved = store.profiles.find((p) => p.id === profile.id);
    autofillEngineDb.saveProfile(saved);
    return { ok: true, profile: saved };
  });

  ipcMain.handle('autofillProfiles:deleteProfile', (_evt, id) => {
    autofillEngineDb.deleteProfileEngine(id);
    return { ok: true };
  });

  ipcMain.handle('autofillProfiles:duplicate', (_evt, id) => {
    const store = loadAutofillStore();
    const src = store.profiles.find((p) => p.id === id);
    if (!src) return { ok: false, error: 'not_found' };
    const now = new Date().toISOString();
    const actor = autofillActorLabel();
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = crypto.randomUUID();
    copy.name = `${src.name || 'Profile'} (copy)`;
    copy.createdAt = now;
    copy.createdBy = actor;
    copy.updatedAt = now;
    copy.updatedBy = actor;
    copy.isDefault = false;
    autofillEngineDb.saveProfile(copy);
    return { ok: true, profile: copy };
  });

  ipcMain.handle('autofillProfiles:setDefaultForWorkflow', (_evt, workflow, profileId) => {
    autofillEngineDb.setWorkflowDefault(workflow, profileId || null);
    return { ok: true };
  });

  ipcMain.handle('autofillProfiles:setOwnerDisplayName', (_evt, name) => {
    appConfig.ownerDisplayName = typeof name === 'string' ? name.trim() : '';
    saveConfig(appConfig);
    return { ok: true };
  });

  ipcMain.handle('autofillProfiles:getActor', () => ({
    username: (() => {
      try {
        return os.userInfo().username;
      } catch {
        return '';
      }
    })(),
    displayName: appConfig.ownerDisplayName || '',
  }));

  ipcMain.handle('autofillProfiles:exportFile', async (_evt, jsonString) => {
    try {
      const r = await dialog.showSaveDialog(mainWindow, {
        defaultPath: 'autofill-profiles.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(r.filePath, jsonString, 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

    ipcMain.handle('autofillProfiles:importFile', async () => {
      try {
        const r = await dialog.showOpenDialog(mainWindow, {
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
        const text = fs.readFileSync(r.filePaths[0], 'utf8');
        return { ok: true, text, path: r.filePaths[0] };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
    coreIpcRegistered = true;
  }

  if (!serviceIpcRegistered) {
    registerAiAssistantIpc(ipcMain, { getApiKey: () => appConfig.anthropicApiKey });
    registerCopilotIpc(ipcMain, { getApiKey: () => appConfig.anthropicApiKey });
    registerKinnserSummaryCopilotIpc(ipcMain, { getApiKey: () => appConfig.anthropicApiKey });
    // Self-improving AI diagnostics
    ipcMain.handle('ai:getCacheStats', () => ({
      cache: responseCache.getCacheStats(),
      goldenExamples: goldenExamples.getGoldenExamplesStats(),
      prefetch: prefetchEngine.getPrefetchStats(),
    }));
    ipcMain.handle('ai:clearPrefetches', () => {
      prefetchEngine.clearAllPrefetches();
      return { ok: true };
    });
    serviceIpcRegistered = true;
  }

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // #region agent log
    debugLog('electron/main.cjs:setWindowOpenHandler', 'windowOpenHandler invoked', { url: String(url || '').slice(0, 300) }, 'H6');
    // #endregion
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // #region agent log
    debugLog('electron/main.cjs:did-fail-load', 'webContents did-fail-load', { errorCode, errorDescription: String(errorDescription || ''), validatedURL: String(validatedURL || '').slice(0, 300), isMainFrame: !!isMainFrame }, 'H7');
    // #endregion
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    // #region agent log
    debugLog('electron/main.cjs:render-process-gone', 'webContents render-process-gone', { reason: String(details?.reason || ''), exitCode: Number(details?.exitCode || 0) }, 'H8');
    // #endregion
  });
  mainWindow.webContents.on('did-navigate', (_e, url) => {
    // #region agent log
    debugLog('electron/main.cjs:did-navigate', 'webContents did-navigate', { url: String(url || '').slice(0, 300) }, 'H6');
    // #endregion
  });
}

process.on('uncaughtException', (err) => {
  // #region agent log
  debugLog('electron/main.cjs:uncaughtException', 'Main process uncaught exception', { name: String(err && err.name || ''), message: String(err && err.message || err || '').slice(0, 400) }, 'H0');
  // #endregion
});

// ── SSL cert handling for Ultra HHC / Kinnser / Alta ────────────
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.includes('ultrahhc.com') || url.includes('kinnser.net') || url.includes('vttecs.com')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

app.whenReady().then(async () => {
  try {
    await autofillEngineDb.initAutofillEngineDb(app.getPath('userData'));
    // Wire self-improving AI modules to the DB
    const rawDb = autofillEngineDb.getRawDb();
    if (rawDb) {
      responseCache.setDb(rawDb);
      goldenExamples.setDb(rawDb);
    }
    const pruned = responseCache.pruneCache();
    if (pruned > 0) console.log(`[ResponseCache] Pruned ${pruned} stale entries on startup`);
  } catch (e) {
    console.error('Autofill engine DB init failed:', e);
  }

  // ── Ultra HHC / Kinnser / Alta session: strip X-Frame-Options ──
  const ultraSession = session.fromPartition('persist:ultrahhc');

  ultraSession.setCertificateVerifyProc((request, callback) => {
    if (request.hostname.includes('ultrahhc.com') || request.hostname.includes('kinnser.net') || request.hostname.includes('vttecs.com')) {
      callback(0);
    } else {
      callback(-3);
    }
  });

  ultraSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'x-frame-options') delete headers[key];
      if (key.toLowerCase() === 'content-security-policy') {
        if (Array.isArray(headers[key])) {
          headers[key] = headers[key].map(v =>
            v.replace(/frame-ancestors[^;]*(;|$)/gi, '').trim()
          ).filter(Boolean);
          if (headers[key].length === 0) delete headers[key];
        }
      }
    }
    callback({ responseHeaders: headers });
  });

  createWindow();
});

// ── Focus window when launched again via protocol ───────────────
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
