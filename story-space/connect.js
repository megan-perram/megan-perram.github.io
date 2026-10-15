/*
  The Undiagnosed: connection to the study server.

  The Story Space was first built inside Claude, where "window.claude" gave it
  the AI, saving and downloads. On your website that does not exist, so this
  file provides the same pieces, backed by the study's own server on
  DigitalOcean. The rest of the app does not need to know the difference.

  >>> After Step 4, put the server's web address on the line below. <<<
*/
(function () {
  var API = "https://undiagnosed-server-w2inq.ondigitalocean.app";
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) API = "http://localhost:8080";

  var TOKEN_KEY = "undiagnosed-token", WHO_KEY = "undiagnosed-who",
      STORE = "undiagnosed-story-space-v6";

  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }

  var who = ss(WHO_KEY);
  var signedIn = !!ss(TOKEN_KEY);

  function signOut() {
    ss(TOKEN_KEY, null);
    location.reload();
  }

  function call(method, path, body, opts) {
    opts = opts || {};
    var headers = { "Authorization": "Bearer " + (ss(TOKEN_KEY) || "") };
    if (body !== undefined && !opts.raw) headers["Content-Type"] = "application/json";
    return fetch(API + path, {
      method: method, headers: headers, keepalive: !!opts.keepalive,
      body: body === undefined ? undefined : (opts.raw ? body : JSON.stringify(body))
    }).then(function (r) {
      if (r.status === 401 && path !== "/api/login") { signOut(); throw { code: "signed_out", text: "Please sign in again." }; }
      return r;
    });
  }
  function json(r) {
    return r.json().then(function (v) {
      if (!r.ok) throw { code: (v && v.code) || "server", text: (v && (v.text || v.error)) || "That did not come through." };
      return v;
    });
  }

  /* ---------- sign in ---------- */
  function login(id, password) {
    return fetch(API + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, password: password })
    }).then(function (r) {
      return r.json().then(function (v) {
        if (!r.ok || !v.token) throw new Error((v && v.error) || "Those details are not right. Please try again.");
        /* a different person on this device: clear the last person's writing from it */
        if (ls(WHO_KEY) !== v.id) ls(STORE, null);
        ls(WHO_KEY, v.id);
        ss(TOKEN_KEY, v.token); ss(WHO_KEY, v.id);
        return v.id;
      });
    }, function () { throw new Error("The study server could not be reached. Check your connection and try again."); });
  }

  /* ---------- the AI ---------- */
  function sample(messages, opts) {
    opts = opts || {};
    return call("POST", "/api/ai", { messages: messages, modelTier: opts.modelTier || "default" }).then(function (r) {
      var type = r.headers.get("content-type") || "";
      if (!r.ok || type.indexOf("ndjson") < 0) return json(r);
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = "", text = "";
      return new Promise(function (resolve, reject) {
        function pump() {
          reader.read().then(function (step) {
            if (step.done) { resolve({ text: text }); return; }
            buf += dec.decode(step.value, { stream: true });
            var lines = buf.split("\n"); buf = lines.pop();
            for (var i = 0; i < lines.length; i++) {
              if (!lines[i]) continue;
              var m; try { m = JSON.parse(lines[i]); } catch (e) { continue; }
              if (m.t === "delta") { text += m.text; if (opts.onText) opts.onText({ text: text }); }
              else if (m.t === "done") { text = m.text || text; }
              else if (m.t === "error") { reject({ code: m.code, text: m.text }); return; }
            }
            pump();
          }, function () { reject({ code: "network", text: "The connection dropped. Try again when you like." }); });
        }
        pump();
      });
    }, function (e) {
      if (e && e.code) throw e;
      throw { code: "network", text: "The writing companion could not be reached. Check your connection and try again." };
    });
  }

  /* ---------- saving (same shape the app already uses) ---------- */
  function snap(id, v) { return { id: id, exists: v != null, data: function () { return v; } }; }
  var db = {
    doc: function (path) {
      if (path === "space/state") return {
        get: function () { return call("GET", "/api/state").then(json).then(function (v) { return snap("state", v); }); },
        set: function (v) { return call("PUT", "/api/state", v).then(json); }
      };
      if (path.indexOf("community/") === 0) return {
        set: function (v) { return call("PUT", "/api/community/me", v).then(json); },
        "delete": function () { return call("DELETE", "/api/community/me").then(json); }
      };
      throw new Error("unknown doc " + path);
    },
    collection: function () {
      var q = {
        orderBy: function () { return q; },
        limit: function () { return q; },
        onSnapshot: function (cb, errcb) {
          var stopped = false, t = null;
          function tick() {
            call("GET", "/api/community").then(json).then(function (v) {
              if (stopped) return;
              cb({ docs: (v.items || []).map(function (it) { var id = it.__id; delete it.__id; return snap(id, it); }) });
            })["catch"](function (e) { if (!stopped && errcb) errcb(e); })
              .then(function () { if (!stopped) t = setTimeout(tick, 30000); });
          }
          tick();
          return function () { stopped = true; clearTimeout(t); };
        }
      };
      return q;
    }
  };

  /* ---------- downloads ---------- */
  var downloads = {
    save: function (o) {
      return new Promise(function (resolve) {
        var blob = new Blob([o.data], { type: "text/plain;charset=utf-8" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = o.filename || "story.txt";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        resolve(true);
      });
    }
  };

  /* ---------- what the app asks for ---------- */
  window.claude = {
    use: function (name) {
      if (!signedIn) return new Promise(function () {}); /* waits behind the sign-in screen */
      if (name === "sample") return Promise.resolve(sample);
      if (name === "db") return Promise.resolve(db);
      if (name === "downloads") return Promise.resolve(downloads);
      if (name === "user") return Promise.resolve({ id: function () { return Promise.resolve(who); } });
      return Promise.resolve(null);
    }
  };

  /* ---------- screen recording of the writing space ----------
     Records what happens inside this page only (typing, edits, the AI's
     replies), using rrweb. No camera, microphone or anything outside the page. */
  var rec = { stop: null, events: [], n: 0, session: null, startedAt: null, timer: null };
  function flush(keepalive) {
    if (!rec.session || !rec.events.length) return Promise.resolve();
    var batch = rec.events; rec.events = [];
    var n = rec.n++;
    return call("POST", "/api/recording?session=" + rec.session + "&n=" + n, JSON.stringify(batch),
      { raw: true, keepalive: keepalive && batch.length < 200 })
      .then(function (r) { if (!r.ok) throw 0; })["catch"](function () {
        /* put them back so the next try sends them */
        if (!keepalive) rec.events = batch.concat(rec.events);
      });
  }
  function currentState() { try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { return null; } }
  window.__undiagnosedRec = {
    start: function () {
      if (!signedIn || rec.stop || !(window.rrweb && window.rrweb.record)) return;
      rec.session = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 7);
      rec.startedAt = new Date().toISOString(); rec.n = 0; rec.events = [];
      rec.stop = window.rrweb.record({
        emit: function (e) { rec.events.push(e); },
        sampling: { mousemove: false, scroll: 300, input: "all" },
        recordCanvas: false, collectFonts: false
      });
      rec.timer = setInterval(function () { flush(false); }, 15000);
    },
    stop: function () {
      if (!rec.stop) return;
      rec.stop(); rec.stop = null; clearInterval(rec.timer);
      var s = rec.session, started = rec.startedAt;
      flush(false).then(function () {
        return call("POST", "/api/session/end", { session: s, startedAt: started, state: currentState() });
      })["catch"](function () {});
    }
  };
  window.addEventListener("pagehide", function () {
    if (rec.stop) {
      flush(true);
      call("POST", "/api/session/end", { session: rec.session, startedAt: rec.startedAt, state: currentState() }, { keepalive: true })["catch"](function () {});
    }
  });

  window.UndiagnosedServer = { login: login, signOut: signOut, signedIn: function () { return signedIn; }, who: function () { return who; }, api: API };
})();
