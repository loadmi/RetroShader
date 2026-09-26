// Service worker: keyboard shortcuts and the toolbar badge. Content scripts react to the storage change on their own.
importScripts('src/settings.js');
const CRT = self.CRT;

// The badge mirrors state.enabled whoever changed it (popup, shortcut). It is derived from storage, not from
// the command handler, and re-applied at startup because Chrome forgets it across browser/extension restarts.
let badgeText = null;
function syncBadge(state, force) {
  if (!chrome.action) return;
  const text = state.enabled ? '' : 'off';
  if (text === badgeText && !force) return;   // slider drags write storage ~20x/s; skip the redundant IPC
  badgeText = text;
  chrome.action.setBadgeText({ text }).catch(() => { badgeText = null; });
}
// Registered synchronously at top level so a storage write (e.g. from the popup) also wakes the worker.
CRT.onStateChanged(syncBadge);

async function handleCommand(command) {
  const state = await CRT.loadState();
  if (command === 'toggle-crt') state.enabled = !state.enabled;
  else if (command === 'toggle-compare') state.compare = !state.compare;
  else if (command === 'next-preset') {
    const ids = CRT.PRESETS.map(p => p.id);
    state.preset = ids[(ids.indexOf(state.preset) + 1) % ids.length];
    state.overrides = {};   // preset tweaks only; state.display (monitor settings) is kept
    state.enabled = true;
  } else return;
  await CRT.saveState(state);
}

// Commands are read-modify-write on storage: run them one at a time so presses dispatched together (e.g. both
// queued while the worker was waking up) each see the previous one's result instead of the same old state.
let commandQueue = Promise.resolve();
if (chrome.commands) {
  chrome.commands.onCommand.addListener((command) => {
    commandQueue = commandQueue.then(() => handleCommand(command)).catch(console.warn);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  // Re-save so older stored state is migrated to the current shape (e.g. display settings out of overrides).
  CRT.loadState().then(async (state) => { await CRT.saveState(state); syncBadge(state, true); }).catch(console.warn);
});
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => { CRT.loadState().then(s => syncBadge(s, true)).catch(console.warn); });
}
