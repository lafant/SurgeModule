/*
 * BiliBili Daily Fast CDN for Surge
 *
 * Two entry modes share this file:
 *   mode=playurl  Reorder Bilibili JSON PlayURL base/backup URLs safely.
 *   mode=media    Experimental fallback that rewrites an eligible media URL.
 *
 * The script intentionally uses ES5-style syntax for broad JavaScriptCore
 * compatibility in Surge.
 */
(function () {
  "use strict";

  var STORE_KEY = "bili.daily-fast-cdn.v1";
  var LOCK_KEY = STORE_KEY + ".lock";
  var NETWORK_EPOCH_KEY = STORE_KEY + ".network";
  var DEFAULT_HOSTS = [
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com"
  ];
  var completed = false;
  var args = parseArguments(typeof $argument === "string" ? $argument : "");
  var config = {
    mode: args.mode || "playurl",
    sampleBytes: positiveInteger(args.sample_bytes, 524288, 65536, 2097152),
    httpTimeout: positiveNumber(args.http_timeout, 4, 1, 10),
    maxCandidates: positiveInteger(args.max_candidates, 4, 2, 6),
    fallbackHosts: parseHosts(args.fallback_hosts),
    policy: normalizePolicy(args.policy),
    notify: String(args.notify || "false").toLowerCase() === "true",
    lockMilliseconds: 30000
  };

  if (config.mode === "playurl" && typeof $response !== "undefined" && $response) {
    handlePlayUrlResponse();
    return;
  }

  if (config.mode === "media" && typeof $request !== "undefined" && $request) {
    handleMediaRequest();
    return;
  }

  if (config.mode === "network-changed") {
    handleNetworkChanged();
    return;
  }

  finish({});

  function handleNetworkChanged() {
    var previousEpoch = currentNetworkEpoch();
    if (writeStoredJson(NETWORK_EPOCH_KEY, {
      epoch: createToken("network"),
      changedAt: Date.now()
    })) {
      clearStoredValue(dailyStateKey(previousEpoch));
      clearStoredValue(lockKey(previousEpoch));
    }
    finish({});
  }

  function handlePlayUrlResponse() {
    if (typeof $response.body !== "string") {
      finish({});
      return;
    }

    var payload;
    try {
      payload = JSON.parse($response.body);
    } catch (error) {
      finish({});
      return;
    }

    var entries = [];
    collectPlayUrlEntries(payload, entries);
    if (!entries.length) {
      finish({});
      return;
    }

    var day = localDay();
    var networkEpoch = currentNetworkEpoch();
    var state = readDailyState(day, networkEpoch);
    if (state && state.host) {
      var changedFromCache = prioritizeEntries(entries, state.host);
      finish(changedFromCache ? { body: JSON.stringify(payload) } : {});
      return;
    }

    if (state && state.status) {
      finish({});
      return;
    }

    var lock = acquireLock(day, "playurl", networkEpoch);
    if (!lock) {
      finish({});
      return;
    }

    var candidates = findPlayUrlCandidates(entries);
    if (candidates.length < 2) {
      commitDailyState({ day: day, status: "no-candidates", mode: "playurl", updatedAt: Date.now() }, networkEpoch, lock);
      finish({});
      return;
    }

    benchmark(candidates, requestHeaders(), function (results) {
      if (!canCommit(networkEpoch, lock)) {
        finish({});
        return;
      }

      var winner = selectWinner(results);
      if (!winner) {
        commitDailyState({ day: day, status: "no-winner", mode: "playurl", updatedAt: Date.now() }, networkEpoch, lock);
        finish({});
        return;
      }

      var winnerInfo = parseUrl(winner.url);
      if (!winnerInfo) {
        commitDailyState({ day: day, status: "invalid-winner", mode: "playurl", updatedAt: Date.now() }, networkEpoch, lock);
        finish({});
        return;
      }

      if (!commitDailyState({
        day: day,
        host: winnerInfo.host,
        rateBps: Math.round(winner.rateBps),
        bytes: winner.bytes,
        elapsedMs: winner.elapsedMs,
        mode: "playurl",
        updatedAt: Date.now()
      }, networkEpoch, lock)) {
        finish({});
        return;
      }
      postNotification(winnerInfo.host, winner.rateBps, "PlayURL");

      var changed = prioritizeEntries(entries, winnerInfo.host);
      finish(changed ? { body: JSON.stringify(payload) } : {});
    });
  }

  function handleMediaRequest() {
    if (getHeader(requestHeaders(), "x-bili-cdn-bench")) {
      finish({});
      return;
    }

    var originalUrl = $request.url;
    if (!isEligibleMediaUrl(originalUrl)) {
      finish({});
      return;
    }

    var day = localDay();
    var networkEpoch = currentNetworkEpoch();
    var state = readDailyState(day, networkEpoch);
    if (state && state.host) {
      rewriteMediaRequest(state.host);
      return;
    }

    if (state && state.status) {
      finish({});
      return;
    }

    var lock = acquireLock(day, "media", networkEpoch);
    if (!lock) {
      finish({});
      return;
    }

    var candidates = buildMediaCandidates(originalUrl);
    if (candidates.length < 2) {
      commitDailyState({ day: day, status: "no-candidates", mode: "media", updatedAt: Date.now() }, networkEpoch, lock);
      finish({});
      return;
    }

    benchmark(candidates, requestHeaders(), function (results) {
      if (!canCommit(networkEpoch, lock)) {
        finish({});
        return;
      }

      var winner = selectWinner(results);
      if (!winner) {
        commitDailyState({ day: day, status: "no-winner", mode: "media", updatedAt: Date.now() }, networkEpoch, lock);
        finish({});
        return;
      }

      var winnerInfo = parseUrl(winner.url);
      if (!winnerInfo) {
        commitDailyState({ day: day, status: "invalid-winner", mode: "media", updatedAt: Date.now() }, networkEpoch, lock);
        finish({});
        return;
      }

      if (!commitDailyState({
        day: day,
        host: winnerInfo.host,
        rateBps: Math.round(winner.rateBps),
        bytes: winner.bytes,
        elapsedMs: winner.elapsedMs,
        mode: "media",
        updatedAt: Date.now()
      }, networkEpoch, lock)) {
        finish({});
        return;
      }
      postNotification(winnerInfo.host, winner.rateBps, "Media fallback");
      rewriteMediaRequest(winnerInfo.host);
    });
  }

  function benchmark(urls, sourceHeaders, callback) {
    var candidateUrls = urls.slice(0, config.maxCandidates);
    var results = [];
    var remaining = candidateUrls.length;
    var closed = false;
    var watchdog;

    if (typeof setTimeout === "function") {
      watchdog = setTimeout(function () {
        close();
      }, Math.ceil((config.httpTimeout + 1) * 1000));
    }

    for (var index = 0; index < candidateUrls.length; index += 1) {
      runCandidate(candidateUrls[index]);
    }

    function runCandidate(url) {
      var startedAt = Date.now();
      var options = {
        url: url,
        headers: benchmarkHeaders(sourceHeaders),
        timeout: config.httpTimeout,
        "auto-redirect": false,
        "auto-cookie": false
      };
      if (config.policy) {
        options.policy = config.policy;
      }

      try {
        $httpClient.get(options, function (error, response, data) {
          if (closed) {
            return;
          }
          var elapsedMs = Math.max(1, Date.now() - startedAt);
          var rangeInfo = contentRangeInfo(response);
          var bytes = responseBytes(response, data);
          var status = response && Number(response.status);
          var ok = !error && status === 206 && rangeInfo && rangeInfo.start === 0 &&
            rangeInfo.end < config.sampleBytes && bytes >= Math.min(config.sampleBytes, 65536);
          results.push({
            url: url,
            ok: ok,
            bytes: bytes,
            elapsedMs: elapsedMs,
            rateBps: ok ? (bytes * 1000) / elapsedMs : 0,
            status: status || 0,
            error: error ? String(error) : ""
          });
          remaining -= 1;
          if (remaining === 0) {
            close();
          }
        });
      } catch (error) {
        results.push({ url: url, ok: false, bytes: 0, elapsedMs: 0, rateBps: 0, status: 0, error: String(error) });
        remaining -= 1;
        if (remaining === 0) {
          close();
        }
      }
    }

    function close() {
      if (closed) {
        return;
      }
      closed = true;
      if (watchdog && typeof clearTimeout === "function") {
        clearTimeout(watchdog);
      }
      callback(results);
    }
  }

  function findPlayUrlCandidates(entries) {
    for (var index = 0; index < entries.length; index += 1) {
      var urls = entryUrls(entries[index]);
      if (urls.length >= 2) {
        return uniqueStrings(urls).slice(0, config.maxCandidates);
      }
    }
    return [];
  }

  function buildMediaCandidates(originalUrl) {
    var candidates = [originalUrl];
    for (var index = 0; index < config.fallbackHosts.length; index += 1) {
      var replacement = replaceHost(originalUrl, config.fallbackHosts[index]);
      if (replacement) {
        candidates.push(replacement);
      }
    }
    return uniqueStrings(candidates).slice(0, config.maxCandidates);
  }

  function selectWinner(results) {
    var winner = null;
    for (var index = 0; index < results.length; index += 1) {
      var result = results[index];
      if (!result.ok) {
        continue;
      }
      if (!winner || result.rateBps > winner.rateBps ||
          (result.rateBps === winner.rateBps && result.elapsedMs < winner.elapsedMs)) {
        winner = result;
      }
    }
    return winner;
  }

  function collectPlayUrlEntries(value, entries) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (isArray(value)) {
      for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex += 1) {
        collectPlayUrlEntries(value[arrayIndex], entries);
      }
      return;
    }

    var baseKey = typeof value.base_url === "string" ? "base_url" :
      (typeof value.baseUrl === "string" ? "baseUrl" : null);
    var backupKey = isArray(value.backup_url) ? "backup_url" :
      (isArray(value.backupUrl) ? "backupUrl" : null);

    if (baseKey && backupKey && isEligibleMediaUrl(value[baseKey])) {
      entries.push({ object: value, baseKey: baseKey, backupKey: backupKey });
    }

    var keys = Object.keys(value);
    for (var objectIndex = 0; objectIndex < keys.length; objectIndex += 1) {
      collectPlayUrlEntries(value[keys[objectIndex]], entries);
    }
  }

  function prioritizeEntries(entries, winnerHost) {
    var changed = false;
    var normalizedWinner = String(winnerHost || "").toLowerCase();
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      var urls = entryUrls(entry);
      var selected = null;

      for (var urlIndex = 0; urlIndex < urls.length; urlIndex += 1) {
        var info = parseUrl(urls[urlIndex]);
        if (info && info.host === normalizedWinner) {
          selected = urls[urlIndex];
          break;
        }
      }

      if (!selected || entry.object[entry.baseKey] === selected) {
        continue;
      }

      var rest = [];
      for (var candidateIndex = 0; candidateIndex < urls.length; candidateIndex += 1) {
        if (urls[candidateIndex] !== selected && rest.indexOf(urls[candidateIndex]) === -1) {
          rest.push(urls[candidateIndex]);
        }
      }
      entry.object[entry.baseKey] = selected;
      entry.object[entry.backupKey] = rest;
      changed = true;
    }
    return changed;
  }

  function entryUrls(entry) {
    var urls = [];
    if (typeof entry.object[entry.baseKey] === "string") {
      urls.push(entry.object[entry.baseKey]);
    }
    var backups = entry.object[entry.backupKey];
    for (var index = 0; index < backups.length; index += 1) {
      if (typeof backups[index] === "string" && isEligibleMediaUrl(backups[index])) {
        urls.push(backups[index]);
      }
    }
    return urls;
  }

  function rewriteMediaRequest(targetHost) {
    var sourceInfo = parseUrl($request.url);
    if (!sourceInfo || !isSafeCdnHost(targetHost) || sourceInfo.host === String(targetHost).toLowerCase()) {
      finish({});
      return;
    }

    var rewrittenUrl = replaceHost($request.url, targetHost);
    if (!rewrittenUrl) {
      finish({});
      return;
    }

    var authority = String(targetHost).toLowerCase() + (sourceInfo.port ? ":" + sourceInfo.port : "");
    finish({
      url: rewrittenUrl,
      headers: rewriteRoutingHeaders(requestHeaders(), authority)
    });
  }

  function replaceHost(url, targetHost) {
    var info = parseUrl(url);
    if (!info || !isSafeCdnHost(targetHost)) {
      return null;
    }
    if (info.port && info.port !== "80" && info.port !== "443") {
      return null;
    }
    return info.scheme + "://" + String(targetHost).toLowerCase() +
      (info.port ? ":" + info.port : "") + info.suffix;
  }

  function isEligibleMediaUrl(url) {
    var info = parseUrl(url);
    if (!info || !isSafeCdnHost(info.host)) {
      return false;
    }
    return /\/(?:upgcxcode|ugc|v1\/resource|live-bvc|live-play|video|bos|bfs)\//i.test(info.suffix) ||
      /\.(?:m4s|flv|mp4|ts|m3u8)(?:\?|$)/i.test(info.suffix);
  }

  function isSafeCdnHost(host) {
    var normalized = String(host || "").toLowerCase();
    return /^(?:[a-z0-9-]+\.)*bilivideo\.(?:com|cn)$/.test(normalized) ||
      normalized === "upos-hz-mirrorakam.akamaized.net";
  }

  function parseUrl(url) {
    var match = String(url || "").match(/^(https?):\/\/([^\/?#]+)([\/?#].*)?$/i);
    if (!match) {
      return null;
    }

    var authority = match[2];
    if (authority.indexOf("@") !== -1 || authority.charAt(0) === "[") {
      return null;
    }
    var host = authority;
    var port = "";
    var colon = authority.lastIndexOf(":");
    if (colon > 0 && authority.indexOf(":") === colon) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
    if (!host) {
      return null;
    }
    return {
      scheme: match[1].toLowerCase(),
      host: host.toLowerCase(),
      port: port,
      suffix: match[3] || "/"
    };
  }

  function benchmarkHeaders(sourceHeaders) {
    var headers = {};
    copyHeader(sourceHeaders, headers, "user-agent", "User-Agent");
    copyHeader(sourceHeaders, headers, "referer", "Referer");
    copyHeader(sourceHeaders, headers, "origin", "Origin");
    copyHeader(sourceHeaders, headers, "accept", "Accept");
    headers.Range = "bytes=0-" + (config.sampleBytes - 1);
    headers["Accept-Encoding"] = "identity";
    headers["X-Bili-CDN-Bench"] = "1";
    return headers;
  }

  function copyHeader(from, to, wantedName, outputName) {
    var value = getHeader(from, wantedName);
    if (value) {
      to[outputName] = value;
    }
  }

  function contentRangeInfo(response) {
    var contentRange = getHeader(response && response.headers, "content-range");
    var rangeMatch = contentRange && String(contentRange).match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (!rangeMatch) {
      return null;
    }
    return { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) };
  }

  function responseBytes(response, data) {
    var rangeInfo = contentRangeInfo(response);
    if (rangeInfo) {
      return rangeInfo.end - rangeInfo.start + 1;
    }

    var contentLength = getHeader(response && response.headers, "content-length");
    if (contentLength && /^\d+$/.test(String(contentLength))) {
      return Number(contentLength);
    }
    if (data && typeof data.byteLength === "number") {
      return data.byteLength;
    }
    if (typeof data === "string") {
      return data.length;
    }
    return 0;
  }

  function requestHeaders() {
    return (typeof $request !== "undefined" && $request && $request.headers) ? $request.headers : {};
  }

  function rewriteRoutingHeaders(sourceHeaders, authority) {
    var headers = {};
    var keys = Object.keys(sourceHeaders || {});
    var found = false;
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      var normalized = String(key).toLowerCase();
      if (normalized === "host" || normalized === ":authority") {
        headers[key] = authority;
        found = true;
      } else {
        headers[key] = sourceHeaders[key];
      }
    }
    if (!found) {
      headers.Host = authority;
    }
    return headers;
  }

  function getHeader(headers, wantedName) {
    if (!headers) {
      return null;
    }
    var wanted = String(wantedName).toLowerCase();
    var keys = Object.keys(headers);
    for (var index = 0; index < keys.length; index += 1) {
      if (String(keys[index]).toLowerCase() === wanted) {
        return headers[keys[index]];
      }
    }
    return null;
  }

  function readDailyState(day, networkEpoch) {
    var state = readStoredJson(dailyStateKey(networkEpoch));
    return state && state.day === day && state.networkEpoch === networkEpoch ? state : null;
  }

  function writeDailyState(state, networkEpoch) {
    return writeStoredJson(dailyStateKey(networkEpoch), state);
  }

  function commitDailyState(state, networkEpoch, lock) {
    if (!canCommit(networkEpoch, lock)) {
      return false;
    }
    state.networkEpoch = networkEpoch;
    state.ownerToken = lock.ownerToken;
    if (!writeDailyState(state, networkEpoch)) {
      return false;
    }
    return canCommit(networkEpoch, lock);
  }

  function dailyStateKey(networkEpoch) {
    return STORE_KEY + ".state." + networkEpoch;
  }

  function lockKey(networkEpoch) {
    return STORE_KEY + ".lock." + networkEpoch;
  }

  function currentNetworkEpoch() {
    var network = readStoredJson(NETWORK_EPOCH_KEY);
    return network && typeof network.epoch === "string" && network.epoch ? network.epoch : "initial";
  }

  function canCommit(networkEpoch, lock) {
    return currentNetworkEpoch() === networkEpoch && ownsLock(lock);
  }

  function acquireLock(day, mode, networkEpoch) {
    if (currentNetworkEpoch() !== networkEpoch) {
      return null;
    }
    var key = lockKey(networkEpoch);
    var lock = readStoredJson(key);
    var now = Date.now();
    if (lock && lock.day === day && typeof lock.startedAt === "number" && now - lock.startedAt < config.lockMilliseconds) {
      return null;
    }
    var nextLock = {
      day: day,
      mode: mode,
      networkEpoch: networkEpoch,
      ownerToken: createToken("lock"),
      startedAt: now
    };
    if (!writeStoredJson(key, nextLock)) {
      return null;
    }
    return currentNetworkEpoch() === networkEpoch && ownsLock(nextLock) ? nextLock : null;
  }

  function ownsLock(lock) {
    if (!lock || !lock.ownerToken) {
      return false;
    }
    var current = readStoredJson(lockKey(lock.networkEpoch));
    return !!current && current.day === lock.day && current.ownerToken === lock.ownerToken;
  }

  function createToken(prefix) {
    return prefix + "-" + Date.now() + "-" + String(Math.random()).slice(2);
  }

  function writeStoredJson(key, value) {
    if (typeof $persistentStore !== "undefined" && $persistentStore && typeof $persistentStore.write === "function") {
      return $persistentStore.write(JSON.stringify(value), key) !== false;
    }
    return false;
  }

  function clearStoredValue(key) {
    if (typeof $persistentStore !== "undefined" && $persistentStore && typeof $persistentStore.write === "function") {
      $persistentStore.write("", key);
    }
  }

  function readStoredJson(key) {
    if (typeof $persistentStore === "undefined" || !$persistentStore || typeof $persistentStore.read !== "function") {
      return null;
    }
    var raw = $persistentStore.read(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  function postNotification(host, rateBps, mode) {
    if (!config.notify || typeof $notification === "undefined" || !$notification || typeof $notification.post !== "function") {
      return;
    }
    var mib = (rateBps / 1048576).toFixed(2);
    $notification.post("Bilibili CDN selected", mode, host + " · " + mib + " MiB/s");
  }

  function localDay() {
    var date = new Date();
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function parseArguments(raw) {
    var result = {};
    var parts = String(raw || "").split("&");
    for (var index = 0; index < parts.length; index += 1) {
      if (!parts[index]) {
        continue;
      }
      var separator = parts[index].indexOf("=");
      var key = separator === -1 ? parts[index] : parts[index].slice(0, separator);
      var value = separator === -1 ? "" : parts[index].slice(separator + 1);
      try {
        result[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
      } catch (error) {
        result[key] = value;
      }
    }
    return result;
  }

  function parseHosts(value) {
    var rawHosts = value ? String(value).split(/[|,]/) : DEFAULT_HOSTS;
    var hosts = [];
    for (var index = 0; index < rawHosts.length; index += 1) {
      var host = String(rawHosts[index] || "").trim().toLowerCase();
      if (isSafeCdnHost(host) && hosts.indexOf(host) === -1) {
        hosts.push(host);
      }
    }
    return hosts.length ? hosts : DEFAULT_HOSTS.slice();
  }

  function positiveInteger(value, fallback, minimum, maximum) {
    var number = Number(value);
    if (!isFinite(number) || number % 1 !== 0 || number < minimum || number > maximum) {
      return fallback;
    }
    return number;
  }

  function positiveNumber(value, fallback, minimum, maximum) {
    var number = Number(value);
    if (!isFinite(number) || number < minimum || number > maximum) {
      return fallback;
    }
    return number;
  }

  function normalizePolicy(value) {
    var policy = String(value || "").trim();
    return policy === "__PROFILE_RULES__" ? "" : policy;
  }

  function uniqueStrings(values) {
    var unique = [];
    for (var index = 0; index < values.length; index += 1) {
      if (typeof values[index] === "string" && unique.indexOf(values[index]) === -1) {
        unique.push(values[index]);
      }
    }
    return unique;
  }

  function isArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  function finish(value) {
    if (completed) {
      return;
    }
    completed = true;
    if (typeof $done === "function") {
      $done(value || {});
    }
  }
}());
