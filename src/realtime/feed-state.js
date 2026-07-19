'use strict';

const {
  decodeImResponse,
  normalizeSnapshot,
  normalizeEvent,
  normalizeMarkets,
} = require('./im-protocol');

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 999;
}

function eventMap(events) {
  return new Map(events.map((event) => [event.event_id, event]));
}

function selectionEntries(events) {
  const entries = [];
  for (const event of events) {
    for (const market of event.markets) {
      for (const selection of market.selections) {
        entries.push({ eventId: event.event_id, selection });
      }
    }
  }
  return entries;
}

function sameSelection(left, right) {
  return left.available === right.available
    && (left.decimal_odds ?? null) === (right.decimal_odds ?? null)
    && (left.line ?? null) === (right.line ?? null);
}

function marketId(rawMarket) {
  if (typeof rawMarket?.mi === 'number' && Number.isSafeInteger(rawMarket.mi)) {
    return String(rawMarket.mi);
  }
  if (typeof rawMarket?.mi === 'string' && /^\d{1,32}$/.test(rawMarket.mi)) {
    return rawMarket.mi;
  }
  return null;
}

function createFeedState({ now = Date.now, staleMs = 15_000 } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(staleMs) || staleMs <= 0) {
    throw new TypeError('staleMs must be a positive integer');
  }

  let rawEvents = new Map();
  let ignoredEventIds = new Set();
  let events = [];
  let ready = false;
  let resyncRequired = false;
  let lastValidAt = 0;
  let sequence = 0;
  const listeners = new Set();

  function notify(messages) {
    for (const message of messages) {
      for (const listener of [...listeners]) {
        try { listener(message); } catch { /* isolated */ }
      }
    }
  }

  function nextSequence() {
    sequence += 1;
    return sequence;
  }

  function deltaMessage(eventId, selection, available = selection.available) {
    return {
      type: 'delta',
      event_id: eventId,
      selection_key: selection.selection_key,
      decimal_odds: available ? (selection.decimal_odds ?? null) : null,
      line: selection.line ?? null,
      available,
      seq: nextSequence(),
    };
  }

  function scoreMessage(event) {
    return {
      type: 'score',
      event_id: event.event_id,
      score: `${event.score.home}-${event.score.away}`,
      clock: event.clock,
      seq: nextSequence(),
    };
  }

  function diff(previousEvents, nextEvents) {
    const messages = [];
    const oldSelections = new Map(selectionEntries(previousEvents).map(
      (entry) => [entry.selection.selection_key, entry],
    ));
    for (const entry of selectionEntries(nextEvents)) {
      const old = oldSelections.get(entry.selection.selection_key);
      if (!old || !sameSelection(old.selection, entry.selection)) {
        messages.push(deltaMessage(entry.eventId, entry.selection));
      }
      oldSelections.delete(entry.selection.selection_key);
    }
    for (const { eventId, selection } of oldSelections.values()) {
      messages.push(deltaMessage(eventId, selection, false));
    }

    const previousById = eventMap(previousEvents);
    for (const event of nextEvents) {
      const old = previousById.get(event.event_id);
      if (old && (old.score.home !== event.score.home
        || old.score.away !== event.score.away
        || old.clock !== event.clock)) {
        messages.push(scoreMessage(event));
      }
    }
    return messages;
  }

  function resyncResult() {
    resyncRequired = true;
    return { messages: [], needsResync: true };
  }

  function ingestSnapshot(value) {
    const normalized = normalizeSnapshot(value);
    const candidateRaw = new Map();
    for (const [eventId, rawEvent] of normalized.upstream.events) {
      candidateRaw.set(eventId, clone(rawEvent));
    }
    const candidateIgnored = new Set(normalized.upstream.ignoredEventIds);
    const candidateEvents = clone(normalized.events);
    const messages = ready ? diff(events, candidateEvents) : [];
    if (!ready) nextSequence();
    rawEvents = candidateRaw;
    ignoredEventIds = candidateIgnored;
    events = candidateEvents;
    ready = true;
    resyncRequired = false;
    lastValidAt = now();
    notify(messages);
    return { messages, needsResync: false };
  }

  function applyMarketUpdate(rawEvent, entry, partial) {
    if (!Array.isArray(entry.v)) throw new Error('schema');
    normalizeMarkets(entry.v, entry.eid);
    if (!partial) {
      rawEvent.mls = clone(entry.v);
      return;
    }

    const replacements = new Map();
    for (const market of entry.v) {
      const key = marketId(market);
      if (!key || replacements.has(key)) throw new Error('schema');
      replacements.set(key, clone(market));
    }
    const merged = [];
    for (const market of rawEvent.mls) {
      const key = marketId(market);
      if (!key) throw new Error('schema');
      merged.push(replacements.has(key) ? replacements.get(key) : market);
      replacements.delete(key);
    }
    merged.push(...replacements.values());
    rawEvent.mls = merged;
  }

  function applyScore(rawEvent, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !validCounter(value.hs) || !validCounter(value.as)
      || !validCounter(value.hrc) || !validCounter(value.arc)) {
      throw new Error('schema');
    }
    rawEvent.hs = value.hs;
    rawEvent.as = value.as;
  }

  function applyClock(rawEvent, value) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 100) {
      throw new Error('schema');
    }
    rawEvent.rbt = value.trim();
  }

  function applyPeriodScores(rawEvent, value) {
    if (!Array.isArray(value) || value.length > 100) throw new Error('schema');
    for (const period of value) {
      if (!period || typeof period !== 'object' || Array.isArray(period)
        || !validCounter(period.st) || !validCounter(period.gp)
        || !validCounter(period.hs) || !validCounter(period.as)) {
        throw new Error('schema');
      }
    }
    rawEvent._periodScores = clone(value);
  }

  function ingestDelta(value) {
    if (!ready || resyncRequired || !Array.isArray(value.dc) || value.dc.length > 10_000) {
      return resyncResult();
    }
    const candidateRaw = new Map([...rawEvents].map(
      ([eventId, rawEvent]) => [eventId, clone(rawEvent)],
    ));

    try {
      for (const entry of value.dc) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || !Number.isSafeInteger(entry.a)
          || !Number.isSafeInteger(entry.sid)) {
          throw new Error('schema');
        }
        const eventId = typeof entry.eid === 'number' && Number.isSafeInteger(entry.eid)
          ? String(entry.eid)
          : entry.eid;
        if (ignoredEventIds.has(eventId)) continue;
        const rawEvent = candidateRaw.get(eventId);
        if (!rawEvent) throw new Error('schema');

        if (entry.a === 3) applyMarketUpdate(rawEvent, entry, false);
        else if (entry.a === 4) applyMarketUpdate(rawEvent, entry, true);
        else if (entry.a === 5) applyScore(rawEvent, entry.v);
        else if (entry.a === 6) applyClock(rawEvent, entry.v);
        else if (entry.a === 11) applyPeriodScores(rawEvent, entry.v);
        else throw new Error('unsupported');
      }

      const candidateEvents = [...candidateRaw.values()].map(normalizeEvent);
      const messages = diff(events, candidateEvents);
      rawEvents = candidateRaw;
      events = candidateEvents;
      lastValidAt = now();
      notify(messages);
      return { messages, needsResync: false };
    } catch {
      return resyncResult();
    }
  }

  function ingest(input) {
    let decoded;
    try {
      decoded = input?.type && input?.value
        ? input
        : decodeImResponse(input);
      if (decoded.type === 'snapshot') return ingestSnapshot(decoded.value);
      if (decoded.type === 'delta') return ingestDelta(decoded.value);
      return resyncResult();
    } catch {
      return resyncResult();
    }
  }

  function snapshot() {
    if (!ready) return null;
    return deepFreeze(clone({ type: 'snapshot', events, seq: sequence }));
  }

  function isStale() {
    return !ready || resyncRequired || now() - lastValidAt > staleMs;
  }

  function invalidate() {
    ready = false;
    resyncRequired = true;
    rawEvents = new Map();
    ignoredEventIds = new Set();
    events = [];
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  }

  return Object.freeze({
    ingest,
    snapshot,
    isStale,
    invalidate,
    subscribe,
    nextSequence,
  });
}

module.exports = { createFeedState };
