// Training Wire — shared wire sync
//
// Until now every terminal kept its releases and snaps in its own browser
// memory, so a trainer could inject a release and nobody else saw it. This is
// the layer that makes the wire shared: one set of releases and one publish
// history on the server, every terminal rendering the same thing.
//
// WHAT LIVES WHERE, NOW:
//   shared, on the server   releases, published alerts, the wrong-snap flag
//   local, per browser      corrections, withdrawals, headline activity, the
//                           coverage flag, embargo bundles, UI preferences
//
// The local half is not a design choice — those endpoints do not exist yet.
// Each one is marked LOCAL ONLY where it is used so it is obvious what has and
// has not been shared.
//
// WHY AUTO-SNAP ONLY RUNS IN ONE BROWSER: the engine runs client-side. If every
// trainee's terminal snapped each arriving release, the same alert would be
// published once per person. So only the terminal that injected a release
// snaps it, and publishes through the API; everyone else receives those alerts
// as ordinary publish events.
console.log('Training Wire: Wire sync loaded');

const WireSync = (() => {
  'use strict';

  let onReleases = null;     // (releases[]) => void      full snapshot
  let onRelease = null;      // (release)    => void      one new arrival
  let onPublish = null;      // (entry)      => void
  let onFlag = null;         // ({chain,rowKey,wrong,flaggedBy}) => void
  let onClear = null;        // ()           => void
  let onStatus = null;       // ('connecting'|'live'|'offline'|'error') => void

  let started = false;

  // ── snapshot ────────────────────────────────────────────────────────────
  async function loadState() {
    const s = await WireClient.getState();
    return { releases: s.releases || [], history: s.history || {} };
  }

  // ── realtime ────────────────────────────────────────────────────────────
  // A release event carries only metadata — the body would be far too big to
  // broadcast — so the body is pulled per release on arrival.
  async function hydrate(meta) {
    try {
      const full = await WireClient.getRelease(meta.id);
      return Object.assign({}, meta, full && full.release ? full.release : full);
    } catch (e) {
      // Still show it: a headline with no body beats a release nobody sees.
      console.warn('could not fetch release body for ' + meta.id + ': ' + (e && e.message));
      return Object.assign({ bodyHtml: '', bodyText: '' }, meta);
    }
  }

  function start(handlers) {
    onReleases = handlers.onReleases; onRelease = handlers.onRelease;
    onPublish = handlers.onPublish;   onFlag = handlers.onFlag;
    onClear = handlers.onClear;       onStatus = handlers.onStatus;

    if (started) return;
    started = true;

    WireRealtime
      .on('release', async (p) => { onRelease?.(await hydrate(p)); })
      .on('publish', (p) => onPublish?.(p))
      .on('flag', (p) => onFlag?.(p))
      .on('clear', () => onClear?.())
      .onStatus((s) => onStatus?.(s))
      // Fired after a reconnect: anything broadcast while the socket was down
      // was missed, so the whole snapshot is pulled again rather than guessed.
      .onResync(async () => {
        try { const s = await loadState(); onReleases?.(s.releases, s.history); }
        catch (e) { console.warn('resync failed: ' + (e && e.message)); }
      });

    WireRealtime.start().catch((e) => {
      console.warn('realtime unavailable: ' + (e && e.message));
      onStatus?.('offline');
    });
  }

  function stop() {
    started = false;
    try { WireRealtime.stop(); } catch (e) {}
  }

  // ── writes ──────────────────────────────────────────────────────────────
  // Each returns the server's answer, and the caller applies that answer
  // locally straight away rather than waiting for the broadcast to come back.
  //
  // Waiting looked tidier — one code path for everyone — but it means that
  // whenever realtime is down the person who just published sees nothing
  // happen, which reads as the tool being broken. Applying the server's own
  // returned row is safe because the echo is de-duplicated by rowKey.
  const inject = (items) => WireClient.injectReleases(items);
  const publish = (chain, alert, releaseId, auto) => WireClient.publishAlert(chain, alert, releaseId, !!auto);
  const flag = (chain, rowKey, wrong) => WireClient.flagAlert(chain, rowKey, wrong);
  const clearWire = () => WireClient.clearWire();

  return { loadState, start, stop, inject, publish, flag, clearWire };
})();

if (typeof window !== 'undefined') window.WireSync = WireSync;
