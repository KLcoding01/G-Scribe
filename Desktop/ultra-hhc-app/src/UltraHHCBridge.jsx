/**
 * UltraHHCBridge.jsx (Standalone Electron App)
 * Always uses <webview> — this app only runs inside Electron.
 * Medications injection via IPC to main process.
 */
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { makeAppStyles } from './lib/orbitAppTheme.js';
import {
  AGENCIES, CATEGORIES, LEVELS,
  loadProfile, getSections, getAvailableLevels,
  mergeCustomProfiles, getAgencies,
} from './lib/profileLoader.js';
import { getInjectorBootstrapCode, getAutofillCode } from './lib/contentInjector.js';
import { getCopilotTrackerBootstrapCode } from './lib/copilotTrackerScript.js';
import {
  getKinnserSummaryCopilotBootstrapCode,
  getKinnserSummaryCaptureCode,
} from './lib/kinnserSummaryCopilotScript.js';
import {
  getKinnserMobilityBulkBootstrapCode,
  getKinnserMobilityBulkSetEnabledCode,
} from './lib/kinnserMobilityBulkScript.js';
import { useKinnserSummaryFloatBridge } from './hooks/useKinnserSummaryFloatBridge.js';
import { kinnserSummaryFieldMemory } from './lib/kinnserSummaryClient.js';
import { getScraperCode, getSnapshotCode, formatForBundle } from './lib/profileScraper.js';
import {
  mergeAutofillProfile,
  sectionPayloadForInject,
  countFillableFields,
} from './lib/autofillProfileMerge.js';
import AutofillProfileBuilder from './components/AutofillProfileBuilder.jsx';
import AiAutofillAgentPanel from './components/AiAutofillAgentPanel.jsx';
import AssistantDrawer from './components/AssistantDrawer.jsx';
import LiveCopilotPanel from './components/LiveCopilotPanel.jsx';
import FloatingPanel from './components/FloatingPanel.jsx';
import { liveCopilotSubtitleForSite } from './lib/kinnserAgents.js';

// ── Orbit-style SVG Icons ──────────────────────────────────────
const Icon = ({ d, size = 20, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const IconSections = ({ color }) => <Icon color={color} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 5h6M9 14h6M9 10h6" />;
const IconMeds = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5A2.25 2.25 0 008.25 22.5h7.5A2.25 2.25 0 0018 20.25V3.75A2.25 2.25 0 0015.75 1.5H13.5" />
    <path d="M10.5 1.5v3h3v-3" />
    <path d="M12 11v6M9 14h6" />
  </svg>
);
const IconScan = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 8v1M12 15v1M8 12h1M15 12h1" />
  </svg>
);
const IconScrape = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
  </svg>
);
const IconProfiles = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
  </svg>
);
const IconLog = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
  </svg>
);
const IconSettings = ({ color }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
);
const IconCollapse = ({ color }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 19l-7-7 7-7M18 19l-7-7 7-7" />
  </svg>
);
const IconExpand = ({ color }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 5l7 7-7 7M6 5l7 7-7 7" />
  </svg>
);
// Toolbar & button icons
const IconBolt = ({ color }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);
const IconChat = ({ color }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>
);
const IconPlay = ({ color }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={color || 'currentColor'} stroke="none">
    <path d="M8 5v14l11-7z" />
  </svg>
);
const IconCheck = ({ color }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);
const IconDiamond = ({ color }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={color || 'currentColor'} stroke="none">
    <path d="M12 2l4 8-4 8-4-8z" />
  </svg>
);
const IconArrowUpDown = ({ color }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 3v18M7 3l-4 4M7 3l4 4M17 21V3M17 21l-4-4M17 21l4-4" />
  </svg>
);
const IconMoon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
  </svg>
);
const IconSun = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
  </svg>
);
const SITE_KINNSER = 'Kinnser';

const SITES = {
  'Ultra HHC':   { url: 'https://west.ultrahhc.com', short: 'Ultra', color: '#3b82f6' },
  'Kinnser':     { url: 'https://www.kinnser.net',    short: 'Kinnser', color: '#8b5cf6' },
  'Alta':        { url: 'https://alta.vttecs.com',    short: 'Alta', color: '#f59e0b' },
};
const SITE_NAMES = Object.keys(SITES);
const DEFAULT_SITE = 'Ultra HHC';

export default function UltraHHCBridge() {
  const webviewRef = useRef(null);
  const [site, setSite] = useState(DEFAULT_SITE);
  const currentSite = SITES[site] || SITES[DEFAULT_SITE];
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [injected, setInjected] = useState(false);
  const [medsInjected, setMedsInjected] = useState(false);

  const [agency, setAgency] = useState('');
  const [category, setCategory] = useState('SOC Oasis');
  const [level, setLevel] = useState('SBA');
  const [availLevels, setAvailLevels] = useState(LEVELS);
  const [sections, setSections] = useState(null);
  const [sectionNames, setSectionNames] = useState([]);
  const [expandedSection, setExpandedSection] = useState(null);
  const [toast, setToast] = useState(null);
  const [log, setLog] = useState([]);
  const [filling, setFilling] = useState(false);
  const [filledSections, setFilledSections] = useState(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const sidebarDragRef = useRef(null);

  // Persistent position/size refs for floating panels (survive close/reopen)
  const medsPosRef = useRef(null);
  const medsSizeRef = useRef(null);
  const scanPosRef = useRef(null);
  const scanSizeRef = useRef(null);
  const scraperPosRef = useRef(null);
  const scraperSizeRef = useRef(null);
  const profilesPosRef = useRef(null);
  const profilesSizeRef = useRef(null);
  const logPosRef = useRef(null);
  const logSizeRef = useRef(null);
  const settingsPosRef = useRef(null);
  const settingsSizeRef = useRef(null);
  const [tab, setTab] = useState('sections');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [liveCopilotOpen, setLiveCopilotOpen] = useState(false);
  const [copilotTrackerReady, setCopilotTrackerReady] = useState(false);
  const [kinnserSummaryReady, setKinnserSummaryReady] = useState(false);
  const [kinnserMobilityBulkReady, setKinnserMobilityBulkReady] = useState(false);
  /** In-page float near caret / mouse (Kinnser summary fields) */
  const [summaryFloatEnabled, setSummaryFloatEnabled] = useState(true);
  /** Auto suggest/automation on focus after learning threshold */
  const [autoSuggestEnabled, setAutoSuggestEnabled] = useState(true);
  /** Auto-apply threshold for Kinnser one-line suggestion confidence */
  const [autoApplyConfidence, setAutoApplyConfidence] = useState(0.9);
  /** Hover palette: bulk-set assist level + Factors for Bed Mobility / Transfer / Gait blocks */
  const [mobilityBulkEnabled, setMobilityBulkEnabled] = useState(true);
  const [autofillStore, setAutofillStore] = useState(null);
  const [applyProfileId, setApplyProfileId] = useState('');

  // Meds state
  const [medsText, setMedsText] = useState('');
  const [medsEntries, setMedsEntries] = useState([]);
  const [medsInputMode, setMedsInputMode] = useState('text');
  
  // OCR state
  const [ocrImages, setOcrImages] = useState([]);
  const [ocrProcessing, setOcrProcessing] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [copilotRules, setCopilotRules] = useState([]);
  const [agentChatOpen, setAgentChatOpen] = useState(false);
  const [agentChatMessages, setAgentChatMessages] = useState([]);
  const [agentChatInput, setAgentChatInput] = useState('');
  const [ruleFieldMatch, setRuleFieldMatch] = useState('vital');
  const [ruleCondition, setRuleCondition] = useState('(ctx.vitals.bpSystolic >= 180) || (ctx.vitals.bpDiastolic >= 90)');
  const [ruleAppendText, setRuleAppendText] = useState('MD and agency made aware due to elevated vitals. Pt is asymptomatic and free to continue with PT session.');
  const [ruleTestResult, setRuleTestResult] = useState('');
  const [uiTheme, setUiTheme] = useState('light');
  const [onLoginPage, setOnLoginPage] = useState(false);
  const [credentialsSaved, setCredentialsSaved] = useState(false);
  const [savedCredSites, setSavedCredSites] = useState({});
  const S = useMemo(() => makeAppStyles(uiTheme), [uiTheme]);

  // Dynamic agencies (includes custom saved profiles)
  const [agencyList, setAgencyList] = useState(AGENCIES);

  // Scraper state
  const [scraperResult, setScraperResult] = useState(null);
  const [scraping, setScraping] = useState(false);
  const [scraperWrapAlta, setScraperWrapAlta] = useState(true);
  const [scraperExpandedSec, setScraperExpandedSec] = useState(null);
  const [scraperCopied, setScraperCopied] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [snapshotInfo, setSnapshotInfo] = useState(null);
  const [scraperMode, setScraperMode] = useState('diff'); // 'diff' or 'full'

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 2500);
  }, []);
  const addLog = useCallback((msg) => {
    setLog(prev => [...prev.slice(-200), { time: new Date().toLocaleTimeString(), msg }]);
  }, []);

  const toggleUiTheme = useCallback(async () => {
    const next = uiTheme === 'dark' ? 'light' : 'dark';
    setUiTheme(next);
    try {
      if (window.desktop?.config?.setUiTheme) await window.desktop.config.setUiTheme(next);
    } catch (_) {}
  }, [uiTheme]);

  // Check API key on mount
  useEffect(() => {
    if (window.desktop?.config?.getUiTheme) {
      window.desktop.config.getUiTheme().then((t) => setUiTheme(t === 'light' ? 'light' : 'dark'));
    }
    if (window.desktop?.config?.hasApiKey) {
      window.desktop.config.hasApiKey().then(setHasApiKey);
    }
    // Load custom profiles from disk
    if (window.desktop?.profiles?.getAll) {
      window.desktop.profiles.getAll().then(custom => {
        if (custom && Object.keys(custom).length > 0) {
          mergeCustomProfiles(custom);
          setAgencyList(getAgencies());
          addLog('Loaded ' + Object.keys(custom).length + ' custom profiles');
        }
      });
    }
    if (window.desktop?.autofillProfiles?.getStore) {
      window.desktop.autofillProfiles.getStore().then(setAutofillStore);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('kinnser_copilot_rules_v1');
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) setCopilotRules(arr);
    } catch (_) {}
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (site !== SITE_KINNSER) return;
        const r = await kinnserSummaryFieldMemory({ op: 'rules_list_all' });
        if (!r?.ok || !Array.isArray(r.rules)) return;
        const mapped = r.rules.map((x) => ({
          id: String(x.id || ''),
          mode: String(x.mode || ''),
          fieldKey: String(x.fieldKey || ''),
          fieldMatch: String(x.fieldMatch || ''),
          condition: String(x.condition || 'true'),
          appendText: String(x.appendText || ''),
          instruction: String(x.instruction || ''),
          enabled: x.enabled !== false,
        }));
        if (mapped.length) setCopilotRules(mapped);
      } catch (_) {}
    })();
  }, [site]);

  useEffect(() => {
    try {
      localStorage.setItem('kinnser_copilot_rules_v1', JSON.stringify(copilotRules || []));
    } catch (_) {}
  }, [copilotRules]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('kinnser_auto_apply_confidence');
      if (!raw) return;
      const n = Number(raw);
      if (Number.isFinite(n)) {
        setAutoApplyConfidence(Math.min(0.98, Math.max(0.5, n)));
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('kinnser_auto_suggest_enabled');
      if (raw === '0') setAutoSuggestEnabled(false);
      else if (raw === '1') setAutoSuggestEnabled(true);
    } catch (_) {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('kinnser_auto_apply_confidence', String(autoApplyConfidence));
    } catch (_) {}
  }, [autoApplyConfidence]);

  useEffect(() => {
    try {
      localStorage.setItem('kinnser_auto_suggest_enabled', autoSuggestEnabled ? '1' : '0');
    } catch (_) {}
  }, [autoSuggestEnabled]);

  const addQuickCopilotRule = useCallback((rule) => {
    // Handle deletion
    if (rule?._delete) {
      setCopilotRules((prev) => {
        const arr = Array.isArray(prev) ? prev : [];
        const rid = String(rule?.id || '').trim();
        return arr.filter((r) => String(r?.id || '') !== rid);
      });
      return true;
    }
    let added = true;
    setCopilotRules((prev) => {
      const arr = Array.isArray(prev) ? prev : [];
      const rid = String(rule?.id || '').trim();
      const exists = arr.some((r) => rid && String(r?.id || '') === rid);
      if (exists) {
        added = false;
        return arr;
      }
      const nextRule = {
        id: rid || String(Date.now()),
        mode: rule?.mode || '',
        fieldKey: String(rule?.fieldKey || ''),
        fieldMatch: String(rule?.fieldMatch || ''),
        condition: String(rule?.condition || 'true'),
        appendText: String(rule?.appendText || ''),
        instruction: String(rule?.instruction || ''),
        enabled: rule?.enabled !== false,
      };
      return [...arr, nextRule];
    });
    return added;
  }, []);

  // ── Webview lifecycle ─────────────────────────────────────────
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onReady = () => { setReady(true); setLoading(false); setLoadError(''); setInjected(false); setMedsInjected(false); addLog('Page loaded'); };
    const onLoading = () => { setLoading(true); setInjected(false); setMedsInjected(false); setLoadError(''); };
    const onFail = (e) => {
      if (e.errorCode === -3 || e.isMainFrame === false) return;
      setLoading(false);
      setLoadError('Error ' + e.errorCode + ': ' + (e.errorDescription || 'unknown'));
      addLog('Load error: ' + (e.errorDescription || e.errorCode));
    };
    wv.addEventListener('dom-ready', onReady);
    wv.addEventListener('did-start-loading', onLoading);
    wv.addEventListener('did-fail-load', onFail);
    try { if (wv.getURL && wv.getURL() && !wv.isLoading()) { onReady(); } } catch {}
    const timeout = setTimeout(() => { setLoading(false); setReady(true); addLog('Timeout — cleared overlay'); }, 5000);
    return () => {
      wv.removeEventListener('dom-ready', onReady);
      wv.removeEventListener('did-start-loading', onLoading);
      wv.removeEventListener('did-fail-load', onFail);
      clearTimeout(timeout);
    };
  }, [addLog]);

  // ── Site switching ─────────────────────────────────────────────

  // ── Auto-login: detect login page, fill saved credentials, capture on login ──
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !ready) return;
    let credPollId = null;
    let loginCheckId = null;
    const siteKey = site; // per-site credential key

    // Strict login page detection: password field must be visible AND
    // the page must look like a login form (few total inputs, has a submit/login button, etc.)
    const LOGIN_DETECT_SCRIPT = `(() => {
      var pw = document.querySelector('input[type="password"]');
      if (!pw) return false;
      // Password field must be visible
      var pwRect = pw.getBoundingClientRect();
      if (pwRect.width === 0 || pwRect.height === 0) return false;
      var pwStyle = window.getComputedStyle(pw);
      if (pwStyle.display === 'none' || pwStyle.visibility === 'hidden') return false;
      // Must have a username-like field nearby
      var un = document.querySelector('input[name*="user" i], input[id*="user" i], input[type="email"], input[name*="login" i], input[id*="login" i], input[name*="email" i]');
      if (!un) return false;
      // Login pages have very few visible inputs (typically 2-4: username, password, maybe remember-me)
      var allVisible = document.querySelectorAll('input:not([type="hidden"]), textarea, select');
      var visCount = 0;
      for (var i = 0; i < allVisible.length; i++) {
        var r = allVisible[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) visCount++;
      }
      // If there are more than 10 visible form fields, this is NOT a login page
      if (visCount > 10) return false;
      return true;
    })()`;

    const checkForLogin = async () => {
      try {
        const isLogin = await wv.executeJavaScript(LOGIN_DETECT_SCRIPT);
        if (!isLogin) {
          setOnLoginPage(false);
          setCredentialsSaved(false);
          return;
        }
        setOnLoginPage(true);

        // Check if we already have saved credentials for this site
        const cred = await window.desktop?.config?.getSavedCredentials?.(siteKey);
        if (cred?.ok && cred.username && cred.password) {
          setCredentialsSaved(true);
          // Auto-fill saved credentials
          const escaped = JSON.stringify({ u: cred.username, p: cred.password });
          await wv.executeJavaScript(`(() => {
            var c = ${escaped};
            var pw = document.querySelector('input[type="password"]');
            var un = document.querySelector('input[name*="user" i], input[id*="user" i], input[type="email"], input[name*="login" i], input[id*="login" i], input[name*="email" i]');
            if (un && !un.value) { un.value = c.u; un.dispatchEvent(new Event('input',{bubbles:true})); un.dispatchEvent(new Event('change',{bubbles:true})); }
            if (pw && !pw.value) { pw.value = c.p; pw.dispatchEvent(new Event('input',{bubbles:true})); pw.dispatchEvent(new Event('change',{bubbles:true})); }
            return 'filled';
          })()`);
          addLog('Auto-filled saved credentials for ' + siteKey);
        }
      } catch {}
    };

    // Check immediately and re-check after navigations
    checkForLogin();
    loginCheckId = setInterval(async () => {
      try {
        const isLogin = await wv.executeJavaScript(LOGIN_DETECT_SCRIPT);
        setOnLoginPage(isLogin);
        if (!isLogin) setCredentialsSaved(false);
      } catch {}
    }, 3000);

    return () => {
      if (credPollId) clearInterval(credPollId);
      if (loginCheckId) clearInterval(loginCheckId);
    };
  }, [ready, site, addLog]);

  // Save credentials handler (called from the login page UI)
  const saveLoginCredentials = useCallback(async () => {
    const wv = webviewRef.current;
    if (!wv) return;
    try {
      const vals = await wv.executeJavaScript(`(() => {
        var pw = document.querySelector('input[type="password"]');
        var un = document.querySelector('input[name*="user" i], input[id*="user" i], input[type="email"], input[name*="login" i], input[id*="login" i], input[name*="email" i]');
        if (!pw || !un) return null;
        var u = (un.value || '').trim();
        var p = (pw.value || '').trim();
        if (u && p && p.length >= 2) return { u: u, p: p };
        return null;
      })()`);
      if (vals?.u && vals?.p) {
        await window.desktop?.config?.saveCredentials?.(vals.u, vals.p, site);
        setCredentialsSaved(true);
        addLog('Credentials saved for ' + site);
      }
    } catch {}
  }, [site, addLog]);

  const clearLoginCredentials = useCallback(async () => {
    await window.desktop?.config?.clearCredentials?.(site);
    setCredentialsSaved(false);
    addLog('Credentials cleared for ' + site);
  }, [site, addLog]);

  // Load saved credential sites list for settings panel
  useEffect(() => {
    window.desktop?.config?.listSavedCredentials?.().then((res) => {
      if (res?.ok) setSavedCredSites(res.sites || {});
    }).catch(() => {});
  }, [credentialsSaved]);

  const switchSite = useCallback((newSite) => {
    if (newSite === site) return;
    const s = SITES[newSite];
    if (!s) return;
    setSite(newSite);
    setInjected(false);
    setMedsInjected(false);
    setFilledSections(new Set());
    setScraperResult(null);
    setHasSnapshot(false);
    setSnapshotInfo(null);
    setLoading(true);
    setLoadError('');
    addLog('Switching to ' + newSite + ' → ' + s.url);
    const wv = webviewRef.current;
    if (wv?.loadURL) {
      wv.loadURL(s.url);
    }
  }, [site, addLog]);

  // ── Auto-inject form filler ───────────────────────────────────
  useEffect(() => {
    if (!ready || injected) return;
    const wv = webviewRef.current;
    if (!wv || !wv.executeJavaScript) return;
    (async () => {
      try {
        await new Promise(r => setTimeout(r, 800));
        const result = await wv.executeJavaScript(getInjectorBootstrapCode());
        setInjected(true);
        addLog('Injector: ' + result);
      } catch (e) { addLog('Inject error: ' + e.message); }
    })();
  }, [ready, injected, addLog]);

  useEffect(() => {
    if (!injected) {
      setCopilotTrackerReady(false);
      setKinnserSummaryReady(false);
      setKinnserMobilityBulkReady(false);
    }
  }, [injected]);

  useEffect(() => {
    if (site !== SITE_KINNSER) {
      setKinnserSummaryReady(false);
      setKinnserMobilityBulkReady(false);
    }
    if (site === SITE_KINNSER) {
      setAssistantOpen(false);
      setLiveCopilotOpen(false);
    }
  }, [site]);

  // ── Load profile ──────────────────────────────────────────────
  useEffect(() => {
    if (!agency || !category || !level) { setSections(null); setSectionNames([]); return; }
    setAvailLevels(getAvailableLevels(agency, category));
    const profile = loadProfile(agency, category, level);
    if (profile) {
      setSections(profile);
      const names = getSections(profile);
      setSectionNames(names);
      setExpandedSection(names[0] || null);
      addLog(`Profile: ${agency} / ${category} / ${level} (${names.length} sections)`);
    } else {
      setSections(null); setSectionNames([]);
      addLog(`No profile: ${agency} / ${category} / ${level}`);
    }
    setFilledSections(new Set());
  }, [agency, category, level, addLog]);

  const exec = useCallback(async (code) => {
    const wv = webviewRef.current;
    if (!wv || !wv.executeJavaScript) return null;
    try { return await wv.executeJavaScript(code); }
    catch (e) { addLog('Exec: ' + e.message); return null; }
  }, [addLog]);

  const agentChatSend = useCallback(async (message) => {
    if (!message?.trim()) return;
    const msg = message.trim();
    setAgentChatMessages((prev) => [...prev, { role: 'user', text: msg }]);
    setAgentChatMessages((prev) => [...prev, { role: 'agent', text: 'Working...' }]);
    setAgentChatInput('');
    try {
      const { getKinnserSummaryCaptureCode } = await import('./lib/kinnserSummaryCopilotScript.js');
      const { kinnserSummaryFieldMemory } = await import('./lib/kinnserSummaryClient.js');
      const cap = await exec(getKinnserSummaryCaptureCode());
      const snapshot = cap?.ok ? cap.snapshot : {};
      const activeRules = (Array.isArray(copilotRules) ? copilotRules : [])
        .filter((r) => r && r.enabled !== false)
        .map((r) => {
          if (String(r.mode || '') === 'no_patient_starter') return "Do not start with 'Patient' or 'Pt'.";
          if (String(r.mode || '') === 'instruction') return String(r.instruction || '').trim();
          return '';
        })
        .filter(Boolean)
        .slice(0, 10);
      const res = await kinnserSummaryFieldMemory({
        op: 'agent_chat',
        message: msg,
        snapshot,
        fieldRules: activeRules,
        fieldPurpose: '',
        fieldKey: '',
      });
      setAgentChatMessages((prev) => prev.filter((m) => m.text !== 'Working...'));
      if (res?.ok) {
        if (res.reply) {
          setAgentChatMessages((prev) => [...prev, { role: 'agent', text: res.reply }]);
        }
        if (Array.isArray(res.fills) && res.fills.length) {
          const { getKinnserSummaryApplyHostPayloadCode } = await import('./lib/kinnserSummaryCopilotScript.js');
          await exec(getKinnserSummaryApplyHostPayloadCode({ agentFills: res.fills }));
          showToast(`Agent filled ${res.fills.length} field(s)`, 'success');
        }
        if (res.draft) {
          setAgentChatMessages((prev) => [...prev, { role: 'agent', text: 'Draft generated — check the copilot panel to review and insert.' }]);
        }
      } else {
        setAgentChatMessages((prev) => [...prev, { role: 'agent', text: res?.error || 'Agent error' }]);
      }
    } catch (e) {
      setAgentChatMessages((prev) => prev.filter((m) => m.text !== 'Working...'));
      setAgentChatMessages((prev) => [...prev, { role: 'agent', text: 'Error: ' + String(e.message || e).slice(0, 200) }]);
    }
  }, [exec, copilotRules, showToast]);

  const learnFullNote = useCallback(async () => {
    try {
      const { getKinnserSummaryFullNoteCaptureCode } = await import('./lib/kinnserSummaryCopilotScript.js');
      const { kinnserSummaryFieldMemory } = await import('./lib/kinnserSummaryClient.js');
      showToast('Capturing all fields...', 'success');
      const cap = await exec(getKinnserSummaryFullNoteCaptureCode());
      if (!cap?.ok) {
        showToast('Capture failed: ' + (cap?.error || 'unknown'), 'error');
        return;
      }
      const filledFields = cap.fields.filter((f) =>
        (f.fieldType === 'textarea' && (f.value || '').trim().length > 3) ||
        (f.fieldType === 'input' && (f.value || '').trim().length > 0) ||
        (f.fieldType === 'checkbox' && f.checked) ||
        (f.fieldType === 'radio' && f.checked) ||
        (f.fieldType === 'select' && (f.value || '').trim().length > 0)
      );
      const res = await kinnserSummaryFieldMemory({
        op: 'learn_full_note',
        fields: filledFields,
        headings: cap.headings || [],
        pagePath: cap.path || '',
        capturedAt: cap.capturedAt,
        label: 'Training: ' + new Date().toLocaleString(),
      });
      if (res?.ok) {
        const msg = `Learned from ${res.totalFields} fields: ${res.learnedText} text, ${res.learnedCheckboxes} checkboxes, ${res.learnedSelects} dropdowns`;
        showToast(msg, 'success');
        setAgentChatMessages((prev) => [...prev, { role: 'agent', text: msg + '. The agent will use this to mimic your documentation style.' }]);
      } else {
        showToast('Learn failed: ' + (res?.error || ''), 'error');
      }
    } catch (e) {
      showToast('Error: ' + String(e.message || e).slice(0, 100), 'error');
    }
  }, [exec, showToast]);

  const testRuleNow = useCallback(async () => {
    if (site !== SITE_KINNSER || !exec) {
      setRuleTestResult('Rule test works on Kinnser only.');
      return;
    }
    const cond = String(ruleCondition || '').trim();
    if (!cond) {
      setRuleTestResult('Condition is empty.');
      return;
    }
    const cap = await exec(getKinnserSummaryCaptureCode());
    if (!cap?.ok || !cap?.snapshot) {
      setRuleTestResult('Could not capture current field/page context.');
      return;
    }
    const s = cap.snapshot || {};
    const fields = Array.isArray(s.fields) ? s.fields : [];
    const asNum = (v) => {
      const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    const vitals = { bpSystolic: null, bpDiastolic: null, heartRate: null, respirations: null, o2Sat: null, temperature: null };
    for (const f of fields) {
      if (!f) continue;
      const lab = `${f.label || ''} ${f.name || ''} ${f.id || ''}`.toLowerCase();
      const val = String(f.value || '').trim();
      if (!val) continue;
      if (vitals.heartRate == null && /heart\s*rate|pulse/.test(lab)) vitals.heartRate = asNum(val);
      if (vitals.respirations == null && /respir/.test(lab)) vitals.respirations = asNum(val);
      if (vitals.o2Sat == null && /o2|oxygen|sat/.test(lab)) vitals.o2Sat = asNum(val);
      if (vitals.temperature == null && /temp/.test(lab)) vitals.temperature = asNum(val);
      if (vitals.bpSystolic == null || vitals.bpDiastolic == null) {
        const m = val.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) {
          vitals.bpSystolic = Number(m[1]);
          vitals.bpDiastolic = Number(m[2]);
        }
      }
    }
    const ctx = {
      fieldPurpose: String(s?.focusedField?.fieldPurpose || s?.activeFieldPurpose || ''),
      vitals,
      text: String(s?.focusedField?.value || ''),
    };
    let ok = false;
    try {
      ok = !!new Function('ctx', `return (${cond});`)(ctx);
    } catch (e) {
      setRuleTestResult(`Condition error: ${String(e.message || e)}`);
      return;
    }
    const vitTxt = `BP=${vitals.bpSystolic ?? '?'} / ${vitals.bpDiastolic ?? '?'} HR=${vitals.heartRate ?? '?'} RR=${vitals.respirations ?? '?'} O2=${vitals.o2Sat ?? '?'} Temp=${vitals.temperature ?? '?'}`;
    setRuleTestResult((ok ? 'MATCH ✓' : 'No match') + ` · ${vitTxt}`);
  }, [site, exec, ruleCondition]);

  useEffect(() => {
    if (!ready || !injected || copilotTrackerReady) return;
    (async () => {
      try {
        await new Promise((r) => setTimeout(r, 400));
        const r = await exec(getCopilotTrackerBootstrapCode());
        if (r === 'COPILOT_INSTALLED' || r === 'COPILOT_ALREADY') setCopilotTrackerReady(true);
        addLog('Live Copilot tracker: ' + r);
      } catch (e) {
        addLog('Copilot tracker: ' + e.message);
      }
    })();
  }, [ready, injected, copilotTrackerReady, exec, addLog]);

  useEffect(() => {
    if (site !== SITE_KINNSER || !ready || !injected || kinnserSummaryReady) return;
    (async () => {
      try {
        await new Promise((r) => setTimeout(r, 350));
        const r = await exec(getKinnserSummaryCopilotBootstrapCode());
        if (r === 'SUMMARY_COPILOT_INSTALLED' || r === 'SUMMARY_COPILOT_ALREADY') setKinnserSummaryReady(true);
        addLog('Kinnser Live Copilot: ' + r);
      } catch (e) {
        addLog('Kinnser Live Copilot inject: ' + e.message);
      }
    })();
  }, [site, ready, injected, kinnserSummaryReady, exec, addLog]);

  useEffect(() => {
    if (site !== SITE_KINNSER || !ready || !injected || kinnserMobilityBulkReady) return;
    (async () => {
      try {
        await new Promise((r) => setTimeout(r, 400));
        const r = await exec(getKinnserMobilityBulkBootstrapCode());
        if (r === 'MOBILITY_BULK_INSTALLED' || r === 'MOBILITY_BULK_ALREADY') setKinnserMobilityBulkReady(true);
        addLog('Kinnser mobility bulk: ' + r);
      } catch (e) {
        addLog('Kinnser mobility bulk inject: ' + e.message);
      }
    })();
  }, [site, ready, injected, kinnserMobilityBulkReady, exec, addLog]);

  useEffect(() => {
    if (site !== SITE_KINNSER || !kinnserMobilityBulkReady || !exec) return;
    exec(getKinnserMobilityBulkSetEnabledCode(mobilityBulkEnabled));
  }, [site, kinnserMobilityBulkReady, mobilityBulkEnabled, exec]);

  useKinnserSummaryFloatBridge({
    site,
    siteKinnserName: SITE_KINNSER,
    kinnserSummaryReady,
    exec,
    hasApiKey,
    addLog,
    showToast,
    summaryFloatEnabled,
    autoSuggestEnabled,
    autoApplyMinConfidence: autoApplyConfidence,
    copilotRules,
    onAddQuickRule: addQuickCopilotRule,
  });

  const fillSection = useCallback(async (sectionName) => {
    if (!sections?.[sectionName]) return;
    const data = sections[sectionName];
    const sectionData = data.alta || data.dsl || data;
    setFilling(true);
    addLog('Filling: ' + sectionName);
    try {
      if (!injected) { await exec(getInjectorBootstrapCode()); setInjected(true); }
      const result = await exec(getAutofillCode(sectionData));
      if (result?.ok) {
        addLog('✅ ' + sectionName + ': ' + result.changed + ' fields');
        showToast('✅ ' + sectionName + ': ' + result.changed + ' fields', 'success');
        setFilledSections(prev => new Set([...prev, sectionName]));
      } else {
        addLog('⚠️ ' + sectionName + ': ' + (result?.error || 'failed'));
        showToast('⚠️ ' + sectionName + ' failed', 'error');
      }
    } catch (e) {
      addLog('❌ ' + sectionName + ': ' + e.message);
      showToast('❌ Error', 'error');
    }
    setFilling(false);
  }, [sections, injected, exec, addLog, showToast]);

  const fillAll = useCallback(async () => {
    if (!sections || sectionNames.length === 0) return;
    setFilling(true);
    for (const name of sectionNames) {
      await fillSection(name);
      await new Promise(r => setTimeout(r, 300));
    }
    showToast('Done! ' + sectionNames.length + ' sections', 'success');
    setFilling(false);
  }, [sections, sectionNames, fillSection, showToast]);

  useEffect(() => {
    if (!autofillStore?.profiles?.length) return;
    const def = autofillStore.defaultProfileIdByWorkflow?.[category];
    if (def && autofillStore.profiles.some((p) => p.id === def)) {
      setApplyProfileId(def);
      return;
    }
    const match = autofillStore.profiles.find((p) => p.workflowType === category);
    setApplyProfileId(match?.id || '');
  }, [category, autofillStore]);

  const refreshAutofillStore = useCallback(() => {
    if (window.desktop?.autofillProfiles?.getStore) {
      window.desktop.autofillProfiles.getStore().then(setAutofillStore);
    }
  }, []);

  const fillWithSavedProfile = useCallback(async () => {
    if (!applyProfileId) {
      showToast('Select a saved profile', 'error');
      return;
    }
    const profile = autofillStore?.profiles?.find((p) => p.id === applyProfileId);
    if (!profile) {
      showToast('Profile not found', 'error');
      return;
    }
    if (profile.workflowType !== category) {
      const ok = globalThis.confirm(
        `This profile is for "${profile.workflowType}" but the current category is "${category}". Apply anyway?`
      );
      if (!ok) return;
    }
    const base = loadProfile(profile.agency, profile.workflowType, profile.level);
    if (!base) {
      showToast('No base field map for this profile — check agency / workflow / level', 'error');
      return;
    }
    const { mergedSections, modesBySection } = mergeAutofillProfile(
      base,
      profile.fieldOverrides,
      profile.sectionSettings
    );
    const names = getSections(mergedSections);
    if (names.length === 0) {
      showToast('Nothing to fill for this profile', 'error');
      return;
    }
    setFilling(true);
    addLog('Applying saved profile: ' + profile.name);
    try {
      for (const name of names) {
        const payload = sectionPayloadForInject(name, mergedSections, modesBySection);
        if (!payload || countFillableFields(payload) === 0) continue;
        if (!injected) {
          await exec(getInjectorBootstrapCode());
          setInjected(true);
        }
        const result = await exec(getAutofillCode(payload));
        if (result?.ok) {
          addLog('✅ ' + name + ': ' + result.changed + ' fields (profile)');
          setFilledSections((prev) => new Set([...prev, name]));
        } else {
          addLog('⚠️ ' + name + ': ' + (result?.error || 'failed'));
        }
        await new Promise((r) => setTimeout(r, 280));
      }
      showToast('Profile applied: ' + profile.name, 'success');
    } catch (e) {
      addLog('❌ Profile apply: ' + e.message);
      showToast('Profile apply failed', 'error');
    }
    setFilling(false);
  }, [applyProfileId, autofillStore, category, injected, exec, addLog, showToast]);

  // ── Scraper Functions ──────────────────────────────────────────
  const takeSnapshot = useCallback(async () => {
    addLog('Taking snapshot...');
    try {
      if (!injected) { await exec(getInjectorBootstrapCode()); setInjected(true); }
      const result = await exec(getSnapshotCode());
      if (result?.ok) {
        setHasSnapshot(true);
        setSnapshotInfo(result);
        setScraperResult(null);
        addLog('✅ Snapshot: ' + result.total + ' elements captured');
        showToast('Snapshot taken — now fill the form', 'success');
      } else {
        addLog('⚠️ Snapshot failed');
        showToast('⚠️ Snapshot failed', 'error');
      }
    } catch (e) {
      addLog('❌ Snapshot error: ' + e.message);
      showToast('❌ Snapshot failed', 'error');
    }
  }, [injected, exec, addLog, showToast]);

  const scrapePage = useCallback(async () => {
    const useDiff = scraperMode === 'diff';
    if (useDiff && !hasSnapshot) {
      showToast('📸 Take a snapshot first!', 'error');
      return;
    }
    setScraping(true);
    setScraperResult(null);
    addLog('Scraping ' + (useDiff ? 'changes only' : 'full page') + '...');
    try {
      if (!injected) { await exec(getInjectorBootstrapCode()); setInjected(true); }
      const code = getScraperCode({ diff: useDiff, detectSections: true, wrapAlta: scraperWrapAlta });
      const result = await exec(code);
      if (result?.error === 'NO_SNAPSHOT') {
        showToast('📸 Take a snapshot first!', 'error');
        setScraping(false);
        return;
      }
      if (result?.meta) {
        setScraperResult(result);
        const total = result.meta.totalCheckboxes + result.meta.totalSelects + result.meta.totalTexts + result.meta.totalRadios + result.meta.totalNgModels;
        addLog('✅ Scraped: ' + total + ' ' + (useDiff ? 'changed' : 'total') + ' elements in ' + result.meta.sectionCount + ' sections');
        showToast('✅ ' + total + ' ' + (useDiff ? 'changes' : 'elements') + ' captured', 'success');
      } else {
        addLog('⚠️ Scrape returned no data');
        showToast('⚠️ No form data found', 'error');
      }
    } catch (e) {
      addLog('❌ Scrape error: ' + e.message);
      showToast('❌ Scrape failed', 'error');
    }
    setScraping(false);
  }, [injected, exec, addLog, showToast, scraperWrapAlta, scraperMode, hasSnapshot]);

  const getScrapedJson = useCallback(() => {
    if (!scraperResult) return '';
    const bundleData = formatForBundle(scraperResult, {
      agency: agency || 'New Agency',
      category: category || 'SOC Oasis',
      level: level || 'SBA',
      useSections: true,
    });
    return JSON.stringify(bundleData, null, 2);
  }, [scraperResult, agency, category, level]);

  const copyScrapedJson = useCallback(async () => {
    const json = getScrapedJson();
    if (!json) return;
    try {
      await navigator.clipboard.writeText(json);
      setScraperCopied(true);
      showToast('✅ Copied to clipboard', 'success');
      setTimeout(() => setScraperCopied(false), 2000);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = json; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      setScraperCopied(true);
      showToast('✅ Copied', 'success');
      setTimeout(() => setScraperCopied(false), 2000);
    }
  }, [getScrapedJson, showToast]);

  const downloadScrapedJson = useCallback(() => {
    const json = getScrapedJson();
    if (!json) return;
    const fname = [
      (agency || 'agency').toLowerCase().replace(/\s+/g, '_'),
      (category || 'category').toLowerCase().replace(/\s+/g, '_'),
      (level || 'level').toLowerCase(),
    ].join('_') + '.json';
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    URL.revokeObjectURL(url);
    showToast('✅ Downloaded ' + fname, 'success');
  }, [getScrapedJson, agency, category, level, showToast]);

  const saveScrapedProfile = useCallback(async () => {
    if (!scraperResult || !agency) {
      showToast('Select an agency first', 'error');
      return;
    }
    if (!window.desktop?.profiles?.save) {
      showToast('Profile save not available', 'error');
      return;
    }

    const agencyFolder = agency.toLowerCase().replace(/\s+/g, '_');
    const catKey = (category || 'SOC Oasis').toLowerCase().replace(/\s+/g, '_');
    const lvl = (level || 'SBA');
    const key = `${agencyFolder}/${catKey}/${lvl.toLowerCase()}`;

    const entry = {
      agency,
      agencyFolder,
      category: category || 'SOC Oasis',
      level: lvl,
      // scraperResult.sections already has alta wrapping if scraperWrapAlta was on
      data: scraperResult.sections && Object.keys(scraperResult.sections).length > 0
        ? scraperResult.sections
        : { __ungrouped__: scraperResult.flat },
      savedAt: new Date().toISOString(),
    };

    try {
      const result = await window.desktop.profiles.save(key, entry);
      if (result?.ok) {
        // Merge into runtime so it's usable right away
        mergeCustomProfiles({ [key]: entry });
        setAgencyList(getAgencies());
        addLog('✅ Saved: ' + key + ' (' + result.total + ' total custom profiles)');
        showToast('✅ Profile saved — ' + agency + ' / ' + category + ' / ' + lvl, 'success');
      } else {
        showToast('⚠️ Save failed', 'error');
      }
    } catch (e) {
      addLog('❌ Save error: ' + e.message);
      showToast('❌ Save failed', 'error');
    }
  }, [scraperResult, agency, category, level, addLog, showToast]);

  // ── Medications Functions (via IPC) ───────────────────────────
  const parseMedsFromText = useCallback(async () => {
    if (!window.desktop?.meds?.parseText) {
      addLog('Meds IPC not available');
      return [];
    }
    const entries = await window.desktop.meds.parseText(medsText);
    setMedsEntries(entries);
    addLog(`Parsed ${entries.length} medication entries`);
    return entries;
  }, [medsText, addLog]);

  const updateMedsEntry = useCallback((index, field, value) => {
    setMedsEntries(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }, []);

  const addMedsEntry = useCallback(() => {
    setMedsEntries(prev => [...prev, { date: '', name: '', freq: '', className: '', status: 'New' }]);
  }, []);

  const removeMedsEntry = useCallback((index) => {
    setMedsEntries(prev => prev.filter((_, i) => i !== index));
  }, []);

  // ── OCR Functions ─────────────────────────────────────────────
  const handlePickImage = useCallback(async () => {
    if (!window.desktop?.meds?.pickImage) return;
    const result = await window.desktop.meds.pickImage();
    if (result.ok && result.images) {
      const newImages = result.images.map((img, i) => ({
        dataUrl: img.dataUrl,
        fileName: img.fileName,
        id: Date.now() + i,
      }));
      setOcrImages(prev => [...prev, ...newImages]);
      addLog(`Added ${newImages.length} image(s)`);
    } else if (result.ok) {
      // Fallback for single image
      setOcrImages(prev => [...prev, { dataUrl: result.dataUrl, fileName: result.fileName, id: Date.now() }]);
      addLog('Image added: ' + result.fileName);
    }
  }, [addLog]);

  const handlePasteImage = useCallback(async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (ev) => {
          setOcrImages(prev => [...prev, { dataUrl: ev.target.result, fileName: 'pasted-image.png', id: Date.now() }]);
          addLog('Image pasted from clipboard');
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  }, [addLog]);

  const handleDropImage = useCallback((e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setOcrImages(prev => [...prev, { dataUrl: ev.target.result, fileName: file.name, id: Date.now() + Math.random() }]);
        addLog('Image dropped: ' + file.name);
      };
      reader.readAsDataURL(file);
    });
  }, [addLog]);

  const removeOcrImage = useCallback((id) => {
    setOcrImages(prev => prev.filter(img => img.id !== id));
  }, []);

  const clearAllImages = useCallback(() => {
    setOcrImages([]);
  }, []);

  const handleOCR = useCallback(async () => {
    if (ocrImages.length === 0 || !window.desktop?.meds?.ocrImage) return;
    
    setOcrProcessing(true);
    addLog(`Processing ${ocrImages.length} image(s) with AI...`);
    
    let allMedsText = '';
    let totalMeds = 0;
    
    try {
      for (let i = 0; i < ocrImages.length; i++) {
        const img = ocrImages[i];
        addLog(`Processing image ${i + 1}/${ocrImages.length}: ${img.fileName}`);
        
        const result = await window.desktop.meds.ocrImage(img.dataUrl);
        if (result.ok) {
          if (allMedsText) allMedsText += '\n';
          allMedsText += result.text;
          const lineCount = result.text.split('\n').filter(l => l.trim()).length;
          totalMeds += lineCount;
          addLog(`✅ Image ${i + 1}: ${lineCount} medications found`);
        } else {
          addLog('❌ Image ' + (i + 1) + ' failed: ' + result.error);
          if (result.error.includes('API key')) {
            setShowSettings(true);
            setOcrProcessing(false);
            return;
          }
        }
      }
      
      if (allMedsText) {
        setMedsText(allMedsText);
        setMedsInputMode('text');
        showToast(`✅ ${totalMeds} medications extracted from ${ocrImages.length} image(s)`, 'success');
        // Auto-parse
        const entries = await window.desktop.meds.parseText(allMedsText);
        setMedsEntries(entries);
        addLog(`✅ OCR complete: ${entries.length} total medications`);
      }
    } catch (e) {
      addLog('❌ OCR error: ' + e.message);
      showToast('❌ OCR failed', 'error');
    }
    
    setOcrProcessing(false);
  }, [ocrImages, addLog, showToast]);

  const saveApiKey = useCallback(async () => {
    if (!apiKeyInput.trim() || !window.desktop?.config?.setApiKey) return;
    await window.desktop.config.setApiKey(apiKeyInput.trim());
    setHasApiKey(true);
    setShowSettings(false);
    setApiKeyInput('');
    showToast('✅ API key saved', 'success');
    addLog('API key configured');
  }, [apiKeyInput, showToast, addLog]);

  const fillMeds = useCallback(async () => {
    if (!window.desktop?.meds) {
      showToast('Meds IPC not available', 'error');
      return;
    }

    let entries = medsEntries;
    if (entries.length === 0) {
      entries = await parseMedsFromText();
    }
    if (entries.length === 0) {
      showToast('No medications to fill', 'error');
      return;
    }

    setFilling(true);
    addLog(`Filling ${entries.length} medications...`);

    try {
      // Inject meds injector if not already done
      if (!medsInjected) {
        const bootstrapCode = await window.desktop.meds.getBootstrapCode();
        const result = await exec(bootstrapCode);
        setMedsInjected(true);
        addLog('Meds injector: ' + result);
      }

      const autofillCode = await window.desktop.meds.getAutofillCode(entries, agency);
      const result = await exec(autofillCode);
      
      if (result?.ok) {
        addLog('✅ Meds filled: ' + result.count + ' entries');
        showToast('✅ ' + result.count + ' medications filled', 'success');
      } else {
        addLog('⚠️ Meds fill failed: ' + (result?.error || 'unknown'));
        showToast('⚠️ Medication fill failed', 'error');
      }
    } catch (e) {
      addLog('❌ Meds error: ' + e.message);
      showToast('❌ Error filling medications', 'error');
    }

    setFilling(false);
  }, [medsEntries, parseMedsFromText, medsInjected, exec, agency, addLog, showToast]);

  const countFields = (d) => {
    if (!d) return 0;
    const s = d.alta || d.dsl || d;
    return (s.checkboxes?.length || 0) + Object.keys(s.fields || s.texts || {}).length + Object.keys(s.selects || {}).length + Object.keys(s.radios || {}).length + (s.xpaths?.length || 0) + Object.keys(s.checkbox_ng_models || {}).length;
  };
  const totalFields = sectionNames.reduce((sum, n) => sum + countFields(sections?.[n]), 0);
  const L = uiTheme === 'light';

  return (
    <div style={S.root}>
      <div style={S.topBar}>
        <span style={S.brandTitle}>Orbit Agent</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={S.label}>Site</span>
          <select
            style={{ ...S.select, borderColor: currentSite.color, minWidth: 100 }}
            value={site}
            onChange={e => switchSite(e.target.value)}
          >
            {SITE_NAMES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={S.label}>Agency</span>
          <select style={S.select} value={agency} onChange={e => setAgency(e.target.value)}>
            <option value="">-- Select --</option>
            {agencyList.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={S.label}>Category</span>
          <select style={S.select} value={category} onChange={e => setCategory(e.target.value)}>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={S.label}>Level</span>
          <select style={S.select} value={level} onChange={e => setLevel(e.target.value)}>
            {availLevels.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          style={S.btn(L ? '#e2e8f0' : '#334155', L ? '#0f172a' : '#e2e8f0')}
          onClick={toggleUiTheme}
          title="Switch between dark and light UI"
        >
          {L ? 'Dark' : 'Light'}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={S.label}>Profile</span>
          <select
            style={{ ...S.select, minWidth: 150 }}
            value={applyProfileId}
            onChange={(e) => setApplyProfileId(e.target.value)}
            title="Saved autofill profile"
          >
            <option value="">— None —</option>
            {(autofillStore?.profiles || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.workflowType}
              </option>
            ))}
          </select>
        </div>
        <button
          style={S.btn(filling || !applyProfileId ? '#F1F5F9' : '#EFF6FF', filling || !applyProfileId ? '#94A3B8' : '#3B82F6')}
          onClick={fillWithSavedProfile}
          disabled={filling || !applyProfileId}
          title="Apply saved field choices and values"
        >
          {filling ? 'Applying...' : 'Apply profile'}
        </button>
        <button style={S.btn(filling ? '#F1F5F9' : '#ECFDF5', filling ? '#94A3B8' : '#059669')} onClick={fillAll} disabled={filling || sectionNames.length === 0}>
          {filling ? 'Filling...' : 'Fill All (' + totalFields + ')'}
        </button>
        {site === SITE_KINNSER ? (
          <>
            <button
              type="button"
              style={S.btn(mobilityBulkEnabled ? '#ECFDF5' : '#F1F5F9', mobilityBulkEnabled ? '#059669' : '#94A3B8')}
              onClick={() => setMobilityBulkEnabled((o) => !o)}
              title="Hover section headers (Bed Mobility, Transfer, Gait…) to bulk-set assist levels"
            >
              {mobilityBulkEnabled ? 'Bulk fill on' : 'Bulk fill off'}
            </button>
            <button
              type="button"
              style={S.btn(summaryFloatEnabled ? '#EFF6FF' : '#F1F5F9', summaryFloatEnabled ? '#3B82F6' : '#94A3B8')}
              onClick={() => setSummaryFloatEnabled((o) => !o)}
              title="In-chart float on fields — Learn / Suggest / Clear"
            >
              {summaryFloatEnabled ? 'Float on' : 'Float off'}
            </button>
            <button
              type="button"
              style={S.btn(autoSuggestEnabled ? '#ECFDF5' : '#F1F5F9', autoSuggestEnabled ? '#059669' : '#94A3B8')}
              onClick={() => setAutoSuggestEnabled((o) => !o)}
              title="Auto suggest when learned threshold is reached"
            >
              {autoSuggestEnabled ? 'Auto suggest' : 'Auto suggest off'}
            </button>
            <button
              type="button"
              style={S.btn('#F1F5F9', '#475569')}
              onClick={() => {
                setShowSettings(true);
                setSidebarOpen(true);
              }}
              title="Open copilot rules/settings"
            >
              Settings
            </button>
            <button
              type="button"
              style={S.btn(liveCopilotOpen ? '#DBEAFE' : '#EFF6FF', liveCopilotOpen ? '#1E40AF' : '#3B82F6')}
              onClick={() => setLiveCopilotOpen((o) => !o)}
              title="Open Live Copilot drawer"
            >
              {liveCopilotOpen ? 'Close Copilot' : 'Copilot'}
            </button>
            <button
              type="button"
              style={S.btn(agentChatOpen ? '#D1FAE5' : '#ECFDF5', agentChatOpen ? '#065F46' : '#059669')}
              onClick={() => setAgentChatOpen((o) => !o)}
              title="Open Agent Chat — send commands to automate your notes"
            >
              {agentChatOpen ? 'Close Agent' : 'Agent'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              style={S.btn(assistantOpen ? '#DBEAFE' : '#EFF6FF', assistantOpen ? '#1E40AF' : '#3B82F6')}
              onClick={() => {
                setAssistantOpen((o) => !o);
                setLiveCopilotOpen(false);
              }}
              title="Open AI autofill assistant"
            >
              {assistantOpen ? 'Close Assistant' : 'Assistant'}
            </button>
            <button
              type="button"
              style={S.btn(liveCopilotOpen ? '#DBEAFE' : '#EFF6FF', liveCopilotOpen ? '#1E40AF' : '#3B82F6')}
              onClick={() => {
                setLiveCopilotOpen((o) => !o);
                setAssistantOpen(false);
              }}
              title="Live Documentation Copilot"
            >
              {liveCopilotOpen ? 'Close Copilot' : 'Copilot'}
            </button>
            <button
              type="button"
              style={S.btn(agentChatOpen ? '#D1FAE5' : '#ECFDF5', agentChatOpen ? '#065F46' : '#059669')}
              onClick={() => setAgentChatOpen((o) => !o)}
              title="Open Agent Chat — send commands to automate your notes"
            >
              {agentChatOpen ? 'Close Agent' : 'Agent'}
            </button>
          </>
        )}
      </div>

      <div style={S.body}>
        <div style={S.sidebar(sidebarOpen, sidebarWidth)}>

          {/* ── Orbit-style sidebar navigation ── */}
          {sidebarOpen ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
              <div style={S.sidebarNavExpanded}>
                <button onClick={() => { setTab('sections'); }} style={S.sidebarNavRow(tab === 'sections')}>
                  {tab === 'sections' && <span style={S.sidebarNavIndicator} />}
                  <span style={S.sidebarNavIcon(tab === 'sections')}><IconSections /></span> Sections
                </button>
                <button onClick={() => { setTab('meds'); }} style={S.sidebarNavRow(tab === 'meds')}>
                  {tab === 'meds' && <span style={S.sidebarNavIndicator} />}
                  <span style={S.sidebarNavIcon(tab === 'meds')}><IconMeds /></span> Medications
                </button>
                <button onClick={() => { setTab('scan'); }} style={S.sidebarNavRow(tab === 'scan')}>
                  {tab === 'scan' && <span style={S.sidebarNavIndicator} />}
                  <span style={S.sidebarNavIcon(tab === 'scan')}><IconScan /></span> Scan
                </button>
                <button onClick={() => { setTab('scraper'); }} style={S.sidebarNavRow(tab === 'scraper')}>
                  {tab === 'scraper' && <span style={S.sidebarNavIndicator} />}
                  <span style={S.sidebarNavIcon(tab === 'scraper')}><IconScrape /></span> Scrape
                </button>
                <button onClick={() => { setTab('profiles'); }} style={S.sidebarNavRow(tab === 'profiles')}>
                  {tab === 'profiles' && <span style={S.sidebarNavIndicator} />}
                  <span style={S.sidebarNavIcon(tab === 'profiles')}><IconProfiles /></span> Profiles
                </button>
                <button onClick={() => { setTab('log'); }} style={S.sidebarNavRow(tab === 'log')}>
                  {tab === 'log' && <span style={S.sidebarNavIndicator} />}
                  <span style={S.sidebarNavIcon(tab === 'log')}><IconLog /></span> Log
                </button>
                <div style={{ flex: 1 }} />
                <button onClick={() => { setShowSettings(!showSettings); }} style={S.sidebarNavRow(showSettings)}>
                  <span style={S.sidebarNavIcon(showSettings)}><IconSettings color={hasApiKey ? '#059669' : '#F59E0B'} /></span> Settings
                </button>
                <button onClick={() => setSidebarOpen(false)} style={{...S.sidebarNavRow(false), color: '#94A3B8', fontSize: 12}}>
                  <span style={S.sidebarNavIcon(false)}><IconCollapse color="#94A3B8" /></span> Collapse
                </button>
              </div>

              <div style={{ ...S.sidebarScroll, flex: 1 }}>
            {tab === 'sections' && (
              <>
                {sectionNames.length === 0 && <div style={S.emptyHint}>{agency ? 'No profile for ' + agency + ' / ' + category + ' / ' + level : 'Select an agency to load profiles'}</div>}
                {sectionNames.map((name) => {
                  const data = sections[name];
                  const count = countFields(data);
                  const isFilled = filledSections.has(name);
                  const isExpanded = expandedSection === name;
                  return (
                    <div key={name}>
                      <div style={S.sectionHeader} onClick={() => setExpandedSection(isExpanded ? null : name)}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: isFilled ? '#4ade80' : '#64748b', fontSize: 10 }}>isFilled ? '●' : '○'</span>
                          {name} <span style={{ color: '#64748b', fontWeight: 400, fontSize: 10 }}>({count})</span>
                        </span>
                        <button style={{ padding: '4px 10px', borderRadius: 5, border: 'none', fontSize: 11, fontWeight: 700, cursor: 'pointer', background: '#EFF6FF', color: '#3B82F6' }} onClick={(e) => { e.stopPropagation(); fillSection(name); }} disabled={filling}>Fill</button>
                      </div>
                      {isExpanded && (
                        <div style={{ background: L ? 'rgba(241,245,249,.98)' : 'rgba(15,23,42,.5)' }}>
                          {(() => {
                            const d = data?.alta || data?.dsl || data;
                            const items = [];
                            if (d.checkboxes) d.checkboxes.forEach(id => items.push({ t: 'cb', id, v: '✓' }));
                            if (d.fields || d.texts) Object.entries(d.fields || d.texts || {}).forEach(([id, v]) => items.push({ t: 'tx', id, v: String(v).slice(0, 40) }));
                            if (d.selects) Object.entries(d.selects).forEach(([id, v]) => items.push({ t: 'sel', id, v: String(v) }));
                            if (d.radios) Object.entries(d.radios).forEach(([id, v]) => items.push({ t: 'rad', id, v: String(v) }));
                            return items.slice(0, 50).map((it, i) => (
                              <div key={i} style={S.fieldRow}>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.t} <span style={{ color: '#2563EB' }}>{it.id}</span></span>
                                <span style={{ color: '#64748b', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{it.v}</span>
                              </div>
                            ));
                          })()}
                          {countFields(data) > 50 && <div style={{ padding: '4px 14px', fontSize: 10, color: '#475569' }}>+{countFields(data) - 50} more...</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {tab === 'meds' && (
              <FloatingPanel
                title="Medications"
                icon={<IconMeds />}
                onClose={() => setTab('sections')}
                posRef={medsPosRef}
                sizeRef={medsSizeRef}
                defaultX={60}
                defaultY={110}
                defaultWidth={440}
                defaultHeight={520}
                minWidth={320}
              >
              <div style={{ padding: 14 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <button
                    style={S.btn(medsInputMode === 'text' ? '#2563eb' : '#334155')}
                    onClick={() => setMedsInputMode('text')}
                  >Paste Text</button>
                  <button
                    style={S.btn(medsInputMode === 'table' ? '#2563eb' : '#334155')}
                    onClick={() => setMedsInputMode('table')}
                  >Table Edit</button>
                </div>

                {medsInputMode === 'text' && (
                  <>
                    <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 8 }}>
                      Paste medications (one per line):<br />
                      <code style={{ color: '#3B82F6', fontSize: 10 }}>DATE | NAME & DOSAGE | FREQ | CLASS | STATUS</code>
                    </div>
                    <textarea
                      style={S.textarea}
                      value={medsText}
                      onChange={e => setMedsText(e.target.value)}
                      placeholder="03/15/2024 | Metformin 500mg | BID | Antidiabetic | New&#10;03/15/2024 | Lisinopril 10mg | QD | ACE Inhibitor | New"
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button style={S.btn('#F1F5F9', '#475569')} onClick={parseMedsFromText}>
                        Parse ({medsText.split('\n').filter(l => l.trim()).length} lines)
                      </button>
                      <button
                        style={S.btn(filling ? '#F1F5F9' : '#ECFDF5', filling ? '#94A3B8' : '#059669')}
                        onClick={fillMeds}
                        disabled={filling || (!medsText.trim() && medsEntries.length === 0)}
                      >
                        {filling ? 'Filling...' : 'Fill Meds'}
                      </button>
                    </div>
                  </>
                )}

                {medsInputMode === 'table' && (
                  <>
                    <div style={{ fontSize: 10, color: '#64748b', marginBottom: 8, display: 'grid', gridTemplateColumns: '80px 1fr 100px 100px 70px 32px', gap: 6, padding: '0 10px' }}>
                      <span>Date</span>
                      <span>Name & Dosage</span>
                      <span>Frequency</span>
                      <span>Class</span>
                      <span>Status</span>
                      <span></span>
                    </div>
                    <div style={{ maxHeight: 300, overflowY: 'auto', background: '#F1F5F9', borderRadius: 6 }}>
                      {medsEntries.map((entry, i) => (
                        <div key={i} style={S.medsRow}>
                          <input
                            style={S.medsInput}
                            value={entry.date}
                            onChange={e => updateMedsEntry(i, 'date', e.target.value)}
                            placeholder="MM/DD/YY"
                          />
                          <input
                            style={S.medsInput}
                            value={entry.name}
                            onChange={e => updateMedsEntry(i, 'name', e.target.value)}
                            placeholder="Medication name & dosage"
                          />
                          <input
                            style={S.medsInput}
                            value={entry.freq}
                            onChange={e => updateMedsEntry(i, 'freq', e.target.value)}
                            placeholder="QD, BID..."
                          />
                          <input
                            style={S.medsInput}
                            value={entry.className}
                            onChange={e => updateMedsEntry(i, 'className', e.target.value)}
                            placeholder="Class"
                          />
                          <select
                            style={{ ...S.medsInput, padding: '4px 6px' }}
                            value={entry.status}
                            onChange={e => updateMedsEntry(i, 'status', e.target.value)}
                          >
                            <option value="New">New</option>
                            <option value="Changed">Changed</option>
                            <option value="Unchanged">Unchanged</option>
                            <option value="Discontinued">Disc.</option>
                          </select>
                          <button
                            style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
                            onClick={() => removeMedsEntry(i)}
                            title="Remove"
                          >✕</button>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button style={S.btn('#F1F5F9', '#475569')} onClick={addMedsEntry}>+ Add Row</button>
                      <button
                        style={S.btn(filling ? '#F1F5F9' : '#ECFDF5', filling ? '#94A3B8' : '#059669')}
                        onClick={fillMeds}
                        disabled={filling || medsEntries.length === 0}
                      >
                        {filling ? 'Filling...' : 'Fill ' + medsEntries.length + ' Meds'}
                      </button>
                    </div>
                  </>
                )}

                {medsEntries.length > 0 && medsInputMode === 'text' && (
                  <div style={{ marginTop: 14, padding: 10, background: '#F1F5F9', borderRadius: 6 }}>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>Parsed entries:</div>
                    {medsEntries.slice(0, 10).map((e, i) => (
                      <div key={i} style={{ fontSize: 10, color: '#475569', padding: '2px 0' }}>
                        {i + 1}. {e.date} | {e.name} | {e.freq} | {e.className} | {e.status}
                      </div>
                    ))}
                    {medsEntries.length > 10 && <div style={{ fontSize: 10, color: '#64748b' }}>+{medsEntries.length - 10} more...</div>}
                  </div>
                )}
              </div>
              </FloatingPanel>
            )}

            {tab === 'scan' && (
              <FloatingPanel
                title="OCR Scan"
                icon={<IconScan />}
                onClose={() => setTab('sections')}
                posRef={scanPosRef}
                sizeRef={scanSizeRef}
                defaultX={80}
                defaultY={120}
                defaultWidth={420}
                defaultHeight={500}
                minWidth={300}
              >
              <div style={{ padding: 14 }}>
                <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 12 }}>
                  Upload or paste images of medication lists to extract medications automatically.
                </div>
                
                {!hasApiKey && (
                  <div style={{ padding: 12, background: 'rgba(245,158,11,.15)', borderRadius: 6, marginBottom: 12, border: '1px solid rgba(245,158,11,.3)' }}>
                    <div style={{ color: '#f59e0b', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>API Key Required</div>
                    <div style={{ color: '#fbbf24', fontSize: 11 }}>Click Settings above to configure your Anthropic API key for image scanning.</div>
                  </div>
                )}
                
                {/* Image thumbnails */}
                {ocrImages.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{ocrImages.length} image(s) added:</div>
                      <button 
                        style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 11 }}
                        onClick={clearAllImages}
                      >Clear all</button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {ocrImages.map((img, idx) => (
                        <div key={img.id} style={{ position: 'relative', width: 80, height: 80 }}>
                          <img 
                            src={img.dataUrl} 
                            alt={img.fileName}
                            style={{ 
                              width: '100%', 
                              height: '100%', 
                              objectFit: 'cover', 
                              borderRadius: 6,
                              border: '1px solid #475569',
                            }}
                          />
                          <div style={{ 
                            position: 'absolute', 
                            top: 2, 
                            left: 4, 
                            background: 'rgba(0,0,0,.7)', 
                            color: '#fff', 
                            fontSize: 9, 
                            padding: '1px 4px', 
                            borderRadius: 3,
                          }}>{idx + 1}</div>
                          <button
                            style={{ 
                              position: 'absolute', 
                              top: 2, 
                              right: 2, 
                              background: 'rgba(239,68,68,.9)', 
                              border: 'none', 
                              color: '#fff', 
                              width: 18, 
                              height: 18, 
                              borderRadius: '50%', 
                              cursor: 'pointer',
                              fontSize: 10,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                            onClick={() => removeOcrImage(img.id)}
                          >✕</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Drop zone */}
                <div
                  onDrop={handleDropImage}
                  onDragOver={(e) => e.preventDefault()}
                  onPaste={handlePasteImage}
                  tabIndex={0}
                  style={{
                    border: '2px dashed #CBD5E1',
                    borderRadius: 8,
                    padding: 24,
                    textAlign: 'center',
                    cursor: 'pointer',
                    background: '#F1F5F9',
                    transition: 'border-color .2s',
                  }}
                  onClick={handlePickImage}
                >
                  
                  <div style={{ color: '#94a3b8', fontSize: 12 }}>
                    {ocrImages.length > 0 ? 'Add more images...' : 'Drop images here, paste (Ctrl+V), or click to browse'}
                  </div>
                  <div style={{ color: '#64748b', fontSize: 10, marginTop: 8 }}>
                    Supports multiple JPG, PNG, GIF, WebP
                  </div>
                </div>
                
                {ocrImages.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      style={{ ...S.btn(ocrProcessing ? '#F1F5F9' : '#EFF6FF', ocrProcessing ? '#94A3B8' : '#3B82F6'), width: '100%' }}
                      onClick={handleOCR}
                      disabled={ocrProcessing || !hasApiKey}
                    >
                      {ocrProcessing ? 'Processing...' : `Extract Medications from ${ocrImages.length} Image${ocrImages.length > 1 ? 's' : ''}`}
                    </button>
                  </div>
                )}
                
                {medsEntries.length > 0 && (
                  <div style={{ marginTop: 14, padding: 10, background: '#F1F5F9', borderRadius: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>Extracted medications:</div>
                      <button
                        style={S.btn('#ECFDF5', '#059669')}
                        onClick={() => { setTab('meds'); }}
                      >
                        Review & Fill →
                      </button>
                    </div>
                    {medsEntries.slice(0, 5).map((e, i) => (
                      <div key={i} style={{ fontSize: 10, color: '#475569', padding: '2px 0' }}>
                        {i + 1}. {e.name} | {e.freq}
                      </div>
                    ))}
                    {medsEntries.length > 5 && <div style={{ fontSize: 10, color: '#64748b' }}>+{medsEntries.length - 5} more...</div>}
                  </div>
                )}
              </div>
              </FloatingPanel>
            )}

            {/* Settings panel - draggable floating */}
            {showSettings && (
              <FloatingPanel
                title="Settings"
                icon={<IconSettings color="#059669" />}
                onClose={() => setShowSettings(false)}
                posRef={settingsPosRef}
                sizeRef={settingsSizeRef}
                defaultX={Math.round(window.innerWidth / 2 - 240)}
                defaultY={80}
                defaultWidth={480}
                defaultHeight={600}
                minWidth={360}
              >
                <div style={{ padding: 20 }}>
                <div style={S.settingsMuted}>Anthropic API Key for medication scanning:</div>
                <input
                  type="password"
                  style={S.settingsInput}
                  placeholder="sk-ant-..."
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                />
                <div
                  style={{
                    marginTop: 12,
                    padding: 10,
                    borderRadius: 10,
                    background: L ? '#F0FDF4' : '#1A2E1A', border: L ? '1px solid #BBF7D0' : '1px solid #2D5A2D',
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 800, color: '#16A34A', marginBottom: 6, letterSpacing: '.04em', textTransform: 'uppercase' }}>
                    Saved Logins
                  </div>
                  {Object.keys(savedCredSites).length === 0 ? (
                    <div style={{ fontSize: 11, color: '#64748B' }}>No saved logins yet. Log into a site and click "Save" on the login banner.</div>
                  ) : (
                    <div style={{ display: 'grid', gap: 6 }}>
                      {Object.entries(savedCredSites).map(([siteKey, info]) => (
                        <div key={siteKey} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 8, background: L ? '#fff' : '#0F1A0F', border: L ? '1px solid #E2E8F0' : '1px solid #2D5A2D' }}>
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: L ? '#1E293B' : '#E2E8F0' }}>{siteKey}</div>
                            <div style={{ fontSize: 10, color: '#64748B' }}>{info.username}</div>
                          </div>
                          <button
                            type="button"
                            style={{ fontSize: 10, color: '#EF4444', background: 'transparent', border: 'none', cursor: 'pointer' }}
                            onClick={async () => {
                              await window.desktop?.config?.clearCredentials?.(siteKey);
                              setSavedCredSites((prev) => { const n = { ...prev }; delete n[siteKey]; return n; });
                              if (siteKey === site) setCredentialsSaved(false);
                            }}
                          >Remove</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {site === SITE_KINNSER && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 10,
                      borderRadius: 10,

                      background: '#F5F3FF', border: '1px solid #DDD6FE',
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#7C3AED', marginBottom: 6, letterSpacing: '.04em', textTransform: 'uppercase' }}>
                      Kinnser Auto-Apply
                    </div>
                    <div style={{ fontSize: 11, color: '#475569', marginBottom: 8, lineHeight: 1.4 }}>
                      Auto-overwrite only when confidence is above this threshold. Undo remains available in the float.
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: '#475569' }}>Auto suggest / automation</div>
                      <button
                        type="button"
                        style={S.btn(autoSuggestEnabled ? '#ECFDF5' : '#F1F5F9', autoSuggestEnabled ? '#059669' : '#94A3B8')}
                        onClick={() => setAutoSuggestEnabled((o) => !o)}
                      >
                        {autoSuggestEnabled ? 'Enabled' : 'Disabled'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="range"
                        min="0.6"
                        max="0.98"
                        step="0.01"
                        value={autoApplyConfidence}
                        onChange={(e) => setAutoApplyConfidence(Number(e.target.value))}
                        style={{ flex: 1 }}
                      />
                      <div style={{ minWidth: 54, textAlign: 'right', fontSize: 12, fontWeight: 800, color: '#6D28D9' }}>
                        {Math.round(autoApplyConfidence * 100)}%
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      {[0.8, 0.85, 0.9, 0.95].map((v) => (
                        <button
                          key={String(v)}
                          type="button"
                          onClick={() => setAutoApplyConfidence(v)}
                          style={S.btn(
                            Math.abs(autoApplyConfidence - v) < 0.001 ? '#EFF6FF' : '#F1F5F9',
                            Math.abs(autoApplyConfidence - v) < 0.001 ? '#3B82F6' : '#94A3B8'
                          )}
                        >
                          {Math.round(v * 100)}%
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {site === SITE_KINNSER && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 10,
                      borderRadius: 10,
                      
                      background: '#EFF6FF', border: '1px solid #BFDBFE',
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#2563EB', marginBottom: 6, letterSpacing: '.04em', textTransform: 'uppercase' }}>
                      Copilot Field Rules (beta)
                    </div>
                    <div style={{ fontSize: 11, color: '#475569', marginBottom: 8, lineHeight: 1.4 }}>
                      Apply custom append rules by field + condition. Condition uses JavaScript with <code>ctx</code> (e.g. <code>ctx.vitals.bpSystolic &gt;= 180</code>).
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      <input
                        type="text"
                        style={S.settingsInput}
                        value={ruleFieldMatch}
                        onChange={(e) => setRuleFieldMatch(e.target.value)}
                        placeholder="Field match contains (e.g. vital, subjective, bed mobility)"
                      />
                      <input
                        type="text"
                        style={S.settingsInput}
                        value={ruleCondition}
                        onChange={(e) => setRuleCondition(e.target.value)}
                        placeholder="Condition, e.g. ctx.vitals.bpSystolic >= 180 || ctx.vitals.bpDiastolic >= 90"
                      />
                      <textarea
                        style={{ ...S.settingsInput, minHeight: 60, resize: 'vertical' }}
                        value={ruleAppendText}
                        onChange={(e) => setRuleAppendText(e.target.value)}
                        placeholder="Append text when rule matches"
                      />
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          style={S.btn('#EFF6FF', '#3B82F6')}
                          onClick={() => {
                            const nm = String(ruleFieldMatch || '').trim();
                            const cond = String(ruleCondition || '').trim();
                            const app = String(ruleAppendText || '').trim();
                            if (!cond || !app) return;
                            setCopilotRules((prev) => [
                              ...prev,
                              { id: String(Date.now()), fieldMatch: nm, condition: cond, appendText: app, enabled: true },
                            ]);
                          }}
                        >
                          + Add rule
                        </button>
                        <button type="button" style={S.btn('#EFF6FF', '#3B82F6')} onClick={testRuleNow}>
                          Test rule now
                        </button>
                        <button type="button" style={S.btn('#F1F5F9', '#475569')} onClick={() => setCopilotRules([])}>
                          Clear all rules
                        </button>
                      </div>
                      {ruleTestResult ? (
                        <div style={{ fontSize: 11, color: /MATCH/.test(ruleTestResult) ? '#4ade80' : '#cbd5e1', marginTop: 4 }}>
                          {ruleTestResult}
                        </div>
                      ) : null}
                      {(copilotRules || []).length > 0 && (
                        <div style={{ display: 'grid', gap: 6, marginTop: 6, maxHeight: 180, overflow: 'auto' }}>
                          {copilotRules.map((r) => (
                            <div key={r.id} style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: 8, background: '#F8FAFC' }}>
                              <div style={{ fontSize: 10, color: '#2563EB', marginBottom: 3 }}>field: {r.fieldMatch || '(any)'}</div>
                              <div style={{ fontSize: 10, color: '#475569', marginBottom: 3 }}>if: {r.condition}</div>
                              <div style={{ fontSize: 10, color: '#1E293B', marginBottom: 6 }}>append: {r.appendText}</div>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  type="button"
                                  style={S.btn(r.enabled ? '#ECFDF5' : '#F1F5F9', r.enabled ? '#059669' : '#94A3B8')}
                                  onClick={() =>
                                    setCopilotRules((prev) =>
                                      prev.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x))
                                    )
                                  }
                                >
                                  {r.enabled ? 'Enabled' : 'Disabled'}
                                </button>
                                <button
                                  type="button"
                                  style={S.btn('#FEE2E2', '#DC2626')}
                                  onClick={() => setCopilotRules((prev) => prev.filter((x) => x.id !== r.id))}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div style={{ ...S.settingsMuted, marginTop: 12, marginBottom: 4 }}>Appearance</div>
                <button
                  type="button"
                  style={{ ...S.btn(L ? '#e2e8f0' : '#334155', L ? '#0f172a' : '#e2e8f0'), width: '100%', marginBottom: 12 }}
                  onClick={toggleUiTheme}
                >
                  {L ? 'Switch to dark mode' : 'Switch to light mode'}
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={S.btn('#ECFDF5', '#059669')} onClick={saveApiKey}>Save</button>
                  <button style={S.btn('#F1F5F9', '#475569')} onClick={() => setShowSettings(false)}>Cancel</button>
                </div>
                {hasApiKey && (
                  <div style={{ fontSize: 10, color: '#059669', marginTop: 8 }}>✓ API key is configured</div>
                )}
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 8 }}>
                  Get your key at: <span style={{ color: '#3B82F6' }}>console.anthropic.com</span>
                </div>
                </div>
              </FloatingPanel>
            )}

            {tab === 'scraper' && (
              <FloatingPanel
                title="Form Scraper"
                icon={<IconScrape />}
                onClose={() => setTab('sections')}
                posRef={scraperPosRef}
                sizeRef={scraperSizeRef}
                defaultX={100}
                defaultY={100}
                defaultWidth={460}
                defaultHeight={580}
                minWidth={340}
              >
              <div style={{ padding: 14 }}>

                {/* ── Step indicators ── */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                  <div style={{ flex: 1, padding: '6px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, textAlign: 'center',
                    background: hasSnapshot ? '#ECFDF5' : '#EFF6FF',
                    color: hasSnapshot ? '#059669' : '#3B82F6',
                    border: !hasSnapshot ? '1px solid #BFDBFE' : '1px solid #A7F3D0' }}>
                    {hasSnapshot ? '1. Done' : '1. Snapshot'}
                  </div>
                  <div style={{ flex: 1, padding: '6px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, textAlign: 'center',
                    background: '#F1F5F9', color: hasSnapshot ? '#1E293B' : '#94A3B8',
                    border: '1px solid #E2E8F0' }}>
                    2. Fill form
                  </div>
                  <div style={{ flex: 1, padding: '6px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, textAlign: 'center',
                    background: scraperResult ? '#ECFDF5' : '#F1F5F9',
                    color: scraperResult ? '#059669' : '#94A3B8',
                    border: scraperResult ? '1px solid #A7F3D0' : '1px solid #E2E8F0' }}>
                    {scraperResult ? '3. Done' : '3. Scrape'}
                  </div>
                </div>

                {/* ── Snapshot button ── */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <button style={S.btn(hasSnapshot ? '#F1F5F9' : '#EFF6FF', hasSnapshot ? '#94A3B8' : '#3B82F6')} onClick={takeSnapshot}>
                    {hasSnapshot ? 'Retake Snapshot' : 'Take Snapshot'}
                  </button>
                  {hasSnapshot && snapshotInfo && (
                    <span style={{ fontSize: 10, color: '#059669', alignSelf: 'center' }}>
                      {snapshotInfo.total} elements at {new Date(snapshotInfo.ts).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                {/* ── Mode + options ── */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 10, alignItems: 'center' }}>
                  <label style={{ fontSize: 11, color: scraperMode === 'diff' ? '#60a5fa' : '#64748b', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input type="radio" name="scrapeMode" checked={scraperMode === 'diff'} onChange={() => setScraperMode('diff')} />
                    Changes only
                  </label>
                  <label style={{ fontSize: 11, color: scraperMode === 'full' ? '#60a5fa' : '#64748b', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input type="radio" name="scrapeMode" checked={scraperMode === 'full'} onChange={() => setScraperMode('full')} />
                    Full page
                  </label>
                  <div style={{ flex: 1 }} />
                  <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input type="checkbox" checked={scraperWrapAlta} onChange={e => setScraperWrapAlta(e.target.checked)} />
                    <code style={{ background: '#334155', padding: '1px 4px', borderRadius: 3, fontSize: 10 }}>alta</code> wrap
                  </label>
                </div>

                {/* ── Scrape button ── */}
                <button
                  style={S.btn(scraping ? '#F1F5F9' : '#ECFDF5', scraping ? '#94A3B8' : '#059669')}
                  onClick={scrapePage}
                  disabled={scraping || (scraperMode === 'diff' && !hasSnapshot)}
                >
                  {scraping ? 'Scraping...' : scraperMode === 'diff' ? 'Scrape Changes' : 'Scrape Full Page'}
                </button>
                {scraperMode === 'diff' && !hasSnapshot && (
                  <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 4 }}>Take a snapshot first</div>
                )}

                {scraperResult && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 11, color: '#059669', marginBottom: 8, padding: '8px 10px', background: 'rgba(5,150,105,.15)', borderRadius: 6 }}>
                      {scraperResult.meta.mode === 'diff' ? 'Changes: ' : 'Full: '}
                      {scraperResult.meta.totalCheckboxes} checkboxes · {scraperResult.meta.totalSelects} selects · {scraperResult.meta.totalTexts} texts · {scraperResult.meta.totalRadios} radios · {scraperResult.meta.totalNgModels} ng-models
                      {scraperResult.meta.snapshotAge && <span style={{ color: '#64748b' }}> · snap {scraperResult.meta.snapshotAge} ago</span>}
                    </div>

                    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                      <button style={S.btn('#ECFDF5', '#059669')} onClick={saveScrapedProfile} disabled={!agency}>
                        Save Profile
                      </button>
                      <button style={S.btn(scraperCopied ? '#059669' : '#334155')} onClick={copyScrapedJson}>
                        {scraperCopied ? 'Copied!' : 'Copy'}
                      </button>
                      <button style={S.btn('#F1F5F9', '#475569')} onClick={downloadScrapedJson}>
                        ⬇ Export
                      </button>
                    </div>
                    {!agency && <div style={{ fontSize: 10, color: '#f59e0b', marginBottom: 8 }}>Select an agency in the top bar to save</div>}

                    <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>
                      Sections ({scraperResult.meta.sectionCount}):
                    </div>
                    {Object.entries(scraperResult.sections).map(([secName, secData]) => {
                      const d = secData?.alta || secData;
                      const cnt = (d.checkboxes?.length || 0) + Object.keys(d.selects || {}).length + Object.keys(d.texts || {}).length + Object.keys(d.radios || {}).length + Object.keys(d.checkbox_ng_models || {}).length;
                      const isExp = scraperExpandedSec === secName;
                      return (
                        <div key={secName}>
                          <div
                            style={{ ...S.sectionHeader, background: L ? '#e2e8f0' : '#1a2332', fontSize: 11, padding: '8px 10px' }}
                            onClick={() => setScraperExpandedSec(isExp ? null : secName)}
                          >
                            <span>{secName === '__ungrouped__' ? '(Ungrouped)' : secName} <span style={{ color: '#64748b', fontWeight: 400 }}>({cnt})</span></span>
                            <span style={{ color: '#64748b', fontSize: 10 }}>{isExp ? '▼' : '▶'}</span>
                          </div>
                          {isExp && (
                            <div style={{ background: L ? 'rgba(241,245,249,.95)' : 'rgba(15,23,42,.5)', maxHeight: 300, overflowY: 'auto' }}>
                              {d.checkboxes?.map((id, i) => (
                                <div key={'cb'+i} style={S.fieldRow}><span style={{fontSize:10,color:'#64748B'}}>cb <span style={{ color: '#2563EB' }}>{id}</span></span></div>
                              ))}
                              {Object.entries(d.selects || {}).map(([id, v]) => (
                                <div key={'sel'+id} style={S.fieldRow}>
                                  <span style={{fontSize:10,color:'#64748B'}}>sel <span style={{ color: '#2563EB' }}>{id}</span></span>
                                  <span style={{ color: '#64748b', fontSize: 10 }}>{v}</span>
                                </div>
                              ))}
                              {Object.entries(d.texts || {}).map(([id, v]) => (
                                <div key={'txt'+id} style={S.fieldRow}>
                                  <span style={{fontSize:10,color:'#64748B'}}>txt <span style={{ color: '#2563EB' }}>{id}</span></span>
                                  <span style={{ color: '#64748b', fontSize: 10, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(v).slice(0, 40)}</span>
                                </div>
                              ))}
                              {Object.entries(d.radios || {}).map(([id, v]) => (
                                <div key={'rad'+id} style={S.fieldRow}>
                                  <span style={{fontSize:10,color:'#64748B'}}>rad <span style={{ color: '#2563EB' }}>{id}</span></span>
                                  <span style={{ color: '#64748b', fontSize: 10 }}>{v}</span>
                                </div>
                              ))}
                              {Object.entries(d.checkbox_ng_models || {}).map(([id, v]) => (
                                <div key={'ng'+id} style={S.fieldRow}>
                                  <span style={{fontSize:10,color:'#64748B'}}>xp <span style={{ color: '#7C3AED' }}>{id}</span></span>
                                  <span style={{ color: '#64748b', fontSize: 10 }}>{v}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <div style={{ marginTop: 12, fontSize: 10, color: '#475569' }}>
                      Output: {agency || '(no agency)'} / {category} / {level}
                    </div>
                  </div>
                )}

                {!scraperResult && !scraping && (
                  <div style={{ marginTop: 16, fontSize: 11, color: '#475569', lineHeight: 2, padding: '0 4px' }}>
                    <strong style={{ color: '#94a3b8' }}>Workflow:</strong><br/>
                    1. Navigate to the form page<br/>
                    2. Click <strong style={{ color: '#3B82F6' }}>Snapshot</strong> to capture the baseline<br/>
                    3. Fill out the form for the desired level<br/>
                    4. Click <strong style={{ color: '#059669' }}>Scrape Changes</strong> to capture only what you added<br/>
                    5. Click <strong style={{ color: '#059669' }}>Save Profile</strong> — ready to use immediately
                  </div>
                )}
              </div>
              </FloatingPanel>
            )}

            {tab === 'profiles' && (
              <FloatingPanel
                title="Profiles"
                icon={<IconProfiles />}
                onClose={() => setTab('sections')}
                posRef={profilesPosRef}
                sizeRef={profilesSizeRef}
                defaultX={60}
                defaultY={110}
                defaultWidth={460}
                defaultHeight={550}
                minWidth={320}
              >
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <AutofillProfileBuilder
                    agency={agency}
                    category={category}
                    level={level}
                    showToast={showToast}
                    onStoreChange={refreshAutofillStore}
                  />
                </div>
              </FloatingPanel>
            )}

            {tab === 'log' && (
              <FloatingPanel
                title="Activity Log"
                icon={<IconLog />}
                onClose={() => setTab('sections')}
                posRef={logPosRef}
                sizeRef={logSizeRef}
                defaultX={120}
                defaultY={130}
                defaultWidth={400}
                defaultHeight={400}
                minWidth={280}
              >
              <div>
                {log.length === 0 && <div style={{ color: '#475569', fontSize: 12, textAlign: 'center', padding: 20 }}>No activity yet</div>}
                {[...log].reverse().map((e, i) => <div key={i} style={S.logEntry}><span style={{ color: '#475569', marginRight: 8 }}>{e.time}</span>{e.msg}</div>)}
              </div>
              </FloatingPanel>
            )}
          </div>
          <div style={S.statusBar}>
            <span>{filledSections.size}/{sectionNames.length}</span>
            <span>{totalFields} fields</span>
            <span>{medsEntries.length} meds</span>
            <span>injected ? 'Ready' : 'Idle'</span>
            <span style={{ color: currentSite.color }}>{currentSite.short}</span>
          </div>

          </div>
          ) : (
            /* ── Collapsed: just icon rail ── */
            <div style={S.sidebarNav}>
              <button onClick={() => setSidebarOpen(true)} style={S.sidebarNavItem(false)} title="Expand">
                <IconExpand color="#64748B" />
              </button>
              <button onClick={() => { setSidebarOpen(true); setTab('sections'); }} style={S.sidebarNavItem(tab === 'sections')} title="Sections">
                <IconSections />
              </button>
              <button onClick={() => { setSidebarOpen(true); setTab('meds'); }} style={S.sidebarNavItem(tab === 'meds')} title="Meds">
                <IconMeds />
              </button>
              <button onClick={() => { setSidebarOpen(true); setTab('scan'); }} style={S.sidebarNavItem(tab === 'scan')} title="Scan">
                <IconScan />
              </button>
              <button onClick={() => { setSidebarOpen(true); setTab('scraper'); }} style={S.sidebarNavItem(tab === 'scraper')} title="Scrape">
                <IconScrape />
              </button>
              <button onClick={() => { setSidebarOpen(true); setTab('profiles'); }} style={S.sidebarNavItem(tab === 'profiles')} title="Profiles">
                <IconProfiles />
              </button>
              <button onClick={() => { setSidebarOpen(true); setTab('log'); }} style={S.sidebarNavItem(tab === 'log')} title="Log">
                <IconLog />
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={() => { setSidebarOpen(true); setShowSettings(true); }} style={S.sidebarNavItem(showSettings)} title="Settings">
                <IconSettings color={hasApiKey ? '#059669' : '#F59E0B'} />
              </button>
            </div>
          )}

          {/* ── Drag handle for resize ── */}
          {sidebarOpen && (
            <div
              style={S.sidebarDragHandle}
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = sidebarWidth;
                const sidebar = e.target.parentElement;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                const onMove = (ev) => {
                  const newW = Math.max(180, Math.min(600, startW + ev.clientX - startX));
                  if (sidebar) sidebar.style.width = newW + 'px';
                };
                const onUp = (ev) => {
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                  document.body.style.cursor = '';
                  document.body.style.userSelect = '';
                  const finalW = Math.max(180, Math.min(600, startW + ev.clientX - startX));
                  setSidebarWidth(finalW);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
              onMouseEnter={(e) => { e.target.style.background = '#3B82F6'; }}
              onMouseLeave={(e) => { e.target.style.background = 'transparent'; }}
            />
          )}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', background: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', flexShrink: 0 }}>
            <button onClick={() => webviewRef.current?.goBack()} style={{ background: 'transparent', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: 14, padding: '4px 8px', borderRadius: 6 }} title="Back"><svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round'><path d='M15 18l-6-6 6-6'/></svg></button>
            <button onClick={() => webviewRef.current?.goForward()} style={{ background: 'transparent', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: 14, padding: '4px 8px', borderRadius: 6 }} title="Forward"><svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round'><path d='M9 18l6-6-6-6'/></svg></button>
            <button onClick={() => webviewRef.current?.reload()} style={{ background: 'transparent', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: 14, padding: '4px 8px', borderRadius: 6 }} title="Refresh"><svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round'><path d='M23 4v6h-6M1 20v-6h6M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15'/></svg></button>
            <button onClick={() => webviewRef.current?.loadURL(currentSite.url)} style={{ background: 'transparent', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: 14, padding: '4px 8px', borderRadius: 6 }} title="Home"><svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round'><path d='M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z'/></svg></button>
          </div>
          {onLoginPage && !loading && (
            <div style={{
              position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
              zIndex: 10, display: 'flex', alignItems: 'center', gap: 10,
              background: L ? 'rgba(255,255,255,.95)' : 'rgba(30,41,59,.95)',
              border: L ? '1px solid #E2E8F0' : '1px solid #475569',
              borderRadius: 12, padding: '10px 18px',
              boxShadow: '0 4px 20px rgba(0,0,0,.15)', backdropFilter: 'blur(8px)',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={credentialsSaved ? '#10B981' : '#3B82F6'} strokeWidth="2.5" strokeLinecap="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
              </svg>
              {credentialsSaved ? (
                <>
                  <span style={{ fontSize: 12, color: '#10B981', fontWeight: 600 }}>Login saved for {site}</span>
                  <button
                    onClick={clearLoginCredentials}
                    style={{ fontSize: 11, color: '#EF4444', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                  >Clear</button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 12, color: L ? '#334155' : '#CBD5E1', fontWeight: 500 }}>Save login for {site}?</span>
                  <button
                    onClick={saveLoginCredentials}
                    style={{
                      fontSize: 11, fontWeight: 700, color: '#fff', background: '#3B82F6',
                      border: 'none', borderRadius: 8, padding: '5px 14px', cursor: 'pointer',
                    }}
                  >Save</button>
                </>
              )}
            </div>
          )}
          {(loading || loadError) && (
            <div onClick={() => { setLoading(false); setReady(true); }} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: L ? 'rgba(241,245,249,.9)' : 'rgba(15,23,42,.85)', zIndex: 5, flexDirection: 'column', gap: 12, cursor: 'pointer' }}>
              {loading && !loadError && <><div style={{ color: '#94a3b8', fontSize: 13 }}>Loading {site}...</div><div style={{ color: '#475569', fontSize: 11, marginTop: 8 }}>Click anywhere to dismiss</div></>}
              {loadError && <><div style={{ color: '#f87171', fontSize: 13 }}>{loadError}</div><button onClick={() => { setLoadError(''); setLoading(true); webviewRef.current?.loadURL(currentSite.url); }} style={S.btn('#EFF6FF', '#3B82F6')}>Retry</button></>}
            </div>
          )}
          <webview
            ref={webviewRef}
            src={currentSite.url}
            style={{ width: '100%', flex: 1, border: 'none' }}
            allowpopups="true"
            partition="persist:ultrahhc"
            useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          />
        </div>
      </div>
      {toast && <div style={S.toast(toast.type)}>{toast.msg}</div>}

      <AssistantDrawer
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        title="Autofill Assistant"
        subtitle="AI suggestions · Preview · Fill blanks only"
      >
        <AiAutofillAgentPanel
          agency={agency}
          category={category}
          level={level}
          exec={exec}
          injected={injected}
          setInjected={setInjected}
          addLog={addLog}
          showToast={showToast}
          hasApiKey={hasApiKey}
        />
      </AssistantDrawer>

      <AssistantDrawer
        open={liveCopilotOpen}
        onClose={() => setLiveCopilotOpen(false)}
        title="Live Copilot"
        subtitle={liveCopilotSubtitleForSite(site)}
        zBase={10090}
      >
        <LiveCopilotPanel
          agency={agency}
          category={category}
          level={level}
          profileId={applyProfileId || ''}
          site={site}
          exec={exec}
          injected={injected}
          setInjected={setInjected}
          showToast={showToast}
          addLog={addLog}
          hasApiKey={hasApiKey}
          active={liveCopilotOpen}
          trackerReady={copilotTrackerReady}
        />
      </AssistantDrawer>

      {/* ── Agent Chat floating panel ── */}
      {agentChatOpen && (
        <div style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 99999,
          width: 520, maxHeight: '75vh', display: 'flex', flexDirection: 'column',
          background: '#FFFFFF',
          border: '1px solid #E2E8F0', borderRadius: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,.12)', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 18px 12px', borderBottom: '1px solid #E2E8F0',
          }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E293B', display: 'flex', alignItems: 'center', gap: 6 }}>Agent Chat</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button type="button" onClick={learnFullNote} style={{
                background: '#EFF6FF', border: '1px solid #BFDBFE', color: '#2563EB',
                fontSize: 11, fontWeight: 600, borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit',
              }} title="Capture all filled fields on this page to train the agent">Learn Note</button>
              <button type="button" onClick={() => setAgentChatOpen(false)} style={{
                background: '#F1F5F9', border: 'none', color: '#64748B', fontSize: 16, cursor: 'pointer',
                padding: '4px 8px', borderRadius: 6, lineHeight: 1, fontWeight: 600,
              }}>✕</button>
            </div>
          </div>
          <div ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }} style={{
            flex: 1, overflowY: 'auto', padding: '12px 18px', minHeight: 120, maxHeight: '55vh',
          }}>
            {agentChatMessages.length === 0 && (
              <div style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center', padding: '30px 10px', lineHeight: 1.7 }}>
                Tell the agent what to do.<br /><br />
                <span style={{ color: '#64748B' }}>Try:</span><br />
                "Fill out my entire note"<br />
                "Fill bed mobility training"<br />
                "Fill all transfer interventions"<br />
                "Write my summary"
              </div>
            )}
            {agentChatMessages.map((m, i) => (
              <div key={i} style={{
                margin: '6px 0', padding: '10px 14px', borderRadius: 12, fontSize: 13, lineHeight: 1.55, wordBreak: 'break-word',
                whiteSpace: 'pre-wrap', maxWidth: '85%',
                ...(m.role === 'user'
                  ? { marginLeft: 'auto', background: '#3B82F6', color: '#FFFFFF' }
                  : { marginRight: 'auto', background: '#F1F5F9', color: '#334155' }),
              }}>
                {m.text}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, padding: '12px 18px 14px', borderTop: '1px solid #E2E8F0', alignItems: 'flex-end' }}>
            <textarea
              value={agentChatInput}
              onChange={(e) => {
                setAgentChatInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  agentChatSend(agentChatInput);
                  e.target.style.height = 'auto';
                }
              }}
              rows={1}
              placeholder="e.g. Fill out my entire note"
              style={{
                flex: 1, background: '#F8FAFC', border: '1px solid #E2E8F0', color: '#1E293B',
                fontSize: 13, borderRadius: 10, padding: '10px 14px', lineHeight: 1.4,
                resize: 'none', boxSizing: 'border-box', fontFamily: 'inherit',
                minHeight: '2.6em', maxHeight: 120, overflow: 'hidden', outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => agentChatSend(agentChatInput)}
              style={{
                flexShrink: 0, padding: '10px 20px', borderRadius: 10,
                border: 'none', background: '#3B82F6', color: '#FFFFFF',
                cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                boxShadow: '0 1px 3px rgba(59,130,246,.3)',
              }}
            >Send</button>
          </div>
        </div>
      )}

    </div>
  );
}
