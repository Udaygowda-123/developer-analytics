/*! Pulse analytics snippet — no dependencies, no cookies, no localStorage.
 *
 * Usage:
 *   <script defer src="https://ingest.example.com/pulse.js"
 *           data-key="pk_live_..." data-host="https://ingest.example.com"></script>
 *
 * Exposes window.pulse.track(name, meta) for custom events.
 */
(function (w, d) {
  'use strict';
  if (w.pulse && w.pulse.__loaded) return;

  var script = d.currentScript || (function () {
    var all = d.getElementsByTagName('script');
    return all[all.length - 1];
  })();
  if (!script) return;

  var key = script.getAttribute('data-key');
  if (!key) return;
  var host = (script.getAttribute('data-host') || new URL(script.src).origin).replace(/\/$/, '');
  var endpoint = host + '/collect';
  var queue = [];
  var lastPath = null;

  function payload(type, name, meta) {
    return {
      apiKey: key,
      type: type,
      name: name,
      path: location.pathname + location.search,
      referrer: d.referrer || null,
      screenWidth: w.innerWidth || null,
      meta: meta || undefined,
      timestamp: new Date().toISOString()
    };
  }

  /* sendBeacon first: it is the only transport the browser guarantees to
     complete after the page is discarded, so an event fired on unload actually
     arrives. It cannot set headers, hence the API key in the body. */
  function send(body) {
    var json = JSON.stringify(body);
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([json], { type: 'text/plain' });
        if (navigator.sendBeacon(endpoint, blob)) return;
      }
    } catch (e) { /* fall through */ }

    try {
      if (w.fetch) {
        /* keepalive lets the request outlive the document, same guarantee as
           sendBeacon, for browsers where the beacon call was refused. */
        fetch(endpoint, {
          method: 'POST',
          body: json,
          keepalive: true,
          mode: 'cors',
          headers: { 'Content-Type': 'text/plain' }
        })['catch'](function () {});
        return;
      }
    } catch (e) { /* fall through */ }

    /* Last resort: a GET with the payload base64url-encoded in the query.
       Works where neither beacon nor keepalive fetch exists. */
    try {
      var enc = btoa(unescape(encodeURIComponent(json)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      var img = new Image();
      img.src = endpoint + '?d=' + enc;
    } catch (e) { /* give up silently — analytics must never break a page */ }
  }

  function flush() {
    if (!queue.length) return;
    var events = queue.slice();
    queue.length = 0;
    send(events.length === 1 ? events[0] : { apiKey: key, events: events });
  }

  function push(body) {
    queue.push(body);
    /* Coalesce events fired in the same tick into one request. */
    if (queue.length === 1) setTimeout(flush, 0);
    if (queue.length >= 20) flush();
  }

  function pageview() {
    var path = location.pathname + location.search;
    /* The App Router fires history events for hash changes and for
       replaceState calls that do not change the route. Deduplicating on the
       path is what keeps one navigation from counting as three. */
    if (path === lastPath) return;
    lastPath = path;
    push(payload('pageview', path));
  }

  function track(name, meta) {
    if (typeof name !== 'string' || !name) return;
    push(payload('custom', name, meta));
  }

  /* Next.js App Router navigations never reload the document, so there is no
     second `load` event to hook. Patch the history API — the only reliable
     signal that covers router.push, <Link>, and back/forward alike. */
  ['pushState', 'replaceState'].forEach(function (method) {
    var original = history[method];
    if (typeof original !== 'function') return;
    history[method] = function () {
      var result = original.apply(this, arguments);
      /* Defer: the URL is updated synchronously but React has not committed
         the new route yet, and we want the path the user ends up on. */
      setTimeout(pageview, 0);
      return result;
    };
  });
  w.addEventListener('popstate', function () { setTimeout(pageview, 0); });

  /* Flush on the way out. `visibilitychange` fires on mobile backgrounding
     where `unload` and `beforeunload` do not, so it is the primary hook. */
  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'hidden') flush();
  });
  w.addEventListener('pagehide', flush);

  w.pulse = { track: track, pageview: pageview, __loaded: true };

  /* Drain anything queued by an async-loaded snippet before it arrived. */
  if (Array.isArray(w.pulseQueue)) {
    w.pulseQueue.forEach(function (args) { track.apply(null, args); });
  }

  pageview();
})(window, document);
