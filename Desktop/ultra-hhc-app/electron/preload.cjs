const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  version: () => '1.0.0',
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text)
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },
  meds: {
    getBootstrapCode: () => ipcRenderer.invoke('meds:getBootstrapCode'),
    getAutofillCode: (entries, agency) => ipcRenderer.invoke('meds:getAutofillCode', entries, agency),
    parseText: (text) => ipcRenderer.invoke('meds:parseText', text),
    ocrImage: (imageDataUrl) => ipcRenderer.invoke('meds:ocrImage', imageDataUrl),
    pickImage: () => ipcRenderer.invoke('meds:pickImage'),
  },
  config: {
    getApiKey: () => ipcRenderer.invoke('config:getApiKey'),
    setApiKey: (apiKey) => ipcRenderer.invoke('config:setApiKey', apiKey),
    hasApiKey: () => ipcRenderer.invoke('config:hasApiKey'),
    getUiTheme: () => ipcRenderer.invoke('config:getUiTheme'),
    setUiTheme: (theme) => ipcRenderer.invoke('config:setUiTheme', theme),
    getSavedCredentials: (siteKey) => ipcRenderer.invoke('config:getSavedCredentials', siteKey),
    saveCredentials: (u, p, siteKey) => ipcRenderer.invoke('config:saveCredentials', u, p, siteKey),
    clearCredentials: (siteKey) => ipcRenderer.invoke('config:clearCredentials', siteKey),
    listSavedCredentials: () => ipcRenderer.invoke('config:listSavedCredentials'),
  },
  profiles: {
    getAll: () => ipcRenderer.invoke('profiles:getAll'),
    save: (key, data) => ipcRenderer.invoke('profiles:save', key, data),
    delete: (key) => ipcRenderer.invoke('profiles:delete', key),
    list: () => ipcRenderer.invoke('profiles:list'),
  },
  autofillProfiles: {
    getStore: () => ipcRenderer.invoke('autofillProfiles:getStore'),
    saveStore: (store) => ipcRenderer.invoke('autofillProfiles:saveStore', store),
    saveProfile: (profile) => ipcRenderer.invoke('autofillProfiles:saveProfile', profile),
    deleteProfile: (id) => ipcRenderer.invoke('autofillProfiles:deleteProfile', id),
    duplicate: (id) => ipcRenderer.invoke('autofillProfiles:duplicate', id),
    setDefaultForWorkflow: (workflow, profileId) =>
      ipcRenderer.invoke('autofillProfiles:setDefaultForWorkflow', workflow, profileId),
    setOwnerDisplayName: (name) => ipcRenderer.invoke('autofillProfiles:setOwnerDisplayName', name),
    getActor: () => ipcRenderer.invoke('autofillProfiles:getActor'),
    exportFile: (jsonString) => ipcRenderer.invoke('autofillProfiles:exportFile', jsonString),
    importFile: () => ipcRenderer.invoke('autofillProfiles:importFile'),
  },
  aiAgent: {
    suggest: (payload) => ipcRenderer.invoke('aiAgent:suggest', payload),
    recordFeedback: (row) => ipcRenderer.invoke('aiAgent:recordFeedback', row),
    bumpApply: (workflow, fieldKey) => ipcRenderer.invoke('aiAgent:bumpApply', workflow, fieldKey),
    bumpReject: (workflow, fieldKey) => ipcRenderer.invoke('aiAgent:bumpReject', workflow, fieldKey),
    getLogs: () => ipcRenderer.invoke('aiAgent:getLogs'),
    getMemory: (workflow) => ipcRenderer.invoke('aiAgent:getMemory', workflow),
  },
  copilot: {
    ingest: (payload) => ipcRenderer.invoke('copilot:ingestEvents', payload),
    refresh: (payload) => ipcRenderer.invoke('copilot:refresh', payload),
    feedback: (row) => ipcRenderer.invoke('copilot:feedback', row),
    getLocks: (workflow) => ipcRenderer.invoke('copilot:getLocks', workflow),
    setLock: (workflow, fieldKey, locked) => ipcRenderer.invoke('copilot:setLock', workflow, fieldKey, locked),
    log: (event, detail) => ipcRenderer.invoke('copilot:log', event, detail),
    getNoteContext: (payload) => ipcRenderer.invoke('copilot:getNoteContext', payload),
    setNoteContext: (payload) => ipcRenderer.invoke('copilot:setNoteContext', payload),
  },
  kinnserSummary: {
    generate: (payload) => ipcRenderer.invoke('kinnserSummary:generate', payload),
    feedback: (row) => ipcRenderer.invoke('kinnserSummary:feedback', row),
    getLogs: () => ipcRenderer.invoke('kinnserSummary:getLogs'),
    recordActivity: (payload) => ipcRenderer.invoke('kinnserSummary:recordActivity', payload),
    fieldMemory: (payload) => ipcRenderer.invoke('kinnserSummary:fieldMemory', payload),
    suggestLine: (payload) => ipcRenderer.invoke('kinnserSummary:suggestLine', payload),
    prefetchField: (payload) => ipcRenderer.invoke('kinnserSummary:prefetchField', payload),
    onStreamChunk: (callback) => ipcRenderer.on('kinnserSummary:streamChunk', (_evt, data) => callback(data)),
    offStreamChunk: () => ipcRenderer.removeAllListeners('kinnserSummary:streamChunk'),
  },
  aiStats: {
    getCacheStats: () => ipcRenderer.invoke('ai:getCacheStats'),
    clearPrefetches: () => ipcRenderer.invoke('ai:clearPrefetches'),
  },
});
